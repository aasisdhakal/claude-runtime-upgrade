#!/usr/bin/env node
// After a dependency upgrade: WHAT moved, HOW you use it, and WHAT could
// possibly have caught a regression.
//
//   node depverify.mjs <lang> <dir> --before <lockfile-copy> [--after <path>]
//   node depverify.mjs <lang> <dir> --git            # diff the lockfile against HEAD
//
// A type checker catches SHAPE changes only. It cannot catch the same call
// returning a different answer. This script finds the packages where that is
// possible, ranks them by how much of your code would feel it, and emits a
// probe plan for the packages where nothing static can help.
import { resolve, join, existsSync, readText, walk, rel, emit, die } from './lib/io.mjs';
import { run } from './lib/sh.mjs';
import { byId } from './adapters/index.mjs';
import { SOURCE_EXT } from './lib/breaking.mjs';
import { stripComments, stripNonCode } from './lib/strip.mjs';
import { LOCKFILES, diffLocks } from './lib/lockdiff.mjs';
import { catchability } from './lib/typecover.mjs';

const PROBE_CMD = new URL('probe.mjs', import.meta.url).pathname;
const PROBE_EXTS = { node: '.mjs', python: '.py', php: '.php', ruby: '.rb' };

const argv = process.argv.slice(2);
const [langArg, dirArg] = argv.filter(a => !a.startsWith('--'));
if (!langArg || !dirArg) die('usage: depverify.mjs <lang> <dir> (--git | --before <file>) [--after <file>]', 2);
const flag = n => { const i = argv.indexOf('--' + n); return i >= 0 ? argv[i + 1] : null; };
const has = n => argv.includes('--' + n);
const A = byId[langArg] || die(`unsupported language: ${langArg}`, 2);
const DIR = resolve(dirArg);
if (!existsSync(DIR)) die(`no such directory: ${DIR}`);
const TOP = Number(flag('top') || 15);

// ── locate the lockfile and get both sides ──
const lockName = LOCKFILES.find(f => existsSync(join(DIR, f)))
  || die(`no lockfile in ${DIR} — without one there is no record of what actually moved`);
const afterText = flag('after') ? readText(resolve(flag('after'))) : readText(join(DIR, lockName));
let beforeText = flag('before') ? readText(resolve(flag('before'))) : null;
if (!beforeText && has('git')) {
  const r = run('git', ['show', `HEAD:${lockName}`], { cwd: DIR, timeout: 30000 });
  if (r.ok) beforeText = r.stdout;
}
if (!beforeText)
  die(`no "before" snapshot. Pass --before <copy of ${lockName} taken before the upgrade>, or --git to use HEAD.\n`
    + '  Take the copy BEFORE upgrading — after the fact there is nothing to compare against.');

const d = diffLocks(lockName, beforeText, afterText);

// ── how does this repo actually use each package? ──
const ext = SOURCE_EXT[A.id];
const files = ext ? walk(DIR, { match: n => ext.test(n), maxDepth: 12, limit: 20000 }) : [];
// comments out, STRINGS KEPT: an import specifier is a string literal, so
// blanking strings would erase the package name we are looking for
const sources = files.map(f => ({ f, code: stripComments(readText(f) || '', A.id) }))
                     .filter(x => x.code);

function importRe(lang, name) {
  const e = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  switch (lang) {
    case 'node': case 'deno': case 'bun':
      return new RegExp(`(?:require\\(\\s*['"\`]${e}(?:/[^'"\`]*)?['"\`]|from\\s+['"\`]${e}(?:/[^'"\`]*)?['"\`]|import\\(\\s*['"\`]${e})`, 'g');
    case 'python':
      return new RegExp(`(?:^|\\n)\\s*(?:import\\s+${e.replace(/-/g, '[-_]')}|from\\s+${e.replace(/-/g, '[-_]')}[\\s.])`, 'g');
    case 'php':
      return new RegExp(`use\\s+${e.split('/').pop().replace(/[^\\w]/g, '.')}`, 'gi');
    case 'ruby':
      return new RegExp(`require\\s+['"]${e}(?:/[^'"]*)?['"]`, 'g');
    case 'go':
      return new RegExp(`['"\`]${e}(?:/[^'"\`]*)?['"\`]`, 'g');
    case 'rust':
      return new RegExp(`\\buse\\s+${e.replace(/-/g, '_')}\\b|\\b${e.replace(/-/g, '_')}::`, 'g');
    default: return null;
  }
}

