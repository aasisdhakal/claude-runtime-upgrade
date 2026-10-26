#!/usr/bin/env node
// Apply the SOURCE-CODE fixes the scanner found — the mechanical ones only.
//
//   node fix.mjs <lang> <dir> <from> <to> [--list] [--only a,b] [--apply]
//
// Default is a dry run that prints diffs. Nothing is written without --apply,
// and --apply refuses anywhere guard.mjs would refuse to commit.
//
// Only rules carrying a hand-written `autofix` are applied. Everything else is
// listed as "needs a human" with the reason — a rule that DETECTS with a regex
// cannot always REWRITE with one.
import { walk, readText, resolve, existsSync, rel, join, emit, die } from './lib/io.mjs';
import { runJson } from './lib/sh.mjs';
import { byId } from './adapters/index.mjs';
import { rulesFor, SOURCE_EXT } from './lib/breaking.mjs';
import { stripNonCode, stripComments, keepInterpolatable } from './lib/strip.mjs';
import { unified } from './lib/edits.mjs';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const [langArg, dirArg, from, to] = argv.filter(a => !a.startsWith('--'));
if (!langArg || !dirArg || !to) die('usage: fix.mjs <lang> <dir> <from> <to> [--list] [--only a,b] [--apply]', 2);
const flag = n => { const i = argv.indexOf('--' + n); return i >= 0 ? argv[i + 1] : null; };
const has = n => argv.includes('--' + n);
const A = byId[langArg] || die(`unsupported language: ${langArg}`, 2);
const DIR = resolve(dirArg);
if (!existsSync(DIR)) die(`no such directory: ${DIR}`);
const ONLY = flag('only') ? flag('only').split(',').map(s => s.trim()) : null;

const rules = rulesFor(A.id, from, to).map((r, i) => ({ ...r, id: `${A.id}-${i + 1}` }));
const fixable = rules.filter(r => r.autofix);
const manual = rules.filter(r => !r.autofix);

if (has('list')) {
  emit({
    lang: A.id, from, to,
    automatic: fixable.map(r => ({ id: r.id, what: r.what, fix: r.fix, severity: r.severity })),
    needsAHuman: manual.map(r => ({ id: r.id, what: r.what, fix: r.fix, severity: r.severity,
      why: r.severity === 'behaviour'
        ? 'a behaviour change needs a TEST, not an edit — the code still runs, it just answers differently'
        : 'the rewrite is not mechanical: it needs an argument, an import, or a reshaped call' })),
    choiceIsYours: 'Pass --only <id,id> to apply a subset. Nothing is written without --apply.',
  });
  process.exit(0);
}

const selected = fixable.filter(r => !ONLY || ONLY.includes(r.id));
const ext = SOURCE_EXT[A.id] || die(`no source extensions known for ${A.id}`, 2);
const files = walk(DIR, { match: n => ext.test(n), maxDepth: 12, limit: 20000 });

const changes = [];
let scanned = 0;
for (const f of files) {
  const original = readText(f);
  if (original == null || original.length > 2_000_000) continue;
  scanned++;
  // find offsets in CODE ONLY, then edit the original at those offsets —
  // comments and strings are blanked space-for-character, so offsets align
  const code = stripNonCode(original, A.id);
  const hits = [];
  for (const r of selected) {
    // a rule may need to see inside strings (Go import paths, PHP interpolation)
    const haystack = r.scope === 'dquote' ? keepInterpolatable(original, A.id)
      : r.scope === 'code-strings' ? stripComments(original, A.id)
      : (r.scope === 'any' || r.scope === 'strings') ? original : code;
    const re = new RegExp(r.re.source, r.re.flags.includes('g') ? r.re.flags : r.re.flags + 'g');
    let m;
    while ((m = re.exec(haystack)) !== null) {
      if (m[0].length === 0) { re.lastIndex++; continue; }
      const matched = original.slice(m.index, m.index + m[0].length);
      let replacement;
      try { replacement = r.autofix(matched); } catch { continue; }
      if (replacement == null || replacement === matched) continue;
      hits.push({ start: m.index, end: m.index + m[0].length, replacement, rule: r.id, what: r.what });
    }
  }
  if (!hits.length) continue;
  // right-to-left so earlier offsets stay valid, and drop overlaps
  hits.sort((a, b) => b.start - a.start);
  let out = original, last = Infinity;
  const applied = [];
  for (const h of hits) {
    if (h.end > last) continue;                       // overlapping match: skip
    out = out.slice(0, h.start) + h.replacement + out.slice(h.end);
    last = h.start;
    applied.push(h);
  }
  if (out === original) continue;
  changes.push({
    file: rel(DIR, f), path: f, original, updated: out,
    edits: applied.reverse().map(h => ({ rule: h.rule, what: h.what,
      line: original.slice(0, h.start).split('\n').length,
      before: original.slice(h.start, h.end), after: h.replacement })),
  });
}

let applyResult = null;
if (has('apply') && changes.length) {
  const pre = runJson(process.execPath, [join(HERE, 'guard.mjs'), 'preflight', DIR]);
  if (!pre.data || pre.data.verdict !== 'safe-to-write') {
    emit({ lang: A.id, dir: DIR, refused: true,
           reason: 'guard preflight failed — fix these before writing',
           guard: pre.data?.checks?.filter(c => !c.ok) ?? pre.stderr });
    process.exit(1);
  }
  for (const c of changes) writeFileSync(c.path, c.updated);
  applyResult = { filesWritten: changes.length, edits: changes.reduce((n, c) => n + c.edits.length, 0) };
}

emit({
  lang: A.id, dir: DIR, from: from || null, to,
  mode: has('apply') ? 'apply' : 'dry-run',
  filesScanned: scanned,
  rulesSelected: selected.map(r => r.id),
  rulesNeedingAHuman: manual.length,
  filesChanged: changes.length,
  editCount: changes.reduce((n, c) => n + c.edits.length, 0),
  changes: changes.map(c => ({ file: c.file, edits: c.edits,
    diff: unified(c.file, c.original, c.updated) })),
  applied: applyResult,
  nextSteps: has('apply')
    ? ['run the test suite — these are mechanical, not proven',
       `${manual.length} finding(s) still need a human: node ${join(HERE, 'fix.mjs')} ${A.id} ${DIR} ${from} ${to} --list`,
       `commit via: node ${join(HERE, 'guard.mjs')} commit ${DIR} -m "<msg>" --phase source-fix`]
    : ['review the diffs above',
       '--only <id,id> applies a subset; --list shows every rule and why some need a human',
       're-run with --apply to write (guard preflight must pass first)'],
});
