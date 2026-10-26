#!/usr/bin/env node
// Source-level breaking-change scan. Finds code that the upgrade will break,
// with file:line evidence, BEFORE anything is changed.
// usage: node scan.mjs <lang> <dir> <from> <to> [--max N]
import { walk, walkGaps, readText, resolve, existsSync, rel, emit, die, parseArgv } from './lib/io.mjs';
import { byId } from './adapters/index.mjs';
import { rulesFor, preExistingRules, inheritedCatalogue, SOURCE_EXT } from './lib/breaking.mjs';
import { stripNonCode, stripComments, keepInterpolatable } from './lib/strip.mjs';

const argv = process.argv.slice(2);
// `--max 50` used to leak its value into the positionals, so `scan java <dir> 17
// --max 50` scanned the window 17 -> "50" with no complaint
const A_ = parseArgv(argv, ['max', 'only']);
const [langArg, dirArg, from, to] = A_.positional;
if (!langArg || !dirArg || !to) die('usage: scan.mjs <lang> <dir> <from> <to> [--max N]', 2);
const MAX = A_.flag('max') != null ? Number(A_.flag('max')) : 400;
const A = byId[langArg] || die(`unsupported language: ${langArg}`, 2);
const DIR = resolve(dirArg);
if (!existsSync(DIR)) die(`no such directory: ${DIR}`);

const INCLUDE_EXISTING = argv.includes('--include-existing');
const windowRules = rulesFor(A.id, from, to);
// Bun and Deno execute Node APIs, so Node's removals apply to their source too.
// Those fire against the Node version the project targets, which we do not know
// here, so apply the whole Node catalogue and label it.
const inherit = inheritedCatalogue(A.id);
const inheritedRules = inherit
  ? rulesFor(inherit, null, null).map(r => ({ ...r, inheritedFrom: inherit }))
  : [];
const existingRules = INCLUDE_EXISTING ? preExistingRules(A.id, from) : [];
const rules = [...windowRules, ...inheritedRules,
               ...existingRules.map(r => ({ ...r, preExisting: true }))];
const ext = SOURCE_EXT[A.id];
if (!ext) die(`no source extensions known for ${A.id}`, 2);

const files = walk(DIR, { match: n => ext.test(n), maxDepth: 12, limit: 20000 });
// `truncated` below tracks the FINDINGS cap. This tracks the FILE walk — a
// different cap, silently reached on next.js (19,999 files) and roslyn (19,995
// of 22k), where unscanned files read as files with no findings.
const coverageGaps = walkGaps(files, { what: 'source files' });
const findings = [];
let scanned = 0;

for (const f of files) {
  if (findings.length >= MAX) break;
  const raw = readText(f);
  if (raw == null || raw.length > 2_000_000) continue;
  scanned++;
  // match against code only; keep the original for the evidence line
  const text = stripNonCode(raw, A.id);
  const lines = raw.split('\n');
  for (const r of rules) {
    // fresh regex per file: a /g rule would carry lastIndex between files
    // a rule may need to see inside strings (Go import paths, PHP interpolation)
    const haystack = r.scope === 'dquote' ? keepInterpolatable(raw, A.id)
      : r.scope === 'code-strings' ? stripComments(raw, A.id)
      : (r.scope === 'any' || r.scope === 'strings') ? raw : text;
    const re = new RegExp(r.re.source, r.re.flags.includes('g') ? r.re.flags : r.re.flags + 'g');
    let m;
    while ((m = re.exec(haystack)) !== null && findings.length < MAX) {
      const line = haystack.slice(0, m.index).split('\n').length;
      findings.push({
        file: rel(DIR, f), line,
        severity: r.severity, introducedIn: r.introducedIn,
        preExisting: !!r.preExisting,
        autofixable: !!r.autofix,
        inheritedFrom: r.inheritedFrom || null,
        what: r.what, fix: r.fix,
        evidence: (lines[line - 1] || '').trim().slice(0, 140),
      });
      if (m.index === re.lastIndex) re.lastIndex++;   // zero-width guard
    }
  }
}

const bySeverity = findings.reduce((m, f) => (m[f.severity] = (m[f.severity] || 0) + 1, m), {});
const byFile = {};
for (const f of findings) (byFile[f.file] ??= []).push(f);

emit({
  lang: A.id, dir: DIR, from: from || null, to,
  rulesApplied: rules.length,
  windowRules: windowRules.length,
  preExistingRules: existingRules.length,
  inheritedRules: inheritedRules.length,
  inheritedFrom: inherit,
  preExistingIncluded: INCLUDE_EXISTING,
  filesScanned: scanned,
  coverageGaps: coverageGaps || undefined,
  coverageNote: coverageGaps ? 'some files were never opened — a finding count is a floor, not a total' : undefined,
  findings: findings.length,
  truncated: findings.length >= MAX,
  bySeverity,
  causedByThisUpgrade: findings.filter(f => !f.preExisting).length,
  autofixable: findings.filter(f => f.autofixable && !f.preExisting).length,
  needsAHuman: findings.filter(f => !f.autofixable && !f.preExisting).length,
  preExistingFindings: findings.filter(f => f.preExisting).length,
  severityMeaning: {
    removed: 'will throw or fail to build on the target — must be fixed',
    runtime: 'deprecated and warns loudly, still works — fix before the NEXT major',
    behaviour: 'still runs but can produce a DIFFERENT RESULT — the dangerous class, needs a test not a grep',
  },
  hotspots: Object.entries(byFile).sort((a, b) => b[1].length - a[1].length).slice(0, 10)
    .map(([file, fs]) => ({ file, count: fs.length })),
  details: findings,
  preExistingNote: INCLUDE_EXISTING
    ? 'preExisting findings are NOT caused by this upgrade — the code already lives with them. '
    + 'They are what the NEXT major turns into failures, so fix them while you are in here.'
    : 'pass --include-existing to also report deprecations that predate the current version',
  note: windowRules.length === 0
    ? `No breaking-change rules are recorded for ${A.id} between ${from || '?'} and ${to}. `
    + 'That means "not catalogued here", NOT "nothing breaks" — read the upstream release notes.'
    : null,
});
