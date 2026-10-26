#!/usr/bin/env node
// Source-level breaking-change scan. Finds code that the upgrade will break,
// with file:line evidence, BEFORE anything is changed.
// usage: node scan.mjs <lang> <dir> <from> <to> [--max N]
import { walk, readText, resolve, existsSync, rel, emit, die } from './lib/io.mjs';
import { byId } from './adapters/index.mjs';
import { rulesFor, preExistingRules, SOURCE_EXT } from './lib/breaking.mjs';

const argv = process.argv.slice(2);
const [langArg, dirArg, from, to] = argv.filter(a => !a.startsWith('--'));
if (!langArg || !dirArg || !to) die('usage: scan.mjs <lang> <dir> <from> <to> [--max N]', 2);
const MAXI = argv.indexOf('--max');
const MAX = MAXI >= 0 ? Number(argv[MAXI + 1]) : 400;
const A = byId[langArg] || die(`unsupported language: ${langArg}`, 2);
const DIR = resolve(dirArg);
if (!existsSync(DIR)) die(`no such directory: ${DIR}`);

const INCLUDE_EXISTING = argv.includes('--include-existing');
const windowRules = rulesFor(A.id, from, to);
const existingRules = INCLUDE_EXISTING ? preExistingRules(A.id, from) : [];
const rules = [...windowRules, ...existingRules.map(r => ({ ...r, preExisting: true }))];
const ext = SOURCE_EXT[A.id];
if (!ext) die(`no source extensions known for ${A.id}`, 2);

const files = walk(DIR, { match: n => ext.test(n), maxDepth: 12, limit: 20000 });
const findings = [];
let scanned = 0;

for (const f of files) {
  if (findings.length >= MAX) break;
  const text = readText(f);
  if (text == null || text.length > 2_000_000) continue;
  scanned++;
  const lines = text.split('\n');
  for (const r of rules) {
    // fresh regex per file: a /g rule would carry lastIndex between files
    const re = new RegExp(r.re.source, r.re.flags.includes('g') ? r.re.flags : r.re.flags + 'g');
    let m;
    while ((m = re.exec(text)) !== null && findings.length < MAX) {
      const line = text.slice(0, m.index).split('\n').length;
      findings.push({
        file: rel(DIR, f), line,
        severity: r.severity, introducedIn: r.introducedIn,
        preExisting: !!r.preExisting,
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
  preExistingIncluded: INCLUDE_EXISTING,
  filesScanned: scanned,
  findings: findings.length,
  truncated: findings.length >= MAX,
  bySeverity,
  causedByThisUpgrade: findings.filter(f => !f.preExisting).length,
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