/**
 * Where does this repo actually IMPORT the package?
 *
 * The specifier is a string literal, so strings have to be kept — but then a
 * string that merely CONTAINS an import counts too. A decoy file holding
 * `"require('uid')"` in a double-quoted string and `` `from 'uid'` `` in a
 * template literal was ranked the top call site for a package it never imports,
 * and the probe instructions then pointed at it.
 *
 * Two passes fix this without choosing between the two failure modes:
 *   1. find candidate STATEMENT positions in the string-blanked code, where a
 *      `require(` or `from` inside a string has already been erased;
 *   2. read the specifier out of the RAW text at those same offsets.
 * stripNonCode blanks space-for-character, so the offsets are identical.
 */
function callSites(name) {
  const re = importRe(A.id, name);
  if (!re) return { files: [], count: 0 };
  const hits = [];
  for (const { f, code } of sources) {
    const noStrings = stripNonCode(code, A.id);
    let n = 0;
    const rx = new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g');
    let m;
    while ((m = rx.exec(code)) !== null) {
      // the keyword that opens the statement must survive string-blanking
      const head = m[0].match(/^[A-Za-z_$.]+/);
      const kw = head ? head[0] : m[0].slice(0, 1);
      if (noStrings.slice(m.index, m.index + kw.length) === kw) n++;
      if (m.index === rx.lastIndex) rx.lastIndex++;
    }
    if (n) hits.push({ file: rel(DIR, f), occurrences: n });
  }
  hits.sort((a, b) => b.occurrences - a.occurrences);
  return { files: hits.slice(0, 8), count: hits.reduce((s, h) => s + h.occurrences, 0), fileCount: hits.length };
}

// ── rank ──
const assessed = d.changed.map(c => {
  const sites = callSites(c.name);
  const cat = catchability(A.id, DIR, c.name);
  // blast radius: how much of YOUR code touches it, weighted by how far it moved
  const levelWeight = { major: 6, minor: 2, patch: 1 }[c.level];
  const reach = sites.fileCount > 20 ? 4 : sites.fileCount > 5 ? 3 : sites.fileCount > 0 ? 2 : 1;
  const blind = cat.shapeChecked ? 1 : 3;          // nothing static would catch it
  return {
    ...c,
    direct: sites.count > 0,
    callSites: sites.count, filesTouching: sites.fileCount, where: sites.files,
    catchability: cat.verdict, shapeChecked: cat.shapeChecked, why: cat.why,
    probePriority: levelWeight * reach * blind,
  };
}).sort((a, b) => b.probePriority - a.probePriority);

const used = assessed.filter(a => a.direct);
const unused = assessed.filter(a => !a.direct);
const blindMajors = used.filter(a => a.level === 'major' && !a.shapeChecked);

emit({
  lang: A.id, dir: DIR, lockfile: lockName,
  summary: {
    ...d.counts,
    changedAndUsedDirectly: used.length,
    changedButNotImported: unused.length,
    majorsWithNoStaticCheck: blindMajors.length,
  },
  typeChecking: catchability(A.id, DIR, used[0]?.name || 'x').project,
  theGap:
    'A type checker only ever catches SHAPE changes — a renamed export, a changed signature. '
  + 'It cannot catch the same call returning a DIFFERENT ANSWER: an unstable sort, a timezone '
  + 'rule, a rounding change, a different hash. No static tool catches that in any language. '
  + 'The packages below are ranked by how badly that matters here.',
  probePlan: used.slice(0, TOP).map(a => ({
    package: a.name, from: a.from, to: a.to, level: a.level,
    callSites: a.callSites, filesTouching: a.filesTouching,
    staticallyChecked: a.shapeChecked, catchability: a.catchability,
    priority: a.probePriority,
    why: a.why,
    probe: `exercise ${a.name} the way ${a.where[0]?.file || 'this repo'} uses it, on ${a.from} and ${a.to}, and diff the OUTPUT`,
    where: a.where,
  })),
  changedButNotImported: unused.slice(0, 20).map(a => ({ package: a.name, from: a.from, to: a.to, level: a.level,
    note: 'transitive — no direct import found. A behaviour change here still reaches you through its dependents.' })),
  // probe.mjs installs each version into its own scratch dir, so nothing has to
  // be stashed or reinstalled in the working tree
  nextStep: used.length
    ? `write a probe from the call sites above — not from the package README — then run it both ways:\n` +
      used.slice(0, 3).map(u =>
        `  node ${PROBE_CMD} ${A.id} ${u.name} ${u.from} ${u.to} --probe ./probe-${u.name.replace(/[^a-z0-9]/gi, '-')}${PROBE_EXTS[A.id] || ".txt"}`
      ).join('\n') +
      `\nPrint one labelled line per call, and print the RESULT — a probe that only proves it did not throw is near-worthless.`
    : 'nothing changed that this repo imports directly'
      + (unused.length ? ` — but ${unused.length} transitive package(s) moved and still reach you through their dependents` : ''),
});
