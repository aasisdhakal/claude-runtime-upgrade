#!/usr/bin/env node
// Zero-dependency test runner. `node tests/run.mjs [--filter substr]`
// Network-dependent cases are skipped automatically when offline or unreachable.
import { build, destroy, FIXTURES } from './fixtures.mjs';
import { runJson, run } from '../scripts/lib/sh.mjs';
import { fetchJson, walk, walkGaps, readText, parseArgv } from '../scripts/lib/io.mjs';
import { satisfies, rangeMajor, rangeMajorMinor, compare } from '../scripts/lib/semver.mjs';
import { stripNonCode, stripComments, usesCgo } from '../scripts/lib/strip.mjs';
import { LOCKFILES, diffLocks, bump } from '../scripts/lib/lockdiff.mjs';
import { projectTypeChecking, catchability } from '../scripts/lib/typecover.mjs';
import { PR_PROVIDERS, ISSUE_PROVIDERS, hostOf, slugOf, compareUrl, pickSuggestion } from '../scripts/lib/providers.mjs';
import { RULES, rulesFor, inheritedCatalogue } from '../scripts/lib/breaking.mjs';
import { adapters, byId, adaptersForManifest } from '../scripts/adapters/index.mjs';
import { FRAMEWORK_MAP, UNTRACKED, frameworkEol } from '../scripts/lib/frameworks.mjs';
import { PIN_RULES, planPinEdits, unified, planCiEdits, planConfigEdits, ciMatrixAdvice,
         isCompoundConstraint, raiseLowerBound, declaredButUnreadable,
         planAddPin, ADD_PIN_RULES, mapSuffix, ruleKind } from '../scripts/lib/edits.mjs';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { readFileSync, writeFileSync, mkdtempSync, rmSync, mkdirSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const S = p => join(HERE, '..', 'scripts', p);
const FILTER = process.argv.includes('--filter') ? process.argv[process.argv.indexOf('--filter') + 1] : null;

let pass = 0, fail = 0, skip = 0;
const failures = [];

function t(name, fn) {
  if (FILTER && !name.includes(FILTER)) return;
  try {
    const r = fn();
    if (r === 'skip') { skip++; process.stdout.write(`  \x1b[33mSKIP\x1b[0m ${name}\n`); return; }
    pass++; process.stdout.write(`  \x1b[32mPASS\x1b[0m ${name}\n`);
  } catch (e) {
    fail++; failures.push([name, e.message]);
    process.stdout.write(`  \x1b[31mFAIL\x1b[0m ${name}\n       ${e.message}\n`);
  }
}
async function ta(name, fn) {
  if (FILTER && !name.includes(FILTER)) return;
  try {
    const r = await fn();
    if (r === 'skip') { skip++; process.stdout.write(`  \x1b[33mSKIP\x1b[0m ${name}\n`); return; }
    pass++; process.stdout.write(`  \x1b[32mPASS\x1b[0m ${name}\n`);
  } catch (e) {
    fail++; failures.push([name, e.message]);
    process.stdout.write(`  \x1b[31mFAIL\x1b[0m ${name}\n       ${e.message}\n`);
  }
}
const eq = (got, want, what = '') => {
  if (JSON.stringify(got) !== JSON.stringify(want))
    throw new Error(`${what} expected ${JSON.stringify(want)}, got ${JSON.stringify(got)}`);
};
const ok = (cond, msg) => { if (!cond) throw new Error(msg); };

function detect(root) {
  const r = runJson(process.execPath, [S('detect.mjs'), root]);
  if (!r.data) throw new Error('detect.mjs produced no JSON: ' + (r.stderr || r.parseError || '').slice(0, 300));
  return r.data;
}
function withFixture(name, fn) { const r = build(name); try { return fn(r); } finally { destroy(r); } }

// ───────────────────────── semver ─────────────────────────
t('meta: test runners are hoisted function declarations', () => {
  // a `const` arrow does not hoist, so a test written above its runner fails
  // with a confusing TDZ error. This has happened three times.
  const src = readFileSync(join(HERE, 'run.mjs'), 'utf8');
  const bad = [...src.matchAll(/^const (plan|scan|guard|guardRaw|pr|remediate|withFixture)\s*=/gm)]
    .map(m => m[1]);
  ok(bad.length === 0, `these runners must be function declarations: ${bad.join(', ')}`);
});

console.log('\nsemver');
t('caret range', () => { ok(satisfies('22.23.5', '^22.23.2'), 'in'); ok(!satisfies('23.0.0', '^22.23.2'), 'out'); });
t('x-range major', () => { ok(satisfies('24.9.1', '24.x'), 'in'); ok(!satisfies('25.0.0', '24.x'), 'out'); });
t('or-alternatives', () => ok(satisfies('26.1.0', '22.x || 24.x || 26.x'), 'should match third alternative'));
t('and-comparators', () => { ok(satisfies('18.5.0', '>=18.0.0 <19.0.0'), 'in'); ok(!satisfies('19.1.0', '>=18.0.0 <19.0.0'), 'out'); });
t('tilde range', () => { ok(satisfies('8.2.9', '~8.2.1'), 'in'); ok(!satisfies('8.3.0', '~8.2.1'), 'out'); });
t('bare major equality', () => { ok(satisfies('20.11.1', '20'), 'in'); ok(!satisfies('21.0.0', '20'), 'out'); });
t('v-prefix tolerated', () => ok(satisfies('v24.22.1', '24.x'), 'leading v'));
t('REGRESSION: space between operator and version', () => {
  // Found by running against a real production repo: ">= 20" was tokenised as [">=","20"],
  // the orphaned operator failed to parse, and SIX packages were falsely
  // reported as blocking the upgrade. Any range with a space must work.
  ok(satisfies('24.22.1', '>= 20'), '>= 20 must match 24.22.1');
  ok(satisfies('24.22.1', '> 18'), '> 18');
  ok(satisfies('24.22.1', '>= 16.0.0'), '>= 16.0.0');
  ok(satisfies('24.22.1', '<= 30'), '<= 30');
  ok(satisfies('24.22.1', '>= 0.8.0'), '>= 0.8.0');
  ok(!satisfies('24.22.1', '>= 25'), '>= 25 must NOT match');
  ok(!satisfies('16.0.0', '>= 20'), 'lower version must not match >= 20');
});
t('spaced and unspaced forms agree', () => {
  for (const [a, b] of [['>=20', '>= 20'], ['>18', '> 18'], ['<=30', '<= 30'], ['>=16.0.0', '>= 16.0.0']])
    eq(satisfies('24.22.1', a), satisfies('24.22.1', b), `${a} vs ${b}`);
});
t('partial caret and tilde', () => {
  ok(satisfies('24.22.1', '^24'), '^24'); ok(!satisfies('24.22.1', '^22'), '^22');
  ok(satisfies('8.4.0', '^8.1'), '^8.1 allows 8.4'); ok(!satisfies('9.0.0', '^8.1'), '^8.1 stops at 9');
  ok(satisfies('8.3.9', '~8.3'), '~8.3'); ok(!satisfies('8.4.0', '~8.3'), '~8.3 stops at 8.4');
});
t('hyphen range', () => {
  ok(satisfies('20.5.0', '1.2.3 - 22.0.0'), 'inside');
  ok(!satisfies('24.0.0', '1.2.3 - 22.0.0'), 'outside');
});
t('wildcard matches anything', () => { ok(satisfies('24.22.1', '*'), '*'); ok(satisfies('1.0.0', 'x'), 'x'); });
t('real engines fields seen in the wild', () => {
  const real = [
    ['>= 20', true], ['>=20.0.0', true], ['>= 16.0.0', true], ['>= 12', true],
    ['^20.19.0 || ^22.13.0 || >=24.11.0', true],
    ['>=20.19.0 <22.0.0 || >=22.12.0 <23.0.0 || >=23.2.0', true],
    ['^18.14.0 || ^20.0.0 || ^22.0.0 || >=24.0.0', true],
    ['>=24.9.0', true], ['^14.15.0 || ^16.10.0 || >=18.0.0', true],
    ['>= 25', false], ['^22.0.0', false],
  ];
  for (const [r, want] of real) eq(satisfies('24.22.1', r), want, `engines "${r}"`);
});
t('rangeMajor', () => { eq(rangeMajor('>= 20.x'), '20'); eq(rangeMajor('^18.2.0'), '18'); eq(rangeMajor(''), ''); });
t('rangeMajorMinor', () => { eq(rangeMajorMinor('^8.1'), '8.1'); eq(rangeMajorMinor('>=7.4.0'), '7.4'); });
t('compare orders cycles', () => { ok(compare('24', '8.5') > 0, '24>8.5'); ok(compare('8.5', '8.4') > 0, '8.5>8.4'); });

// Differential + fuzz against npm `semver` when it is installed. These are the
// only tests that can prove the hand-rolled matcher correct rather than merely
// consistent with my own assumptions. Skipped when `semver` is unavailable.
// `semver` is a DEV-only aid: the skill itself ships zero dependencies.
// Try several roots so CI can supply it with `npm i --no-save semver`.
function loadSemver() {
  for (const base of [import.meta.url, `file://${process.cwd()}/x.js`,
                      `file://${join(HERE, 'x.js')}`, `file://${join(HERE, '..', 'x.js')}`]) {
    try { return createRequire(base)('semver'); } catch {}
  }
  return null;
}
t('differential vs npm semver on 143 real engines ranges', () => {
  const semver = loadSemver(); if (!semver) return 'skip';
  const corpus = JSON.parse(readFileSync(join(HERE, 'engines-corpus.json'), 'utf8'));
  const versions = ['0.10.48','8.17.0','12.22.12','16.20.2','18.20.8','20.11.1','20.20.2',
                    '22.12.0','22.23.4','24.0.0','24.22.1','26.12.1'];
  const bad = [];
  for (const r of corpus) for (const v of versions) {
    let want; try { want = semver.satisfies(v, r, { loose: true, includePrerelease: true }); } catch { continue; }
    if (satisfies(v, r) !== want) bad.push(`${v} vs ${JSON.stringify(r)}`);
  }
  ok(bad.length === 0, `${bad.length} mismatches, e.g. ${bad.slice(0, 3).join(' | ')}`);
});
t('fuzz vs npm semver — 40k generated comparisons', () => {
  const semver = loadSemver(); if (!semver) return 'skip';
  let seed = 1337;                                   // deterministic: failures reproduce
  const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  const pick = a => a[Math.floor(rnd() * a.length)];
  const num = () => Math.floor(rnd() * 30);
  const ops = ['', '>=', '<=', '>', '<', '=', '^', '~', '>= ', '<= ', '> ', '< ', '^ ', '~ '];
  const vv = () => { const n = Math.floor(rnd() * 3);
    return n === 0 ? `${num()}` : n === 1 ? `${num()}.${pick([num(), 'x', '*'])}`
                                          : `${num()}.${num()}.${pick([num(), 'x', '*'])}`; };
  const range = () => Array.from({ length: 1 + Math.floor(rnd() * 3) }, () =>
    Array.from({ length: 1 + Math.floor(rnd() * 2) }, () => pick(ops) + vv()).join(' ')).join(' || ');
  const versions = ['0.10.0','8.0.0','12.22.0','16.14.0','18.20.8','20.11.1','22.12.0','24.22.1','26.12.1','30.0.0'];
  const bad = [];
  for (let i = 0; i < 4000 && bad.length < 5; i++) {
    const r = range();
    for (const v of versions) {
      let want; try { want = semver.satisfies(v, r, { loose: true }); } catch { continue; }
      if (satisfies(v, r) !== want) bad.push(`${v} vs ${JSON.stringify(r)}`);
    }
  }
  ok(bad.length === 0, `mismatches: ${bad.join(' | ')}`);
});
t('X-range bounds follow npm semantics', () => {
  // a partial version is an INTERVAL; > and <= bound against its end
  ok(!satisfies('26.12.1', '> 26.x'), '>26.x excludes all of 26');
  ok(!satisfies('24.22.1', '> 24'),   '>24 excludes all of 24');
  ok(satisfies('0.10.0', '<= 0'),     '<=0 includes all of 0.x');
  ok(satisfies('12.22.0', '<= 12.x'), '<=12.x includes all of 12');
  ok(satisfies('1.3.0', '>1.2'),      '>1.2 starts at 1.3.0');
  ok(!satisfies('1.2.9', '>1.2'),     '>1.2 excludes 1.2.9');
  ok(satisfies('20.11.1', '>=20.x'),  '>=20.x starts at 20.0.0');
});

// ───────────────────────── adapters ─────────────────────────
console.log('\nadapters');
t('registry exposes all supported languages', () =>
  eq(adapters.map(a => a.id).sort(),
     ['bun','deno','dotnet','elixir','erlang','go','java','kotlin','node','perl','php','python','ruby','rust','scala']));
t('node is gate-capable, php is not', () => { ok(byId.node.gateCapable === true, 'node'); ok(byId.php.gateCapable === false, 'php'); });
t('shared manifests resolve to EVERY claiming adapter', () => {
  // build.gradle.kts is both a Java and a Kotlin manifest. Returning one
  // adapter silently loses the other — that is how Kotlin got reported as Java.
  const kts = adaptersForManifest('build.gradle.kts').map(a => a.id).sort();
  ok(kts.includes('java') && kts.includes('kotlin'), `build.gradle.kts -> ${kts.join(',')}`);
  eq(adaptersForManifest('go.mod').map(a => a.id), ['go'], 'unshared manifests resolve to one');
  eq(adaptersForManifest('nonsense.txt'), [], 'unknown filenames resolve to none');
});
t('a different axis never counts as drift', () => {
  // Kotlin's JVM toolchain and Scala's cross-build matrix are separate axes.
  for (const id of ['kotlin', 'scala', 'elixir']) ok(byId[id], `${id} registered`);
});
t('every adapter has a distinct id and an imageRe', () => {
  eq(new Set(adapters.map(a => a.id)).size, adapters.length, 'ids unique');
  for (const a of adapters) ok(a.imageRe instanceof RegExp, `${a.id} imageRe`);
});
t('php carries a gate explanation', () => ok((byId.php.gateNote || '').length > 40, 'gateNote must explain why no hard gate'));
t('every adapter declares required fields', () => {
  for (const a of adapters) for (const k of ['id','label','manifests','eolProduct','osvEcosystem','gateCapable','cveSource','imageRe','scan'])
    ok(a[k] !== undefined, `${a.id} missing ${k}`);
});

t('factory: every spec key is actually destructured', () => {
  // Twice now a new spec key was added to _generated.mjs but not to the
  // destructure in makeAdapter, producing a ReferenceError at scan time that
  // detect.mjs swallowed into a generic "error" target.
  const factory = readFileSync(join(HERE, '..', 'scripts', 'adapters', '_factory.mjs'), 'utf8');
  const gen = readFileSync(join(HERE, '..', 'scripts', 'adapters', '_generated.mjs'), 'utf8');
  const destructured = new Set(
    (factory.match(/const \{\n([\s\S]*?)\n  \} = spec;/)?.[1] || '')
      .split(/[,\n]/).map(x => x.trim().split(/[:=\s]/)[0]).filter(Boolean));
  const used = new Set([...gen.matchAll(/^\s{2}([a-zA-Z]\w*):/gm)].map(m => m[1]));
  const missing = [...used].filter(k => !destructured.has(k));
  ok(missing.length === 0, `spec keys used but not destructured: ${missing.join(', ')}`);
});
t('factory: every generated adapter actually scans without throwing', () => {
  // the ReferenceError above only surfaced on real repos, never in unit tests
  const r = build('single-go');
  try {
    for (const a of adapters) {
      if (!a.scan) continue;
      a.scan({ dir: r, root: r, dockerImages: [], ciText: '' });   // must not throw
    }
  } finally { destroy(r); }
});

// ───────────────────────── discovery: every repo shape ─────────────────────────
console.log('\ndiscovery — repo shapes');
t('shape: single node', () => withFixture('single-node', r => {
  const d = detect(r); eq(d.shape, 'single', 'shape'); eq(d.targetCount, 1, 'count');
  eq(d.targets[0].lang, 'node'); eq(d.targets[0].declaredMajors, '20');
  eq(d.targets[0].lockfile, 'package-lock.json');
}));
t('shape: single php', () => withFixture('single-php', r => {
  const d = detect(r); eq(d.shape, 'single', 'shape');
  const p = d.targets.find(x => x.lang === 'php'); ok(p, 'php target'); eq(p.declaredMajors, '8.1');
  eq(p.lockfile, 'composer.lock');
}));
t('shape: monorepo via workspaces', () => withFixture('monorepo-node', r => {
  const d = detect(r); eq(d.shape, 'monorepo', 'shape'); ok(d.targetCount >= 3, `got ${d.targetCount}`);
  ok(d.targets.some(x => x.workspaceRoot), 'one target flagged as workspace root');
}));
t('shape: polyrepo via sibling .git dirs', () => withFixture('polyrepo', r => {
  const d = detect(r); eq(d.shape, 'polyrepo', 'shape');
  eq(d.languages.sort(), ['node', 'php'], 'both languages found');
}));
t('shape: mixed-single runs both adapters', () => withFixture('mixed-single', r => {
  const d = detect(r); eq(d.shape, 'mixed-single', 'shape');
  eq(d.targets.map(t => t.lang).sort(), ['node', 'php']);
  eq(d.targets.find(t => t.lang === 'php').declaredMajors, '8.2');
}));
t('shape: container-only strips registry prefix', () => withFixture('container-only', r => {
  const d = detect(r); eq(d.shape, 'container-only', 'shape');
  const t0 = d.targets[0]; ok(t0.containerOnly, 'flagged containerOnly');
  eq(t0.declaredMajors, '22', 'major from public.ecr.aws/.../node:22-alpine3.21');
}));
t('shape: no-manifest reports and stops', () => withFixture('no-manifest', r => {
  const d = detect(r); eq(d.shape, 'no-manifest', 'shape'); eq(d.targetCount, 0, 'count');
  ok(/nothing to upgrade/i.test(d.shapeGuidance), 'guidance explains the stop');
}));

console.log('\ndiscovery — every language');
const LANGS = [
  ['single-go',     'go',     '1.21', 'go.sum'],
  ['single-python', 'python', '3.9',  'poetry.lock'],
  ['single-ruby',   'ruby',   '3.0',  'Gemfile.lock'],
  ['single-rust',   'rust',   '1.70', 'Cargo.lock'],
  ['single-java',   'java',   '17',   ''],
  ['single-dotnet', 'dotnet', '6',    ''],
];
for (const [fx, lang, major, lock] of LANGS) {
  t(`lang: ${lang} discovered with version ${major}`, () => withFixture(fx, r => {
    const d = detect(r);
    const tg = d.targets.find(x => x.lang === lang);
    ok(tg, `no ${lang} target found; got ${d.targets.map(x => x.lang).join(',') || 'none'}`);
    eq(tg.declaredMajors, major, `${lang} version`);
    eq(tg.drift, false, `${lang} must not report drift`);
    if (lock) eq(tg.lockfile, lock, `${lang} lockfile`);
  }));
}
t('lang: one target per directory per adapter (no pom/gradle double-count)', () => withFixture('single-java', r => {
  const d = detect(r);
  eq(d.targets.filter(x => x.lang === 'java').length, 1, 'exactly one java target');
}));
t('lang: dotnet prefers global.json over *.csproj but reports both', () => withFixture('single-dotnet', r => {
  const d = detect(r);
  const tg = d.targets.find(x => x.lang === 'dotnet');
  eq(tg.declared.targetFramework, 'net6.0', 'TFM read from csproj');
  eq(tg.declared.globalJsonSdk, '6.0.418', 'sdk read from global.json');
}));
t('lang: polyglot repo surfaces all four runtimes', () => withFixture('polyglot', r => {
  const d = detect(r);
  eq([...new Set(d.targets.map(x => x.lang))].sort(), ['go', 'node', 'php', 'python'], 'languages');
  eq(d.targets.length, 4, 'one target per runtime');
}));

console.log('\nCI accuracy');
t('ci: a node target ignores python-version in the same workflow', () => withFixture('ci-cross-language', r => {
  const d = detect(r);
  const tg = d.targets.find(x => x.lang === 'node');
  eq(tg.declaredMajors, '20', 'only the node version counts');
  eq(tg.drift, false, 'a sibling python pin must not create drift');
  ok(!/3\.8/.test(tg.declared.ci || ''), 'python version must not leak into the node CI field');
}));
t('ci: a test matrix is recorded, not reported as drift', () => withFixture('ci-matrix', r => {
  const d = detect(r);
  const tg = d.targets.find(x => x.lang === 'python');
  eq(tg.drift, false, 'a multi-version CI matrix is deliberate breadth');
  ok(Array.isArray(tg.ciMatrix) && tg.ciMatrix.length >= 3, 'the matrix is still surfaced');
  ok(/test matrix/.test(tg.declared.ci || ''), 'labelled as a matrix');
}));
t('ci: templated values are ignored', () => withFixture('ci-templated', r => {
  const d = detect(r);
  const tg = d.targets.find(x => x.lang === 'node');
  eq(tg.declaredMajors, '22', 'only the real declaration counts');
  eq(tg.drift, false, '${{ matrix.node }} must not parse as a version');
}));
t('ci: every adapter scopes its own CI key', () => {
  for (const a of adapters) ok(a.ciKey instanceof RegExp, `${a.id} must declare ciKey`);
  ok(byId.node.ciKey.test('node-version: 20'), 'node matches node-version');
  ok(!byId.node.ciKey.test('python-version: 3.8'), 'node must NOT match python-version');
  ok(byId.python.ciKey.test('python-version: 3.11'), 'python matches python-version');
  ok(!byId.python.ciKey.test('node-version: 20'), 'python must NOT match node-version');
});

console.log('\ngate capability — honesty contract');
t('gate: exactly node and go can gate, and go gates on total', () => {
  const gating = adapters.filter(a => a.gateCapable).map(a => a.id).sort();
  eq(gating, ['go', 'node'], 'only runtimes with a curated version-ranged CVE DB may gate');
  eq(byId.go.gateMetric, 'total', 'go has no severity data, so it gates on total');
  eq(byId.node.gateMetric ?? 'blocking', 'blocking', 'node gates on high/critical');
});
t('gate: every non-gating adapter explains why', () => {
  for (const a of adapters.filter(x => !x.gateCapable))
    ok((a.gateNote || '').length > 60, `${a.id} must explain why it cannot gate`);
});
t('gate: java eolProduct is a real distribution, not "java"', () => {
  ok(byId.java.eolAliases.includes(byId.java.eolProduct), 'must be one of the tracked JDK distributions');
  ok(!byId.java.eolAliases.includes('java'), 'endoflife.date has no bare "java" product');
});

// ───────────────────────── drift ─────────────────────────
console.log('\ndrift');
t('drift: disagreeing declarations are a finding', () => withFixture('drift', r => {
  const d = detect(r); const t0 = d.targets[0];
  ok(t0.drift === true, 'drift must be true');
  eq(t0.declaredMajors.split(',').sort(), ['18','20','22'], 'all three majors reported');
  eq(d.driftCount, 1, 'driftCount');
}));
t('drift: agreeing declarations are not drift', () => withFixture('single-node', r => {
  const d = detect(r); eq(d.targets[0].drift, false); eq(d.driftCount, 0);
}));

// ───────────────────────── ABI classification ─────────────────────────
console.log('\nnative addon classification');
t('abi: ABI-pinned vs N-API vs source-build', () => withFixture('abi-classify', r => {
  const a = runJson(process.execPath, [S('assess.mjs'), 'node', r, '24.22.1']);
  ok(a.data, 'assess produced JSON: ' + (a.stderr || '').slice(0, 200));
  const kind = n => (a.data.nativeAddons.find(x => x.name === n) || {}).kind;
  eq(kind('abi-pkg'), 'abi-pinned', 'abi-pkg');
  eq(kind('napi-pkg'), 'napi', 'napi-pkg');
  eq(kind('src-pkg'), 'source-build', 'src-pkg');
  eq(a.data.nativeBlockers.map(b => b.name).sort(), ['abi-pkg', 'trap-pkg'], 'blockers');
}));
t('abi: ABI evidence beats a napi declaration', () => withFixture('abi-classify', r => {
  const a = runJson(process.execPath, [S('assess.mjs'), 'node', r, '24.22.1']);
  const trap = a.data.nativeAddons.find(x => x.name === 'trap-pkg');
  eq(trap.kind, 'abi-pinned', 'a package declaring napi_versions but shipping ABI-numbered .node files is ABI-pinned');
  eq(trap.abis, '137', 'abi extracted');
}));
t('abi: N-API packages stay out of the blocker list', () => withFixture('abi-classify', r => {
  const a = runJson(process.execPath, [S('assess.mjs'), 'node', r, '24.22.1']);
  ok(!a.data.nativeBlockers.some(b => b.name === 'napi-pkg'), 'napi-pkg must never be a blocker');
}));

// ───────────────────────── research (network) ─────────────────────────
console.log('\nresearch — live data');
const reach = await fetchJson('https://endoflife.date/api/nodejs.json');
await ta('node EOL + CVE delta', async () => {
  if (!reach.data) return 'skip';
  const r = runJson(process.execPath, [S('research.mjs'), 'node', '20.11.1', '24.22.1']);
  ok(r.data, 'research produced JSON');
  eq(r.data.current.isEol, true, 'node 20 is EOL');
  ok(r.data.current.cve.blocking > 0, 'node 20 must carry blocking CVEs');
  eq(r.data.target.cve.blocking, 0, 'node 24.22.1 must be clean');
  ok(r.data.cveDelta.blockingRemoved > 0, 'delta positive');
  eq(r.data.gateCapable, true);
});
await ta('php reports gateCapable false with a reason', async () => {
  if (!reach.data) return 'skip';
  const r = runJson(process.execPath, [S('research.mjs'), 'php', '7.4']);
  ok(r.data, 'research produced JSON');
  eq(r.data.gateCapable, false, 'php cannot hard-gate');
  ok(r.data.gateNote && r.data.gateNote.length > 40, 'must explain why');
  eq(r.data.current.isEol, true, 'php 7.4 is EOL');
  ok(r.data.target.version, 'a target was auto-selected');
});
await ta('target auto-selection avoids EOL cycles', async () => {
  if (!reach.data) return 'skip';
  const r = runJson(process.execPath, [S('research.mjs'), 'node', '20.11.1']);
  const today = new Date().toISOString().slice(0, 10);
  ok(r.data.target.eol > today, `auto-selected target ${r.data.target.version} must not be EOL`);
  eq(r.data.target.autoSelected, true);
});
await ta('generic: any endoflife.date product works without an adapter', async () => {
  if (!reach.data) return 'skip';
  const r = runJson(process.execPath, [S('research.mjs'), 'postgresql', '14']);
  ok(r.data, 'produced JSON');
  eq(r.data.generic, true, 'flagged as generic');
  eq(r.data.adapter, null, 'no adapter claimed');
  eq(r.data.gateCapable, false, 'generic lookups never gate');
  ok(r.data.gateNote && /No adapter exists/.test(r.data.gateNote), 'explains the limitation');
  ok(r.data.target.version, 'still recommends a target');
});
await ta('generic: an adapter always wins over the generic path', async () => {
  if (!reach.data) return 'skip';
  const r = runJson(process.execPath, [S('research.mjs'), 'node', '20.11.1']);
  eq(r.data.generic, false); eq(r.data.adapter, 'node'); eq(r.data.gateCapable, true);
});
await ta('offline mode never calls out', async () => {
  const r = runJson(process.execPath, [S('research.mjs'), 'node', '20.11.1'], { env: { RU_OFFLINE: '1' } });
  if (!r.data) return 'skip';
  eq(r.data.offline, true, 'offline flag surfaced');
  ok(r.data.current.major === '20', 'still produced a result from cache');
});

// ───────────────────────── verify gates ─────────────────────────
console.log('\nverify — gate behaviour');
t('policy=gate exits 1 on failure', () => withFixture('single-node', r => {
  const v = run(process.execPath, [S('verify.mjs'), 'node', r, '24.22.1', '--policy', 'gate']);
  eq(v.status, 1, 'must exit non-zero when a gate fails');
}));
t('policy=report always exits 0', () => withFixture('single-node', r => {
  const v = run(process.execPath, [S('verify.mjs'), 'node', r, '24.22.1', '--policy', 'report']);
  eq(v.status, 0, 'report mode must never block');
}));
t('drift is caught as a failing gate', () => withFixture('drift', r => {
  const v = runJson(process.execPath, [S('verify.mjs'), 'node', r, '24.22.1', '--policy', 'report']);
  const g = v.data.gates.find(x => x.name === 'version drift');
  eq(g.status, 'fail', 'drift must fail its gate');
}));

console.log('\nframework awareness');
t('fw: tracked frameworks are detected per ecosystem', () => withFixture('frameworks', r => {
  const d = detect(r);
  const node = d.targets.find(t => t.lang === 'node');
  const php = d.targets.find(t => t.lang === 'php');
  const prods = (node.frameworks || []).map(f => f.product).sort();
  eq(prods, ['nextjs', 'react'], 'node frameworks');
  eq((php.frameworks || []).map(f => f.product), ['laravel'], 'php framework');
}));
t('fw: untracked frameworks are named, never guessed at', () => withFixture('frameworks', r => {
  const d = detect(r);
  const node = d.targets.find(t => t.lang === 'node');
  const labels = (node.frameworksUntracked || []).map(f => f.label);
  ok(labels.includes('NestJS'), 'NestJS has no endoflife.date feed and must be listed as untracked');
  ok(!(node.frameworks || []).some(f => /nest/i.test(f.product)), 'and must NOT appear as tracked');
}));
t('fw: map never points two deps at a product that is not tracked upstream', () => {
  const products = new Set(Object.values(FRAMEWORK_MAP).flatMap(m => Object.values(m)));
  for (const p of products) ok(/^[a-z0-9-]+$/.test(p), `${p} must be an endoflife.date slug`);
  const untracked = new Set(Object.keys(UNTRACKED));
  for (const m of Object.values(FRAMEWORK_MAP))
    for (const dep of Object.keys(m)) ok(!untracked.has(dep), `${dep} cannot be both tracked and untracked`);
});
await ta('fw: resolves EOL status for a known-dead framework', async () => {
  const res = await frameworkEol([{ dep: 'laravel/framework', product: 'laravel', declared: '^7.0' }]);
  if (res[0].error) return 'skip';
  eq(res[0].cycle, '7', 'cycle');
  eq(res[0].isEol, true, 'Laravel 7 is long EOL');
  ok(res[0].newestSupported && Number(res[0].newestSupported.cycle) > 7, 'a supported successor is named');
});

// ───────────────────────── write-mode guardrails ─────────────────────────
console.log('\nwrite-mode guardrails');
function gitRepo(fn) {
  const r = mkdtempSync(join(tmpdir(), 'ru-guard-'));
  try {
    run('git', ['init', '-q'], { cwd: r });
    run('git', ['config', 'user.email', 't@t'], { cwd: r });
    run('git', ['config', 'user.name', 'T'], { cwd: r });
    writeFileSync(join(r, 'package.json'), '{"name":"x","engines":{"node":">=20"}}');
    writeFileSync(join(r, 'package-lock.json'), '{"lockfileVersion":3}');
    run('git', ['add', '-A'], { cwd: r });
    run('git', ['commit', '-qm', 'init'], { cwd: r });
    return fn(r);
  } finally { rmSync(r, { recursive: true, force: true }); }
}
function guard(...a) { return runJson(process.execPath, [S('guard.mjs'), ...a]); }
function guardRaw(...a) { return run(process.execPath, [S('guard.mjs'), ...a]); }

t('guard: refuses to commit on a protected branch', () => gitRepo(r => {
  const v = guardRaw('commit', r, '-m', 'sneaky');
  ok(v.status !== 0, 'must exit non-zero');
  ok(/protected branch/.test(v.stderr + v.stdout), 'must say why');
}));
t('guard: preflight blocks on main and exits 1', () => gitRepo(r => {
  const v = guardRaw('preflight', r);
  eq(v.status, 1, 'exit code');
  const j = JSON.parse(v.stdout);
  eq(j.verdict, 'blocked');
  ok(j.checks.some(c => !c.ok && /protected/.test(c.rule)), 'names the protected-branch rule');
}));
t('guard: creates a runtime/* branch and then permits writes', () => gitRepo(r => {
  const b = guard('branch', r, 'node', '24.22.1');
  eq(b.data.branch, 'runtime/node-24.22.1');
  eq(b.data.created, true);
  const p = guard('preflight', r);
  eq(p.data.verdict, 'safe-to-write', 'clean runtime branch is writable');
}));
t('guard: a runtime-pin-only change needs no lockfile update', () => gitRepo(r => {
  // Bumping engines.node changes no resolution. Demanding a lockfile update for
  // it refused correct commits against chalk, ripgrep, click, Carbon and mux.
  guard('branch', r, 'node', '24.22.1');
  writeFileSync(join(r, 'package.json'), '{"name":"x","engines":{"node":">=24.22.1 <25"}}');
  const v = guard('commit', r, '-m', 'pin runtime');
  eq(v.data.verdict, 'committed', 'a pin-only change must be allowed');
}));
t('guard: refuses a DEPENDENCY change without its lockfile', () => gitRepo(r => {
  guard('branch', r, 'node', '24.22.1');
  writeFileSync(join(r, 'package.json'),
    '{"name":"x","engines":{"node":">=20"},"dependencies":{"ms":"^2.1.3"}}');
  const v = guard('commit', r, '-m', 'bump dep');
  eq(v.data.verdict, 'refused');
  ok(v.data.blocked.some(b => /dependencies changed without its lockfile/.test(b)), 'names the rule');
  const staged = run('git', ['diff', '--cached', '--name-only'], { cwd: r }).stdout.trim();
  eq(staged, '', 'index must be reset after a refusal');
}));
t('guard: tells a pin from a dep even in MINIFIED json', () => {
  // minified manifests put engines and dependencies on ONE line, so any
  // line-based rule gets this wrong in one direction or the other
  const r = mkdtempSync(join(tmpdir(), 'ru-min-'));
  try {
    run('git', ['init', '-q'], { cwd: r });
    run('git', ['config', 'user.email', 't@t'], { cwd: r });
    run('git', ['config', 'user.name', 'T'], { cwd: r });
    writeFileSync(join(r, 'package.json'), '{"name":"x","engines":{"node":">=20"},"dependencies":{"ms":"2.1.2"}}');
    writeFileSync(join(r, 'package-lock.json'), '{"lockfileVersion":3}');
    run('git', ['add', '-A'], { cwd: r }); run('git', ['commit', '-qm', 'init'], { cwd: r });
    guard('branch', r, 'node', '24.22.1');
    // same line, only the pin moves
    writeFileSync(join(r, 'package.json'), '{"name":"x","engines":{"node":">=24.22.1 <25"},"dependencies":{"ms":"2.1.2"}}');
    eq(guard('commit', r, '-m', 'pin').data.verdict, 'committed', 'pin-only on one line');
    // same line, only the dependency moves
    writeFileSync(join(r, 'package.json'), '{"name":"x","engines":{"node":">=24.22.1 <25"},"dependencies":{"ms":"^9.9.9"}}');
    eq(guard('commit', r, '-m', 'dep').data.verdict, 'refused', 'dep change on one line');
  } finally { rmSync(r, { recursive: true, force: true }); }
});
t('guard: composer php constraint is a pin, not a dependency', () => {
  const r = mkdtempSync(join(tmpdir(), 'ru-composer-'));
  try {
    run('git', ['init', '-q'], { cwd: r });
    run('git', ['config', 'user.email', 't@t'], { cwd: r });
    run('git', ['config', 'user.name', 'T'], { cwd: r });
    writeFileSync(join(r, 'composer.json'), '{"name":"a/b","require":{"php":"^8.1","monolog/monolog":"^3.0"}}');
    writeFileSync(join(r, 'composer.lock'), '{"packages":[]}');
    run('git', ['add', '-A'], { cwd: r }); run('git', ['commit', '-qm', 'init'], { cwd: r });
    guard('branch', r, 'php', '8.4');
    writeFileSync(join(r, 'composer.json'), '{"name":"a/b","require":{"php":"^8.4","monolog/monolog":"^3.0"}}');
    eq(guard('commit', r, '-m', 'pin php').data.verdict, 'committed', 'require.php is a runtime pin');
  } finally { rmSync(r, { recursive: true, force: true }); }
});
t('guard: commits when manifest and lockfile move together', () => gitRepo(r => {
  guard('branch', r, 'node', '24.22.1');
  writeFileSync(join(r, 'package.json'), '{"name":"x","engines":{"node":">=24.22.1 <25"}}');
  writeFileSync(join(r, 'package-lock.json'), '{"lockfileVersion":3,"u":1}');
  const v = guard('commit', r, '-m', 'bump engines', '--phase', 'runtime');
  eq(v.data.verdict, 'committed');
  ok(v.data.files.includes('package.json') && v.data.files.includes('package-lock.json'), 'both files');
}));
t('guard: blocks secrets before they reach a commit', () => gitRepo(r => {
  guard('branch', r, 'node', '24.22.1');
  writeFileSync(join(r, 'cfg.js'), 'const k = "AKIAIOSFODNN7EXAMPLE";\nconst t = "ghp_aBcDeFgHiJkLmNoPqRsTuVwXyZ0123456789";\n');
  writeFileSync(join(r, 'id_rsa'), '-----BEGIN RSA PRIVATE KEY-----\nMIIEpAIB\n-----END RSA PRIVATE KEY-----\n');
  const v = guard('commit', r, '-m', 'add config');
  eq(v.data.verdict, 'refused');
  ok(v.data.blocked.some(b => /AWS access key/.test(b)), 'AWS key');
  ok(v.data.blocked.some(b => /GitHub personal access token/.test(b)), 'GitHub token');
  ok(v.data.blocked.some(b => /private key block/.test(b)), 'private key');
  const n = run('git', ['log', '--oneline'], { cwd: r }).stdout.trim().split('\n').length;
  eq(n, 1, 'no commit was created');
}));
t('guard: refuses to branch from a dirty tree', () => gitRepo(r => {
  writeFileSync(join(r, 'package.json'), '{"name":"dirty"}');
  const v = guardRaw('branch', r, 'node', '24.22.1');
  ok(v.status !== 0, 'must refuse');
  ok(/dirty/.test(v.stderr + v.stdout), 'must say why');
}));
t('guard: never contains a push or force code path', () => {
  const src = readFileSync(S('guard.mjs'), 'utf8');
  const code = src.split('\n').filter(l => !l.trim().startsWith('//')).join('\n');
  ok(!/['"]push['"]/.test(code), 'no push argument anywhere');
  ok(!/--force|forceWithLease/.test(code), 'no force flag anywhere');
  ok(!/remote/.test(code), 'no remote manipulation');
});
t('guard: refuses on a non-git directory', () => {
  const r = mkdtempSync(join(tmpdir(), 'ru-nogit-'));
  try {
    const v = guardRaw('preflight', r);
    ok(v.status !== 0, 'must refuse');
    ok(/not a git repository/.test(v.stderr), 'must say why');
  } finally { rmSync(r, { recursive: true, force: true }); }
});

// ───────────────────────── remediation ─────────────────────────
console.log('\nremediation');
function remediate(...a) { return runJson(process.execPath, [S('remediate.mjs'), ...a]); }

t('remediate: dry-run writes nothing', () => withFixture('single-node', r => {
  const before = readFileSync(join(r, 'package.json'), 'utf8');
  const v = remediate('node', r, '24.22.1', '--deps', 'none', '--raise-floor');
  ok(v.data, 'produced JSON');
  eq(v.data.mode, 'dry-run');
  ok(v.data.runtimePins.count >= 3, `expected >=3 pins, got ${v.data.runtimePins.count}`);
  eq(readFileSync(join(r, 'package.json'), 'utf8'), before, 'file must be byte-identical');
}));
t('remediate: rewrites every pin location for node', () => withFixture('single-node', r => {
  const v = remediate('node', r, '24.22.1', '--deps', 'none', '--raise-floor');
  const files = v.data.runtimePins.files.join(' ');
  ok(/package\.json/.test(files), 'engines'); ok(/\.nvmrc/.test(files), 'nvmrc'); ok(/Dockerfile/.test(files), 'Dockerfile');
  const docker = v.data.runtimePins.diffs.find(d => d.file === 'Dockerfile').diff;
  ok(/\+FROM node:24\.22\.1-alpine3\.22/.test(docker), 'alpine 3.19 must map forward to 3.22');
}));
t('remediate: every language has pin rules', () => {
  for (const a of adapters) ok(PIN_RULES[a.id], `${a.id} has no pin rules`);
});
t('remediate: pin rules are pure functions of the target', () => {
  // the same input must always produce the same edit — no hidden state
  for (const id of ['node', 'php', 'go', 'python']) {
    const a = PIN_RULES[id]('9.9.9'), b = PIN_RULES[id]('9.9.9');
    eq(a.map(r => r.rule), b.map(r => r.rule), `${id} rule set is stable`);
  }
});
t('remediate: refuses --apply when guard preflight fails', () => {
  const r = mkdtempSync(join(tmpdir(), 'ru-rem-'));
  try {
    run('git', ['init', '-q'], { cwd: r });
    run('git', ['config', 'user.email', 't@t'], { cwd: r });
    run('git', ['config', 'user.name', 'T'], { cwd: r });
    writeFileSync(join(r, 'package.json'), '{"name":"x","engines":{"node":">=18"}}');
    writeFileSync(join(r, '.nvmrc'), 'v18.20.0\n');
    run('git', ['add', '-A'], { cwd: r });
    run('git', ['commit', '-qm', 'init'], { cwd: r });
    const before = readFileSync(join(r, '.nvmrc'), 'utf8');
    const v = remediate('node', r, '24.22.1', '--deps', 'none', '--apply');   // still on master
    eq(v.data.refused, true, 'must refuse on a protected branch');
    eq(readFileSync(join(r, '.nvmrc'), 'utf8'), before, 'a refusal must not write');
  } finally { rmSync(r, { recursive: true, force: true }); }
});
t('remediate: --apply writes pins on a guarded branch', () => {
  const r = mkdtempSync(join(tmpdir(), 'ru-rem2-'));
  try {
    run('git', ['init', '-q'], { cwd: r });
    run('git', ['config', 'user.email', 't@t'], { cwd: r });
    run('git', ['config', 'user.name', 'T'], { cwd: r });
    writeFileSync(join(r, 'package.json'), '{"name":"x","engines":{"node":">= 18.x"}}');
    writeFileSync(join(r, '.nvmrc'), 'v18.20.0\n');
    run('git', ['add', '-A'], { cwd: r });
    run('git', ['commit', '-qm', 'init'], { cwd: r });
    runJson(process.execPath, [S('guard.mjs'), 'branch', r, 'node', '24.22.1']);
    const v = remediate('node', r, '24.22.1', '--deps', 'none', '--apply', '--raise-floor');
    eq(v.data.mode, 'apply');
    ok(!v.data.refused, 'must not refuse on a runtime/* branch');
    eq(readFileSync(join(r, '.nvmrc'), 'utf8').trim(), 'v24.22.1', 'nvmrc rewritten');
    ok(/">=24\.22"/.test(readFileSync(join(r, 'package.json'), 'utf8')), 'engines floor raised');
  } finally { rmSync(r, { recursive: true, force: true }); }
});
t('remediate: dotnet container tag uses MAJOR.MINOR, not the full SDK build', () => {
  const rules = PIN_RULES.dotnet('9.0.100');
  const docker = rules.find(r => r.rule === 'Dockerfile FROM');
  const out = docker.edit('FROM mcr.microsoft.com/dotnet/sdk:6.0 AS build\n');
  ok(/dotnet\/sdk:9\.0\b/.test(out) && !/9\.0\.100/.test(out), `got: ${out.trim()}`);
  const gj = rules.find(r => r.rule === 'sdk.version');
  // the FEATURE BAND is carried over, never invented: 6.0.418 -> 9.0.418.
  // Writing `.100` pins a build the project may not have, and under
  // `rollForward: patch` a wrong band is fatal.
  eq(JSON.parse(gj.edit('{"sdk":{"version":"6.0.418"}}')).sdk.version, '9.0.418');
});
t('remediate: global.json is never moved BACKWARDS', () => {
  // roslyn pins SDK 11.0.100-rc while the current RUNTIME release is 10.0.13 —
  // different number spaces. The rewrite emitted a downgrade and called it an
  // upgrade, fatal under roslyn's own rollForward: patch.
  const gj = PIN_RULES.dotnet('10.0.13').find(r => r.rule === 'sdk.version');
  const before = '{"sdk":{"version":"11.0.100-rc.1.26425.128","rollForward":"patch"}}';
  eq(gj.edit(before), before, 'an SDK already ahead of the runtime target must be left alone');
});
t('remediate: a compound constraint is named, never flattened', () => {
  // `>= 22 <25` -> `>=26.12` silently dropped a deliberate cap;
  // `>=8.1.0 <8.3 || ~8.4.2` -> `^8.5` destroyed a disjunction
  for (const [lang, field, value] of [['node', 'engines.node', '>= 22 <25'],
                                      ['node', 'engines.node', '^20 || ^22'],
                                      ['php', 'require.php', '>=8.1.0 <8.3 || ~8.4.2']]) {
    ok(isCompoundConstraint(value), `${value} should read as compound`);
    const r = PIN_RULES[lang]('26.12.1').find(x => x.rule === field);
    const before = lang === 'node' ? `{"engines":{"node":"${value}"}}` : `{"require":{"php":"${value}"}}`;
    eq(r.edit(before), before, `${value} must be left exactly as written`);
  }
  // and a simple floor still moves
  const simple = PIN_RULES.node('26.12.1').find(x => x.rule === 'engines.node');
  ok(/>=26\.12/.test(simple.edit('{"engines":{"node":">=20"}}')));
});
t('remediate: unified diff round-trips', () => {
  const before = 'a\nb\nc\n', after = 'a\nB\nc\n';
  const d = unified('f.txt', before, after);
  ok(/^--- a\/f\.txt/m.test(d) && /^\+\+\+ b\/f\.txt/m.test(d), 'headers');
  ok(/^-b$/m.test(d) && /^\+B$/m.test(d), 'the changed line appears on both sides');
});

// ───────────────────────── source scanning ─────────────────────────
console.log('\nsource breaking-change scan');
function scan(...a) { return runJson(process.execPath, [S('scan.mjs'), ...a]); }

t('scan: finds the severity classes inside the window', () => withFixture('breaking-src', r => {
  const v = scan('node', r, '20.11.1', '26.12.1');
  ok(v.data, 'produced JSON');
  const kinds = new Set(v.data.details.map(d => d.severity));
  ok(kinds.has('removed'), 'removed');
  ok(kinds.has('behaviour'), 'behaviour');
  // url.parse was deprecated in Node 16 — BEFORE the current version — so it is
  // not caused by this upgrade and must stay out of the window by default
  ok(!v.data.details.some(d => /url\.parse/.test(d.what)), 'pre-existing deprecations are excluded by default');
}));
t('scan: --include-existing surfaces pre-existing debt separately', () => withFixture('breaking-src', r => {
  const v = scan('node', r, '20.11.1', '26.12.1', '--include-existing');
  ok(v.data.preExistingRules > 0, 'pre-existing rules were applied');
  const pre = v.data.details.filter(d => d.preExisting);
  ok(pre.some(d => /url\.parse/.test(d.what)), 'url.parse surfaces as pre-existing');
  ok(v.data.causedByThisUpgrade < v.data.findings, 'and is counted apart from this upgrade');
  ok(/NOT caused by this upgrade/.test(v.data.preExistingNote), 'and is labelled as such');
}));
t('scan: reports file and line, not just a count', () => withFixture('breaking-src', r => {
  const v = scan('node', r, '20.11.1', '26.12.1');
  const f = v.data.details.find(d => d.severity === 'removed');
  ok(/removed\.js$/.test(f.file), `file: ${f.file}`);
  ok(f.line >= 1, 'line number');
  ok(f.evidence.length > 0, 'evidence line');
  ok(f.fix && f.fix.length > 5, 'a fix is suggested');
}));
t('scan: respects the upgrade window', () => withFixture('breaking-src', r => {
  const wide = scan('node', r, '10.0.0', '26.12.1').data.rulesApplied;
  const narrow = scan('node', r, '24.0.0', '26.12.1').data.rulesApplied;
  ok(narrow < wide, `narrow window must apply fewer rules (${narrow} vs ${wide})`);
}));
t('scan: clean files produce no findings', () => withFixture('single-node', r => {
  const v = scan('node', r, '20.11.1', '24.22.1');
  eq(v.data.findings, 0, 'nothing to find in a fixture with no source');
}));
t('scan: says "not catalogued" rather than "nothing breaks"', () => withFixture('single-rust', r => {
  // every language now has a catalogue, so the honest-note path is reached when
  // the WINDOW contains no rules — a narrow upgrade, not an unknown language
  const v = scan('rust', r, '1.98', '1.99');
  eq(v.data.windowRules, 0, 'no rule falls inside this window');
  ok(/not catalogued|NOT "nothing breaks"/i.test(v.data.note || ''), 'must not imply safety');
}));
t('scan: a wide window DOES apply the rust catalogue', () => withFixture('single-rust', r => {
  const v = scan('rust', r, '1.20', '1.99');
  ok(v.data.windowRules >= 4, `expected the rust catalogue to apply, got ${v.data.windowRules}`);
}));

// ───────────── comment/string stripping (the false-positive fix) ─────────────
console.log('\ncode-only matching');
t('strip: comments cannot produce findings', () => {
  // every one of these was a real false positive against a real repo
  const cases = [
    ['scala',  "/** `Const`'s second parameter */\nval x = 1\n",           /'s/],
    ['java',   "/** Disables JDK's {@code sun.misc.Unsafe}. */\nint x;\n", /sun\.misc\.Unsafe/],
    ['elixir', "# the 'fetch_' prefix\nx = 1\n",                            /'fetch_'/],
    ['python', '# uses imp and distutils\nx = 1\n',                         /distutils/],
    ['go',     '// io/ioutil is mentioned here\nvar x int\n',               /ioutil/],
    ['rust',   '// try! is mentioned\nlet x = 1;\n',                        /try!/],
  ];
  for (const [lang, src, re] of cases) {
    const out = stripNonCode(src, lang);
    ok(!re.test(out), `${lang}: comment content survived stripping -> ${JSON.stringify(out)}`);
  }
});
t('strip: real code is never blanked', () => {
  ok(/crypto\.createCipher/.test(stripNonCode('crypto.createCipher("aes", k);\n', 'node')), 'node call survives');
  ok(/Deno\.run/.test(stripNonCode('const p = Deno.run({cmd});\n', 'deno')), 'deno call survives');
  ok(/SecurityManager/.test(stripNonCode('SecurityManager s = null;\n', 'java')), 'java type survives');
});
t('strip: line numbers are preserved exactly', () => {
  const src = '// comment line one\n// comment line two\ncrypto.createCipher(x);\n';
  const out = stripNonCode(src, 'node');
  eq(out.split('\n').length, src.split('\n').length, 'line count unchanged');
  eq(out.split('\n')[2], src.split('\n')[2], 'the code line is byte-identical');
});
t('strip: elixir keeps single-quoted charlists, blanks double-quoted strings', () => {
  // the charlist IS the thing being detected, so it must survive
  const out = stripNonCode(`x = 'charlist'\ny = "a string with 'quotes'"\n`, 'elixir');
  ok(/'charlist'/.test(out), 'charlist survives');
  ok(!/a string/.test(out), 'double-quoted string is blanked');
});
t('strip: perl POD blocks are blanked', () => {
  const out = stripNonCode('=head1 NAME\n\nuses ~~ in prose\n\n=cut\nmy $x = 1;\n', 'perl');
  ok(!/in prose/.test(out), 'POD content blanked');
  ok(/my \$x = 1;/.test(out), 'code survives');
});
t('strip: triple-quoted blocks are handled before single quotes', () => {
  const out = stripNonCode('x = """\ndistutils\n"""\ny = 1\n', 'python');
  ok(!/distutils/.test(out), 'docstring blanked');
  ok(/y = 1/.test(out), 'code survives');
});
t('strip: scanner finds code hits but not comment hits', () => {
  const r = mkdtempSync(join(tmpdir(), 'ru-strip-'));
  try {
    writeFileSync(join(r, 'package.json'), '{"name":"s","engines":{"node":">=20"}}');
    writeFileSync(join(r, 'a.js'), '// crypto.createCipher is mentioned here\nconst ok = 1;\n');
    writeFileSync(join(r, 'b.js'), 'const c = crypto.createCipher("aes", k);\n');
    const v = runJson(process.execPath, [S('scan.mjs'), 'node', r, '20.11.1', '26.12.1']);
    const files = v.data.details.map(d => d.file);
    ok(files.includes('b.js'), 'real usage found');
    ok(!files.includes('a.js'), 'comment mention NOT reported');
  } finally { rmSync(r, { recursive: true, force: true }); }
});

// ───────────── language coverage ─────────────
console.log('\nbreaking-change catalogue');
t('rules: every language has a catalogue or an explicit inheritance', () => {
  for (const a of adapters) {
    const own = (RULES[a.id] || []).length;
    const inherits = inheritedCatalogue(a.id);
    ok(own > 0 || inherits, `${a.id} has neither rules nor an inherited catalogue`);
  }
});
t('rules: bun inherits the node catalogue', () => {
  eq(inheritedCatalogue('bun'), 'node');
  ok(rulesFor('node', null, null).length > 0, 'and node has rules to inherit');
});
t('rules: every rule has a severity, a description and a fix', () => {
  for (const [lang, rs] of Object.entries(RULES))
    for (const r of rs) {
      ok(['removed', 'runtime', 'behaviour'].includes(r.severity), `${lang}: bad severity ${r.severity}`);
      ok(r.what && r.what.length > 10, `${lang}: ${r.what} is not a description`);
      ok(r.fix && r.fix.length > 5, `${lang}: rule "${r.what}" has no fix`);
      ok(r.re instanceof RegExp, `${lang}: ${r.what} has no pattern`);
    }
});
t('rules: each new language catalogue actually matches its own syntax', () => {
  const samples = {
    deno:   ['const p = Deno.run({cmd: ["ls"]});', 6],
    elixir: ['Logger.warn("x")', 2],
    erlang: ['random:uniform(10).', 2],
    rust:   ['let x = std::mem::uninitialized::<u8>();', 5],
    kotlin: ['val v = enumValues<Foo>()', 3],
    scala:  ['def f() { println(1) }', 4],
    perl:   ['my $r = $a ~~ $b;', 2],
  };
  for (const [lang, [src, expectRules]] of Object.entries(samples)) {
    const rs = rulesFor(lang, null, null);
    ok(rs.length >= expectRules, `${lang}: only ${rs.length} rules`);
    const code = stripNonCode(src, lang);
    ok(rs.some(r => new RegExp(r.re.source, r.re.flags.replace('g', '')).test(code)),
       `${lang}: no rule matched its own sample "${src}"`);
  }
});

// ───────────── floors are not pins (judge findings) ─────────────
// An adversarial judge ran the tool against 10 real repos. Its headline finding:
// the write stage rewrote consumer-facing FLOORS as if they were pins, making
// semver-breaking support-contract changes to four published libraries and
// breaking each one's own CI matrix. These lock that shut.
console.log('\nfloors are not pins');
t('floor: a consumer-facing minimum is NOT rewritten by default', () => withFixture('single-node', r => {
  const v = remediate('node', r, '24.22.1', '--deps', 'none');
  const files = v.data.runtimePins.files.join(' ');
  ok(!/engines\.node/.test(files), `engines.node must not be written by default: ${files}`);
  ok(v.data.runtimePins.declinedFloors.some(f => /engines\.node/.test(f.rule)), 'and it must be reported as declined');
  ok(v.data.runtimePins.declinedFloors[0].why.length > 60, 'with a real reason');
}));
t('floor: pins ARE still written by default', () => withFixture('single-node', r => {
  const v = remediate('node', r, '24.22.1', '--deps', 'none');
  const files = v.data.runtimePins.files.join(' ');
  ok(/\.nvmrc/.test(files), `.nvmrc is a pin and must still move: ${files}`);
  ok(/Dockerfile/.test(files), 'and so is a Dockerfile tag');
}));
t('floor: --raise-floor opts in explicitly', () => withFixture('single-node', r => {
  const v = remediate('node', r, '24.22.1', '--deps', 'none', '--raise-floor');
  ok(v.data.runtimePins.files.join(' ').includes('package.json'), 'the floor moves when asked');
  eq(v.data.runtimePins.raiseFloor, true);
}));
t('floor: engines.node NEVER gains an upper cap', () => {
  // prettier got ">=26.12.1 <27" — refusing every future Node forever
  const rule = PIN_RULES.node('26.12.1').find(x => x.rule === 'engines.node');
  const out = rule.edit('{"engines":{"node":">=22"}}');
  ok(!/</.test(out.replace(/[{}":,]/g, '')), `no upper bound: ${out}`);
  ok(/>=26\.12/.test(out), out);
  ok(!/26\.12\.1/.test(out), 'a floor is major.minor, not a patch pin');
});
t('floor: every library-facing rule is classified as a floor', () => {
  for (const rule of ['engines.node', 'require.php', 'requires-python',
                      'gemspec required_ruby_version', 'rust-version (MSRV)', 'go directive'])
    eq(ruleKind(rule), 'floor', rule);
  for (const rule of ['.nvmrc', '.python-version', '.ruby-version', 'Dockerfile FROM'])
    eq(ruleKind(rule), 'pin', rule);
});

console.log('\n.NET target frameworks');
t('tfm: net46 is .NET Framework 4.6, not version 46', () => {
  const a = byId.dotnet;
  const r = mkdtempSync(join(tmpdir(), 'ru-tfm-'));
  try {
    writeFileSync(join(r, 'x.csproj'), '<Project><PropertyGroup><TargetFrameworks>net46;net10.0</TargetFrameworks></PropertyGroup></Project>');
    const o = a.scan({ dir: r, root: r, dockerImages: [], ciText: '' });
    ok(o.declaredMajors.split(',').includes('4.6'), `net46 -> 4.6, got [${o.declaredMajors}]`);
    ok(!o.declaredMajors.split(',').includes('46'), 'never 46');
    ok(o.netFrameworkTfms.includes('net46'), 'and it is flagged as .NET Framework');
  } finally { rmSync(r, { recursive: true, force: true }); }
});
t('tfm: a conditional TargetFrameworks element is read', () => {
  const r = mkdtempSync(join(tmpdir(), 'ru-tfm2-'));
  try {
    // Newtonsoft.Json's flagship project uses this form and was missed entirely
    writeFileSync(join(r, 'x.csproj'),
      '<Project><PropertyGroup>\n<TargetFrameworks Condition="\'$(LibraryFrameworks)\'==\'\'">net10.0;net8.0;netstandard2.0</TargetFrameworks>\n</PropertyGroup></Project>');
    const o = byId.dotnet.scan({ dir: r, root: r, dockerImages: [], ciText: '' });
    ok(o.declaredMajors.split(',').includes('10'), `got [${o.declaredMajors}]`);
    ok(!/\$\(/.test(o.declared.targetFramework), 'MSBuild variables are not treated as versions');
  } finally { rmSync(r, { recursive: true, force: true }); }
});

console.log('\ntarget selection sanity');
await ta('target: never proposes a version supported for LESS time', async () => {
  if (!reach.data) return 'skip';
  // Java 27 is non-LTS (EOL 2027-04); Java 17 runs to 2029-10. "Upgrading"
  // there shortens the support window by 2.5 years.
  const r = runJson(process.execPath, [S('research.mjs'), 'java', '17']);
  ok(r.data, 'produced JSON');
  eq(r.data.target.supportedLongerThanCurrent, true,
     `${r.data.current.eol} -> ${r.data.target.eol}`);
  ok(r.data.target.eol > r.data.current.eol, 'the target must outlive the current');
});
await ta('target: an integer-major runtime gets a plain major', async () => {
  if (!reach.data) return 'skip';
  const r = runJson(process.execPath, [S('research.mjs'), 'java', '17']);
  ok(/^\d+$/.test(r.data.target.version), `a JDK distribution build string leaked: ${r.data.target.version}`);
});

console.log('\ndiscovery noise and scope');
t('noise: fixtures and .github trees are separated, not counted as work', () => {
  const r = mkdtempSync(join(tmpdir(), 'ru-noise-'));
  try {
    writeFileSync(join(r, 'package.json'), '{"name":"x","engines":{"node":">=20"}}');
    for (const sub of ['test/bundler/esbuild', '.github/codeql/tests/x', '.devcontainer']) {
      mkdirSync(join(r, sub), { recursive: true });
      writeFileSync(join(r, sub, 'package.json'), '{"name":"fixture"}');
    }
    const d = runJson(process.execPath, [S('detect.mjs'), r]);
    eq(d.data.targetCount, 1, 'only the real package counts');
    ok(d.data.ancillaryTargets.length >= 3, `fixtures reported separately: ${d.data.ancillaryTargets.length}`);
    ok(d.data.ancillaryNote && /not deployables/.test(d.data.ancillaryNote), 'and explained');
  } finally { rmSync(r, { recursive: true, force: true }); }
});
t('noise: a CI matrix written as a list is read', () => {
  const r = mkdtempSync(join(tmpdir(), 'ru-mx-'));
  try {
    writeFileSync(join(r, 'package.json'), '{"name":"x"}');
    mkdirSync(join(r, '.github', 'workflows'), { recursive: true });
    // the list form is the most common matrix spelling and was invisible
    writeFileSync(join(r, '.github/workflows/ci.yml'),
      'jobs:\n  t:\n    strategy:\n      matrix:\n        node-version: [24, 26]\n');
    const d = runJson(process.execPath, [S('detect.mjs'), r]);
    const t2 = d.data.targets.find(x => x.lang === 'node');
    ok(t2.ciMatrix && t2.ciMatrix.includes('24') && t2.ciMatrix.includes('26'),
       `matrix list not read: ${JSON.stringify(t2.ciMatrix)}`);
  } finally { rmSync(r, { recursive: true, force: true }); }
});
t('noise: a plan with nothing actionable explains itself', () => {
  const r = mkdtempSync(join(tmpdir(), 'ru-empty-'));
  try {
    writeFileSync(join(r, 'package.json'), '{"name":"x"}');     // no engines anywhere
    const v = runJson(process.execPath, [S('plan.mjs'), r]);
    eq(v.data.plans.length, 0);
    ok(v.data.nothingActionable, 'an empty plan must say why');
    ok(v.data.nothingActionable.guidance.length > 40, 'with guidance');
    ok(v.data.nothingActionable.targetsFound >= 1, 'and admit it DID find targets');
  } finally { rmSync(r, { recursive: true, force: true }); }
});
t('scope: no pin is invented where sub-packages already declare one', () => {
  const r = mkdtempSync(join(tmpdir(), 'ru-ws-'));
  try {
    run('git', ['init', '-q'], { cwd: r });
    // a Rust workspace root has no [package] and so declares no rust-version;
    // creating rust-toolchain.toml there overrides every member
    writeFileSync(join(r, 'Cargo.toml'), '[workspace]\nmembers = ["a"]\n');
    mkdirSync(join(r, 'a'), { recursive: true });
    writeFileSync(join(r, 'a', 'Cargo.toml'), '[package]\nname = "a"\nrust-version = "1.85"\n');
    const v = runJson(process.execPath, [S('remediate.mjs'), 'rust', r, '1.99', '--deps', 'none']);
    eq(v.data.runtimePins.count, 0, 'nothing invented at the root');
    ok(v.data.runtimePins.declaredElsewhere?.length, 'and it names where the runtime IS declared');
    ok(!existsSync(join(r, 'rust-toolchain.toml')), 'no toolchain file created');
  } finally { rmSync(r, { recursive: true, force: true }); }
});

function walkMjs(d, out = []) {
  for (const e of readdirSync(d, { withFileTypes: true })) {
    const p = join(d, e.name);
    if (e.isDirectory()) walkMjs(p, out);
    else if (e.name.endsWith('.mjs')) out.push(p);
  }
  return out;
}
// ───────────── "nothing was run" must mean nothing was run ─────────────
console.log('\nrefusals are total');
t('deps: a REFUSED upgrade does not regenerate the lockfile either', () => {
  // the refusal reported "Nothing was run" and then ran `go mod tidy` on the
  // vendored kubernetes tree, mutating go.sum and attempting `go mod vendor`
  const src = readFileSync(S('remediate.mjs'), 'utf8');
  ok(/const lockAllowed = DEPS !== 'none' && !deps\.refused;/.test(src),
     'the lockfile step must be gated on the refusal AND on --deps none');
  ok(/regenerating the lockfile would mutate resolution anyway/.test(src));
});
t('deps: --deps none never touches the lockfile', () => {
  const r = mkdtempSync(join(tmpdir(), 'ru-lockn-'));
  try {
    writeFileSync(join(r, 'go.mod'), 'module x\n\ngo 1.21\n');
    writeFileSync(join(r, 'go.sum'), '');
    const v = runJson(process.execPath, [S('remediate.mjs'), 'go', r, '1.24.0', '--deps', 'none']);
    // dry-run reports what it WOULD do; the skip reason must already be visible
    ok(v.data, 'produced JSON');
  } finally { rmSync(r, { recursive: true, force: true }); }
});

console.log('\nDockerfile images are matched whole');
t('docker: a compound tag from another product is left alone', () => {
  // `dunglas/frankenphp:1.12.1-php8.3` had FrankenPHP's own version replaced
  // with a PHP one, leaving the stale `-php8.3` suffix: an image that does not exist
  const php = PIN_RULES.php('8.4.1').find(r => r.file === 'Dockerfile');
  eq(php.edit('FROM dunglas/frankenphp:1.12.1-php8.3\n').trim(),
     'FROM dunglas/frankenphp:1.12.1-php8.3');
  const node = PIN_RULES.node('24.1.0').find(r => r.file === 'Dockerfile');
  eq(node.edit('FROM mynode-tools:1.2.3\n').trim(), 'FROM mynode-tools:1.2.3');
});
t('docker: a genuine image still moves, suffix and registry intact', () => {
  const php = PIN_RULES.php('8.4.1').find(r => r.file === 'Dockerfile');
  ok(/php:8\.4\.1-fpm-alpine/.test(php.edit('FROM php:8.3-fpm-alpine3.19\n')));
  ok(/registry\.example\.com:5000\/php:8\.4\.1/.test(
    php.edit('FROM registry.example.com:5000/php:8.3\n')), 'a registry port is not a tag');
  const node = PIN_RULES.node('24.1.0').find(r => r.file === 'Dockerfile');
  ok(/node:24\.1\.0-alpine3\.2\d/.test(node.edit('FROM node:20-alpine3.19\n')), 'and the suffix maps');
});
t('docker: a templated tag is never written into', () => {
  const php = PIN_RULES.php('8.4.1').find(r => r.file === 'Dockerfile');
  eq(php.edit('FROM php:${PHP_VERSION}\n').trim(), 'FROM php:${PHP_VERSION}');
});

console.log('\nconfig edits never go backwards');
t('config: tsconfig ESNext is not downgraded to a dated target', () => {
  const r = mkdtempSync(join(tmpdir(), 'ru-ts-'));
  try {
    for (const [cur, want] of [['ES2019', 'ES2023'], ['ES2022', 'ES2023'],
                               ['ES2023', null], ['ESNext', null]]) {
      writeFileSync(join(r, 'tsconfig.json'), JSON.stringify({ compilerOptions: { target: cur } }, null, 2));
      const e = planConfigEdits('node', r, '24.1.0').find(x => x.file === 'tsconfig.json');
      if (want === null) eq(e, undefined, `${cur} must be left alone, not rewritten`);
      else eq(JSON.parse(e.after).compilerOptions.target, want, cur);
    }
  } finally { rmSync(r, { recursive: true, force: true }); }
});
t('pins: volta.node moves with the other pins', () => {
  // left behind while engines and .nvmrc move, volta.node IS the drift
  const v = PIN_RULES.node('24.1.0').find(r => r.rule === 'volta.node');
  ok(v, 'there must be a volta rule at all');
  const out = JSON.parse(v.edit('{"name":"x","volta":{"node":"20.11.1","npm":"10.2.0"}}'));
  eq(out.volta.node, '24.1.0');
  eq(out.volta.npm, '10.2.0', 'and nothing else in the block is touched');
});
t('pins: .nvmrc keeps the author\'s v prefix, either way', () => {
  const n = PIN_RULES.node('24.1.0').find(r => r.rule === '.nvmrc');
  eq(n.edit('v20.11.1\n'), 'v24.1.0\n');
  eq(n.edit('20.11.1\n'), '24.1.0\n');
});

console.log('\nverify sees a cap, not just a floor');
t('verify: a caret constraint the target breaches is a failure', () => {
  // composer `^7.4` means ">=7.4 <8" and forbids 8.3, but detect exports plain
  // majors, so "7.4" vs "8.3" read as an ordinary floor below the target
  const cases = [['^7.4', '8.3', 'fail'], ['^8.3', '8.3', 'pass'],
                 ['>=7.4', '8.3', 'pass'], ['~8.3', '8.3', 'pass']];
  for (const [constraint, target, want] of cases) {
    const r = mkdtempSync(join(tmpdir(), 'ru-vcap-'));
    try {
      writeFileSync(join(r, 'composer.json'), `{"name":"x","require":{"php":"${constraint}"}}`);
      // `gate`/`verifyOf` are declared further down this file — a const is in
      // the temporal dead zone above its declaration, so call the script directly
      const data = runJson(process.execPath, [S('verify.mjs'), 'php', r, target]).data;
      const g = (data.gates || []).find(x => x.name.includes('declared version matches target'));
      eq(g.status, want, `${constraint} vs ${target}: ${g.detail}`);
      if (want === 'fail') ok(/deliberately capped/.test(g.detail), g.detail);
    } finally { rmSync(r, { recursive: true, force: true }); }
  }
});

// ───────────── a flag's value is not a positional ─────────────
console.log('\nargument parsing');
t('argv: a value flag does not leak into the positionals', () => {
  const a = parseArgv(['node', '/d', '20', '--max', '50'], ['max']);
  eq(JSON.stringify(a.positional), JSON.stringify(['node', '/d', '20']));
  eq(a.flag('max'), '50');
});
t('argv: --flag=value works too', () => {
  const a = parseArgv(['/d', '--target=26.12.1'], ['target']);
  eq(a.flag('target'), '26.12.1');
  eq(JSON.stringify(a.positional), JSON.stringify(['/d']));
});
t('argv: a boolean flag consumes nothing', () => {
  const a = parseArgv(['/d', '--apply', 'extra'], ['target']);
  eq(JSON.stringify(a.positional), JSON.stringify(['/d', 'extra']));
  eq(a.has('apply'), true);
});
t('scan: --max is not mistaken for the target version', () => {
  // `scan java <dir> 17 --max 50` silently scanned the window 17 -> "50"
  const r = mkdtempSync(join(tmpdir(), 'ru-argv-'));
  try {
    writeFileSync(join(r, 'package.json'), '{"name":"x","engines":{"node":">=20"},"dependencies":{"a":"1"}}');
    const bad = run(process.execPath, [S('scan.mjs'), 'node', r, '20', '--max', '50']);
    ok(bad.status !== 0, 'a missing target must be refused, not invented');
    ok(/usage/.test(bad.stderr), bad.stderr.slice(0, 100));
    const good = runJson(process.execPath, [S('scan.mjs'), 'node', r, '20', '26.12.1', '--max', '7']);
    eq(good.data.to, '26.12.1');
  } finally { rmSync(r, { recursive: true, force: true }); }
});
t('plan: --target before the directory still resolves the directory', () => {
  // `plan.mjs --target 21 <dir>` resolved "21" as the dir
  const r = mkdtempSync(join(tmpdir(), 'ru-argv2-'));
  try {
    writeFileSync(join(r, 'package.json'), '{"name":"x","engines":{"node":">=20"},"dependencies":{"a":"1"}}');
    const v = runJson(process.execPath, [S('plan.mjs'), '--target', '26.12.1', r, '--json']);
    ok(v.data, 'plan produced JSON');
    eq(v.data.plans[0].target, '26.12.1');
    ok(v.data.root.endsWith(r.split('/').pop()), v.data.root);
  } finally { rmSync(r, { recursive: true, force: true }); }
});

// ───────────── advice addressed to the right language ─────────────
console.log('\nper-language hints');
t('verify: every language gets its OWN deprecation advice', () => {
  // node got node advice and EVERY other language got the PHP one, so a Go,
  // Python or .NET run was told about E_DEPRECATED
  const src = readFileSync(S('verify.mjs'), 'utf8');
  for (const lang of ['node', 'php', 'python', 'ruby', 'go', 'rust', 'java', 'dotnet'])
    ok(src.includes('\n    ' + lang + ': ['), lang + ' has no hint of its own');
  ok(/a clean build checks shape, never behaviour/.test(src), 'and the fallback must stay honest');
});
t('verify: a go run is not told about E_DEPRECATED', () => {
  const r = mkdtempSync(join(tmpdir(), 'ru-hint-'));
  try {
    writeFileSync(join(r, 'go.mod'), 'module x\n\ngo 1.22\n');
    const v = runJson(process.execPath, [S('verify.mjs'), 'go', r, '1.24.0']).data;
    ok(!(v.hints || []).some(h => /E_DEPRECATED/.test(h)), JSON.stringify(v.hints));
    ok((v.hints || []).some(h => /go vet/.test(h)), JSON.stringify(v.hints));
  } finally { rmSync(r, { recursive: true, force: true }); }
});
t('guard: the phase is not prefixed twice', () => {
  const src = readFileSync(S('guard.mjs'), 'utf8');
  ok(/startsWith\(phase\.toLowerCase\(\) \+ ':'\)/.test(src),
     '`-m "runtime: x" --phase runtime` produced "runtime: runtime: x"');
});
t('guard: a manifest pairs with a lockfile only in the SAME directory', () => {
  const src = readFileSync(S('guard.mjs'), 'utf8');
  ok(/const dirOf = /.test(src) && /byDir/.test(src),
     'basename matching paired any go.mod with any go.sum across a monorepo');
});

// ───────────── an empty list must not read as "clean" ─────────────
console.log('\nnot checked is not clean');
t('assess: every language says whether native artefacts were enumerated', () => {
  // `nativeAddons: []` read as "no blockers" on languages this script cannot
  // enumerate, and SKILL.md calls that the highest-value output
  const r = mkdtempSync(join(tmpdir(), 'ru-ne-'));
  try {
    const cases = [['python', 'pyproject.toml', '[project]\nname="x"\nrequires-python=">=3.11"\n'],
                   ['ruby', 'Gemfile', "ruby '3.3.5'\n"],
                   ['php', 'composer.json', '{"require":{"php":"^8.3"}}']];
    for (const [lang, file, body] of cases) {
      writeFileSync(join(r, file), body);
      const v = runJson(process.execPath, [S('assess.mjs'), lang, r, '99.0.0']).data;
      ok(v, `${lang} produced no JSON`);
      eq(v.nativeEnumerated, false, `${lang} must say it did not enumerate`);
      ok((v.notes || []).some(n => /not because nothing was found|do not apply here/.test(n)),
         `${lang} must explain the empty list: ${JSON.stringify(v.notes)}`);
      rmSync(join(r, file), { force: true });
    }
  } finally { rmSync(r, { recursive: true, force: true }); }
});
t('assess: node without node_modules reports NOT enumerated', () => {
  const r = mkdtempSync(join(tmpdir(), 'ru-nonm-'));
  try {
    writeFileSync(join(r, 'package.json'), '{"name":"x","dependencies":{"a":"1"}}');
    const v = runJson(process.execPath, [S('assess.mjs'), 'node', r, '26.12.1']).data;
    eq(v.nativeEnumerated, false, 'nothing was inspected');
    ok((v.notes || []).some(n => /NOT run/.test(n)), JSON.stringify(v.notes));
  } finally { rmSync(r, { recursive: true, force: true }); }
});
t('plan: assess caveats reach the plan', () => {
  // plan dropped assess.notes entirely, so on the one repo where N-API
  // classification is the headline risk it showed no blocker and no hint
  const src = readFileSync(S('plan.mjs'), 'utf8');
  ok(/assessCaveats/.test(src));
  ok(/nativeEnumerated: a\?\./.test(src));
});

console.log('\na declared cap is the project saying no');
t('plan: a target breaching a declared cap is a blocker', () => {
  // grafana declares `engines.node ">= 22 <25"`; the plan targeted 26 with zero
  // blockers and the string `<25` appeared nowhere in 59 plans
  const r = mkdtempSync(join(tmpdir(), 'ru-cap-'));
  try {
    writeFileSync(join(r, 'package.json'), '{"name":"g","engines":{"node":">= 22 <25"},"dependencies":{"x":"1"}}');
    const p = runJson(process.execPath, [S('plan.mjs'), r, '--json', '--target', '26.12.1']).data;
    const b = (p.plans[0].blockers || []).find(x => x.kind === 'declared-constraint-breached');
    ok(b, `no cap blocker: ${JSON.stringify(p.plans[0].blockers)}`);
    eq(p.plans[0].verdict, 'blocked');
    ok(/deliberately capped/.test(b.detail));
  } finally { rmSync(r, { recursive: true, force: true }); }
});
t('plan: a plain floor below the target is NOT a cap breach', () => {
  const r = mkdtempSync(join(tmpdir(), 'ru-nocap-'));
  try {
    writeFileSync(join(r, 'package.json'), '{"name":"g","engines":{"node":">= 20"},"dependencies":{"x":"1"}}');
    const p = runJson(process.execPath, [S('plan.mjs'), r, '--json', '--target', '26.12.1']).data;
    eq((p.plans[0].blockers || []).filter(x => x.kind === 'declared-constraint-breached').length, 0,
       'a floor is satisfied by a higher target, by definition');
  } finally { rmSync(r, { recursive: true, force: true }); }
});

// ───────────── a pin without a version number is still a pin ─────────────
console.log('\nunversioned pins');
t('rust: a dated nightly is a pin, not "nothing declared"', () => {
  // next.js pins nightly-2026-10-06; because the major regex needs digit.digit,
  // all 64 of its Rust targets reported that nothing enforced a version
  const r = mkdtempSync(join(tmpdir(), 'ru-nightly-'));
  try {
    writeFileSync(join(r, 'Cargo.toml'), '[package]\nname="x"\nversion="0.1.0"\n');
    writeFileSync(join(r, 'rust-toolchain.toml'), '[toolchain]\nchannel = "nightly-2026-10-06"\n');
    const d = runJson(process.execPath, [S('detect.mjs'), r, '--json']).data;
    eq(d.undeclaredCount, 0, 'the toolchain IS enforced');
    eq((d.unversionedPins || []).length, 1);
    eq(d.unversionedPins[0].channel, 'nightly-2026-10-06');
    ok(/port, not a bump/.test(d.unversionedPins[0].meaning),
       'and moving to stable must be described as a port');
  } finally { rmSync(r, { recursive: true, force: true }); }
});
t('rust: a nested crate inherits the toolchain file from above', () => {
  // rustup resolves the file by walking upward; reading only the crate's own
  // directory left 62 of 64 next.js crates looking unpinned
  const r = mkdtempSync(join(tmpdir(), 'ru-inherit-'));
  try {
    writeFileSync(join(r, 'Cargo.toml'), '[workspace]\nmembers = ["crates/a"]\n');
    writeFileSync(join(r, 'rust-toolchain.toml'), '[toolchain]\nchannel = "nightly-2026-10-06"\n');
    mkdirSync(join(r, 'crates/a'), { recursive: true });
    writeFileSync(join(r, 'crates/a/Cargo.toml'),
      '[package]\nname="a"\nversion="0.1.0"\n\n[dependencies]\nserde = "1"\n');
    const d = runJson(process.execPath, [S('detect.mjs'), r, '--json']).data;
    const nested = (d.unversionedPins || []).find(p => p.dir === 'crates/a');
    ok(nested, `nested crate not covered: ${JSON.stringify((d.unversionedPins || []).map(p => p.dir))}`);
    eq(nested.inheritedFrom, '.', 'and must say where the file came from');
  } finally { rmSync(r, { recursive: true, force: true }); }
});
t('rust: a floating `stable` channel is reported as floating', () => {
  const r = mkdtempSync(join(tmpdir(), 'ru-float-'));
  try {
    writeFileSync(join(r, 'Cargo.toml'), '[package]\nname="x"\nversion="0.1.0"\n');
    writeFileSync(join(r, 'rust-toolchain.toml'), '[toolchain]\nchannel = "stable"\n');
    const d = runJson(process.execPath, [S('detect.mjs'), r, '--json']).data;
    ok(/floats/.test(d.unversionedPins[0].meaning), d.unversionedPins[0].meaning);
  } finally { rmSync(r, { recursive: true, force: true }); }
});

// ───────────── two rules, one file ─────────────
console.log('\nedits to the same file compose');
t('pins: rules touching the same file are chained, not raced', () => {
  // go.mod carries BOTH the `go` directive and the `toolchain` line. Each rule
  // read the original text independently, so the writes raced and the last one
  // won — the directive edit vanished and go.mod contradicted itself.
  const r = mkdtempSync(join(tmpdir(), 'ru-chain-'));
  try {
    writeFileSync(join(r, 'go.mod'), 'module x\n\ngo 1.21\n\ntoolchain go1.21.13\n');
    const { edits } = planPinEdits('go', r, '1.22.5', { raiseFloor: true });
    const gomod = edits.filter(e => e.file === 'go.mod');
    eq(gomod.length, 1, 'one edit per file, carrying every rule');
    ok(/go 1\.22/.test(gomod[0].after), gomod[0].after);
    ok(/toolchain go1\.22\.5/.test(gomod[0].after), gomod[0].after);
    ok(gomod[0].rules.length >= 2, `both rules must be recorded: ${JSON.stringify(gomod[0].rules)}`);
    ok(gomod[0].after.endsWith('\n'), 'and the trailing newline must survive');
  } finally { rmSync(r, { recursive: true, force: true }); }
});
t('pins: go rewrites its real PINS by default, floor declined', () => {
  // the `go` directive is a floor; `toolchain` and `.go-version` are the pins.
  // With no pin rules at all, a default `remediate go` rewrote nothing.
  const r = mkdtempSync(join(tmpdir(), 'ru-gopin-'));
  try {
    writeFileSync(join(r, 'go.mod'), 'module x\n\ngo 1.21\n\ntoolchain go1.21.13\n');
    writeFileSync(join(r, '.go-version'), '1.21.13\n');
    const out = planPinEdits('go', r, '1.22.5');
    const touched = out.edits.map(e => e.file).sort();
    eq(JSON.stringify(touched), JSON.stringify(['.go-version', 'go.mod']));
    ok(!/go 1\.22\b/.test(out.edits.find(e => e.file === 'go.mod').after.match(/^go .*/m)[0]),
       'the FLOOR must stay put without --raise-floor');
    eq(out.declinedFloors[0].rule, 'go directive');
  } finally { rmSync(r, { recursive: true, force: true }); }
});

console.log('\nnative addons: every packaging convention');
t('addons: all four ABI conventions are recognised as pinned', () => {
  // only `addon-115.node` was. The misses are the dangerous direction: an
  // unmarked ABI-pinned binary segfaults at require() time.
  const r = mkdtempSync(join(tmpdir(), 'ru-abi-'));
  const mk = (name, sub, file, extra = {}) => {
    mkdirSync(join(r, 'node_modules', name, sub), { recursive: true });
    writeFileSync(join(r, 'node_modules', name, 'package.json'),
      JSON.stringify({ name, version: '1.0.0', ...extra }));
    writeFileSync(join(r, 'node_modules', name, sub, file), '');
  };
  try {
    writeFileSync(join(r, 'package.json'), '{"name":"t","dependencies":{}}');
    mk('pregyp', 'lib/binding/node-v115-linux-x64', 'mod.node');      // node-pre-gyp
    mk('prebuildify', 'prebuilds/linux-x64', 'node.abi115.node');     // prebuildify
    mk('gypstyle', 'build/Release', 'addon-115.node');                // node-gyp
    mk('napifile', 'prebuilds/linux-x64', 'node.napi.node');          // prebuild, N-API
    mk('napidecl', 'build/Release', 'x.node', { binary: { napi_versions: [8] } });
    const v = runJson(process.execPath, [S('assess.mjs'), 'node', r, '26.12.1']).data;
    const by = Object.fromEntries((v.nativeAddons || []).map(a => [a.name, a.kind]));
    for (const n of ['pregyp', 'prebuildify', 'gypstyle'])
      eq(by[n], 'abi-pinned', `${n} must be a blocker, not a shrug (got ${by[n]})`);
    for (const n of ['napifile', 'napidecl'])
      eq(by[n], 'napi', `${n} must be N-API (got ${by[n]})`);
    const blockers = (v.nativeBlockers || []).map(a => a.name).sort();
    eq(JSON.stringify(blockers), JSON.stringify(['gypstyle', 'prebuildify', 'pregyp']));
  } finally { rmSync(r, { recursive: true, force: true }); }
});
t('addons: napi-rs is read from the PARENT package', () => {
  // napi-rs platform subpackages carry no marker of their own — this is the
  // toolchain next.js uses for @next/swc-*
  const r = mkdtempSync(join(tmpdir(), 'ru-napirs-'));
  try {
    writeFileSync(join(r, 'package.json'), '{"name":"t","dependencies":{}}');
    mkdirSync(join(r, 'node_modules/parent/linux-x64'), { recursive: true });
    writeFileSync(join(r, 'node_modules/parent/package.json'),
      '{"name":"parent","version":"1.0.0","napi":{"name":"x"}}');
    writeFileSync(join(r, 'node_modules/parent/linux-x64/package.json'),
      '{"name":"parent-linux-x64","os":["linux"],"main":"x.linux-x64.node"}');
    writeFileSync(join(r, 'node_modules/parent/linux-x64/x.linux-x64.node'), '');
    const v = runJson(process.execPath, [S('assess.mjs'), 'node', r, '26.12.1']).data;
    const a = (v.nativeAddons || []).find(x => /linux-x64/.test(x.name));
    eq(a?.kind, 'napi', JSON.stringify(v.nativeAddons));
  } finally { rmSync(r, { recursive: true, force: true }); }
});
t('addons: an unclassifiable prebuilt is not a clean bill of health', () => {
  const r = mkdtempSync(join(tmpdir(), 'ru-unk-'));
  try {
    writeFileSync(join(r, 'package.json'), '{"name":"t","dependencies":{}}');
    mkdirSync(join(r, 'node_modules/mystery/prebuilds/linux-x64'), { recursive: true });
    writeFileSync(join(r, 'node_modules/mystery/package.json'), '{"name":"mystery","version":"1.0.0"}');
    writeFileSync(join(r, 'node_modules/mystery/prebuilds/linux-x64/thing.node'), '');
    const v = runJson(process.execPath, [S('assess.mjs'), 'node', r, '26.12.1']).data;
    eq((v.nativeUnknown || []).length, 1, 'it must be reported as UNKNOWN, separately');
    ok(/cannot tell which it is/.test(v.nativeAddons[0].note), v.nativeAddons[0].note);
  } finally { rmSync(r, { recursive: true, force: true }); }
});
t('addons: an ABI number beats an N-API marker', () => {
  // a package can ship both; the numbered binary is what gets loaded
  const r = mkdtempSync(join(tmpdir(), 'ru-both-'));
  try {
    writeFileSync(join(r, 'package.json'), '{"name":"t","dependencies":{}}');
    mkdirSync(join(r, 'node_modules/both/prebuilds/linux-x64'), { recursive: true });
    writeFileSync(join(r, 'node_modules/both/package.json'),
      '{"name":"both","version":"1.0.0","binary":{"napi_versions":[8]}}');
    writeFileSync(join(r, 'node_modules/both/prebuilds/linux-x64/node.abi115.node'), '');
    const v = runJson(process.execPath, [S('assess.mjs'), 'node', r, '26.12.1']).data;
    eq(v.nativeAddons[0].kind, 'abi-pinned', 'evidence of a pin outranks a claim of portability');
  } finally { rmSync(r, { recursive: true, force: true }); }
});

// ───────────── one repo is one decision ─────────────
console.log('\nmonorepo plans do not multiply');
t('plan: identical upgrades in one repo collapse into one', () => {
  // SKILL.md says "never one ticket per workspace package", and plan emitted
  // 215 for symfony, 123 for roslyn, 39 for laravel, 38 for k8s — each with its
  // own story points and its own rendered ticket
  const r = mkdtempSync(join(tmpdir(), 'ru-mono-'));
  try {
    writeFileSync(join(r, 'composer.json'), '{"name":"a/root","require":{"php":"^8.3"}}');
    for (let i = 0; i < 6; i++) {
      mkdirSync(join(r, `src/C${i}`), { recursive: true });
      writeFileSync(join(r, `src/C${i}/composer.json`), '{"name":"a/c' + i + '","require":{"php":"^8.3"}}');
    }
    const p = runJson(process.execPath, [S('plan.mjs'), r, '--json', '--target', '8.5.12']).data;
    ok(p, 'plan produced JSON');
    ok(p.collapsedFromPerPackage, 'identical plans must be merged');
    ok(p.plans.length < 7, `${p.plans.length} plans for 7 identical packages`);
    const merged = p.plans.find(x => x.packageCount > 1);
    ok(merged, 'a merged plan must exist');
    ok(merged.appliesTo.length >= 6, 'and must list every package it covers');
    ok(/not one per package/.test(merged.collapsedNote));
  } finally { rmSync(r, { recursive: true, force: true }); }
});
t('plan: packages that differ are NOT merged', () => {
  // a different current version is a different decision
  const r = mkdtempSync(join(tmpdir(), 'ru-mono2-'));
  try {
    writeFileSync(join(r, 'composer.json'), '{"name":"a/root","require":{"php":"^8.3"}}');
    for (const [d, v] of [['A', '^8.1'], ['B', '^8.2'], ['C', '^8.3'], ['D', '^8.3']]) {
      mkdirSync(join(r, `src/${d}`), { recursive: true });
      writeFileSync(join(r, `src/${d}/composer.json`), `{"name":"a/${d}","require":{"php":"${v}"}}`);
    }
    const p = runJson(process.execPath, [S('plan.mjs'), r, '--json', '--target', '8.5.12']).data;
    const currents = new Set(p.plans.map(x => x.current));
    ok(currents.size >= 3, `distinct current versions must stay distinct: ${[...currents].join(', ')}`);
  } finally { rmSync(r, { recursive: true, force: true }); }
});
t('plan: the estimate is not multiplied by package count', () => {
  const r = mkdtempSync(join(tmpdir(), 'ru-mono3-'));
  try {
    writeFileSync(join(r, 'composer.json'), '{"name":"a/root","require":{"php":"^8.3"}}');
    for (let i = 0; i < 20; i++) {
      mkdirSync(join(r, `src/C${i}`), { recursive: true });
      writeFileSync(join(r, `src/C${i}/composer.json`), '{"name":"a/c' + i + '","require":{"php":"^8.3"}}');
    }
    const p = runJson(process.execPath, [S('plan.mjs'), r, '--json', '--target', '8.5.12']).data;
    ok(p.totalEstimatePoints < 60,
       `21 identical packages should not cost ${p.totalEstimatePoints} points — the compat work is shared`);
  } finally { rmSync(r, { recursive: true, force: true }); }
});
t('plan: a collapsed plan is computed before the object that uses it', () => {
  // a const referenced above its declaration is a TDZ ReferenceError, and this
  // file has produced that bug four times
  const src = readFileSync(S('plan.mjs'), 'utf8');
  const decl = src.indexOf('const collapsed = collapseMonorepo');
  const use = src.indexOf('...collapsed,');
  ok(decl > -1 && use > -1 && decl < use, 'declaration must precede use');
});

// ───────────── targets that are not upgrade work ─────────────
console.log('\nwhat counts as a target');
t('detect: a bun image does not mint a node target', () => {
  // `bun:1` produced a Node target declaring version "1", which plan then
  // reported as "node 1 -> 26.12.1, blocked" beside the correct bun row
  const r = mkdtempSync(join(tmpdir(), 'ru-bun-'));
  try {
    writeFileSync(join(r, 'Dockerfile'), 'FROM oven/bun:1\nFROM bun:1\n');
    const d = runJson(process.execPath, [S('detect.mjs'), r, '--json']).data;
    const nodeTargets = (d.targets || []).filter(t => t.lang === 'node');
    eq(nodeTargets.length, 0, `bun images must not become node targets: ${JSON.stringify(nodeTargets.map(t => t.declaredMajors))}`);
  } finally { rmSync(r, { recursive: true, force: true }); }
});
t('detect: a platform publish stub is reported, never planned', () => {
  // next.js ships 8 `@next/swc-<platform>` stubs — one prebuilt binary each,
  // no dependencies. Each got a 10-point plan and one became the PILOT.
  const r = mkdtempSync(join(tmpdir(), 'ru-stub-'));
  try {
    writeFileSync(join(r, 'package.json'), '{"name":"root","dependencies":{"x":"1"},"engines":{"node":">=20"}}');
    mkdirSync(join(r, 'npm/linux-x64'), { recursive: true });
    writeFileSync(join(r, 'npm/linux-x64/package.json'), JSON.stringify({
      name: '@me/swc-linux-x64', os: ['linux'], cpu: ['x64'],
      main: 'swc.linux-x64.node', engines: { node: '>= 10' } }));
    const d = runJson(process.execPath, [S('detect.mjs'), r, '--json']).data;
    eq((d.platformPublishStubs || []).length, 1, 'the stub must still be REPORTED');
    ok(/prebuilt binary/.test(d.platformPublishStubs[0].why));
    const p = runJson(process.execPath, [S('plan.mjs'), r, '--json']).data;
    eq((p.plans || []).filter(x => x.dir.includes('npm/linux-x64')).length, 0,
       'but never carry story points');
  } finally { rmSync(r, { recursive: true, force: true }); }
});
t('detect: an examples Dockerfile is not a deployable', () => {
  // the container-only loop walked every Dockerfile with no NOISE filter, so
  // plan chose `examples/with-docker` as the pilot
  const r = mkdtempSync(join(tmpdir(), 'ru-exd-'));
  try {
    writeFileSync(join(r, 'package.json'), '{"name":"root","dependencies":{"x":"1"},"engines":{"node":">=20"}}');
    mkdirSync(join(r, 'examples/with-docker'), { recursive: true });
    writeFileSync(join(r, 'examples/with-docker/Dockerfile'), 'FROM node:18\n');
    const d = runJson(process.execPath, [S('detect.mjs'), r, '--json']).data;
    ok(!(d.targets || []).some(t => t.dir.startsWith('examples/')),
       'an example must not be a target');
  } finally { rmSync(r, { recursive: true, force: true }); }
});

console.log('\ncgo lives in .go files');
t('cgo: a real import "C" is found; prose about C is not', () => {
  for (const [name, files, want] of [
    ['real cgo', { 'go.mod': 'module r\n\ngo 1.22\n',
                   'main.go': 'package main\n\n/*\n#include <zlib.h>\n*/\nimport "C"\n\nfunc main() {}\n' }, true],
    ['prose only', { 'go.mod': 'module p\n\ngo 1.22\n// the C zlib library\n',
                     'main.go': 'package main\n// we could import "C" here\nimport "fmt"\nfunc main(){fmt.Println()}\n' }, false],
  ]) {
    const r = mkdtempSync(join(tmpdir(), 'ru-cgo-'));
    try {
      for (const [f, b] of Object.entries(files)) writeFileSync(join(r, f), b);
      eq(usesCgo(r, { walk, readText, join }).cgo, want, name);
    } finally { rmSync(r, { recursive: true, force: true }); }
  }
});

console.log('\nJava properties stay coherent');
t('java: all four compiler properties move together, as majors', () => {
  // only release and java.version moved, leaving source/target behind — and
  // `<maven.compiler.release>21.0.9` is not a value javac accepts
  const pom = PIN_RULES.java('21.0.9').find(r => r.rule === 'maven.compiler.release');
  const out = pom.edit('<properties>\n<java.version>17</java.version>\n'
    + '<maven.compiler.release>17</maven.compiler.release>\n'
    + '<maven.compiler.source>17</maven.compiler.source>\n'
    + '<maven.compiler.target>17</maven.compiler.target>\n</properties>');
  eq((out.match(/>21</g) || []).length, 4, out);
  ok(!/21\.0\.9/.test(out), 'these properties take a release number, not a full version');
});
t('java: jvmToolchain and JavaLanguageVersion take an Int', () => {
  const rs = PIN_RULES.java('21.0.9');
  eq(rs.find(r => r.rule === 'jvmToolchain').edit('jvmToolchain(17)'), 'jvmToolchain(21)');
  const g = rs.find(r => /JavaLanguageVersion/.test(String(r.edit)));
  if (g) ok(/JavaLanguageVersion\.of\(21\)/.test(g.edit('JavaLanguageVersion.of(17)')));
});

console.log('\na failed audit is not a clean audit');
t('verify: a crashed auditor is never reported as "no lockfile"', () => {
  const src = readFileSync(S('verify.mjs'), 'utf8');
  ok(/This is NOT a clean result/.test(src), 'the three outcomes must be distinguished');
  ok(/yarnAuditArgs/.test(src), 'yarn v1 and Berry take different commands');
});
t('verify: an audit gate with no lockfile says exactly that', () => {
  const r = mkdtempSync(join(tmpdir(), 'ru-nolock-'));
  try {
    writeFileSync(join(r, 'package.json'), '{"name":"x","engines":{"node":">=20"}}');
    const v = runJson(process.execPath, [S('verify.mjs'), 'node', r, '26.12.1']).data;
    const g = (v.gates || []).find(x => x.name === 'dependency advisories');
    ok(/no lockfile — there is nothing to audit/.test(g.detail), g.detail);
  } finally { rmSync(r, { recursive: true, force: true }); }
});

console.log('\nan import specifier is not any old string');
t('depverify: a string containing an import is not a call site', () => {
  // a decoy holding `"require(\'uid\')"` was ranked the TOP call site for a
  // package it never imports, and the probe instructions pointed at it
  const r = mkdtempSync(join(tmpdir(), 'ru-decoy-'));
  try {
    writeFileSync(join(r, 'package.json'), '{"name":"d","dependencies":{"uid":"1.0.0"}}');
    writeFileSync(join(r, 'lock.before'), '{"packages":{"node_modules/uid":{"version":"1.0.0"}}}');
    writeFileSync(join(r, 'package-lock.json'), '{"packages":{"node_modules/uid":{"version":"2.0.0"}}}');
    mkdirSync(join(r, 'src'), { recursive: true });
    writeFileSync(join(r, 'src/decoy.ts'),
      '// we might require(\'uid\') later\nconst s = "require(\'uid\')";\nconst t = `from \'uid\'`;\nexport const d = s + t;\n');
    writeFileSync(join(r, 'src/real.ts'), "import uid from 'uid';\nexport const id = () => uid(8);\n");
    const v = runJson(process.execPath, [S('depverify.mjs'), 'node', r, '--before', join(r, 'lock.before')]).data;
    const p = v.probePlan[0];
    eq(p.filesTouching, 1, `counted the decoy: ${JSON.stringify(p.where)}`);
    eq(p.where[0].file, 'src/real.ts');
  } finally { rmSync(r, { recursive: true, force: true }); }
});

// ───────────── a cap reached is not a result ─────────────
console.log('\ndiscovery honesty');
t('walk: reports when it stopped early', () => {
  const r = mkdtempSync(join(tmpdir(), 'ru-walk-'));
  try {
    for (let i = 0; i < 30; i++) writeFileSync(join(r, `f${i}.txt`), 'x');
    const h = walk(r, { match: n => n.endsWith('.txt'), limit: 10 });
    eq(h.truncated, true, 'hitting the cap must be reported');
    ok(walkGaps(h).hitFileCap, 'and surfaced as a gap');
  } finally { rmSync(r, { recursive: true, force: true }); }
});
t('walk: a complete walk reports no gaps at all', () => {
  const r = mkdtempSync(join(tmpdir(), 'ru-walk2-'));
  try {
    writeFileSync(join(r, 'a.txt'), 'x');
    const h = walk(r, { match: n => n.endsWith('.txt') });
    eq(h.truncated, false);
    eq(walkGaps(h), null, 'silence must mean "complete", not "did not check"');
  } finally { rmSync(r, { recursive: true, force: true }); }
});
t('walk: directories below the depth limit are named', () => {
  const r = mkdtempSync(join(tmpdir(), 'ru-walk3-'));
  try {
    mkdirSync(join(r, 'a/b/c/d'), { recursive: true });
    writeFileSync(join(r, 'a/b/c/d/deep.txt'), 'x');
    const h = walk(r, { match: n => n.endsWith('.txt'), maxDepth: 2 });
    eq(h.length, 0, 'the deep file is genuinely missed');
    ok(walkGaps(h).belowDepthLimit, 'so the gap must be stated');
  } finally { rmSync(r, { recursive: true, force: true }); }
});
t('walk: only AMBIGUOUS skips are reported, never .git', () => {
  // listing .git and node_modules buries the one that matters: grafana keeps a
  // real Go module at pkg/build/wire, and `build` is in the skip set
  const r = mkdtempSync(join(tmpdir(), 'ru-walk4-'));
  try {
    for (const d of ['.git', 'node_modules', 'build']) mkdirSync(join(r, d), { recursive: true });
    writeFileSync(join(r, 'x.txt'), 'y');
    const g = walkGaps(walk(r, { match: n => n.endsWith('.txt') }));
    const ex = g?.skippedByName?.examples || [];
    ok(ex.includes('build'), `build must be reported: ${JSON.stringify(ex)}`);
    ok(!ex.some(x => /\.git|node_modules/.test(x)), `noise reported: ${JSON.stringify(ex)}`);
  } finally { rmSync(r, { recursive: true, force: true }); }
});
t('scan: the file-walk cap is distinct from the findings cap', () => {
  const src = readFileSync(S('scan.mjs'), 'utf8');
  ok(/coverageGaps/.test(src), 'scan must report what it never opened');
  ok(/a finding count is a floor, not a total/.test(src));
});

console.log('\nSDKMAN identifiers keep their distribution');
t('sdkman: the distro suffix survives, and so does the precision', () => {
  // `java=25.0.4-librca` -> `java=21` left an identifier SDKMAN cannot resolve
  // and silently discarded the Liberica choice
  const r = PIN_RULES.java('21.0.9').find(x => x.file === '.sdkmanrc');
  eq(r.edit('java=25.0.4-librca\n').trim(), 'java=21.0.9-librca');
  eq(r.edit('java=17.0.2-tem\n').trim(), 'java=21.0.9-tem');
  eq(r.edit('java=17\n').trim(), 'java=21', 'a bare major stays a bare major');
  eq(r.edit('java=17-open\n').trim(), 'java=21-open');
});

console.log('\npins are never invented over a declaration');
t('addpin: a workspace-inherited MSRV is a declaration', () => {
  const r = mkdtempSync(join(tmpdir(), 'ru-ws-'));
  try {
    writeFileSync(join(r, 'Cargo.toml'), '[package]\nname="a"\nrust-version.workspace = true\n');
    const hidden = declaredButUnreadable('rust', r);
    ok(hidden.length, 'the inherited MSRV must be seen as declared');
    ok(/workspace\.package/.test(hidden[0].how), hidden[0].how);
    const p = planAddPin('rust', r, '1.99.1');
    ok(p?.blocked, 'and no pin may be created beside it');
  } finally { rmSync(r, { recursive: true, force: true }); }
});
t('addpin: a computed gemspec constraint is a declaration', () => {
  const r = mkdtempSync(join(tmpdir(), 'ru-gsc-'));
  try {
    writeFileSync(join(r, 'x.gemspec'), 's.required_ruby_version = Gem::Requirement.new(">= #{MIN}")\n');
    ok(declaredButUnreadable('ruby', r).length, 'a computed constraint still declares a minimum');
  } finally { rmSync(r, { recursive: true, force: true }); }
});
t('addpin: a rustup override is never created in a subdirectory', () => {
  // a rust-toolchain.toml in tokio/fuzz changes the toolchain for every
  // contributor who builds from there
  const r = mkdtempSync(join(tmpdir(), 'ru-sub-'));
  try {
    writeFileSync(join(r, 'Cargo.toml'), '[package]\nname="a"\nversion="0.1.0"\n');
    const sub = planAddPin('rust', r, '1.99.1', { isRoot: false });
    ok(sub?.blocked, 'must refuse below the root');
    ok(/override the toolchain|toolchain OVERRIDE/i.test(sub.why), sub.why);
    const root = planAddPin('rust', r, '1.99.1', { isRoot: true });
    ok(root && !root.blocked && root.created, 'but a genuine root still gets one');
  } finally { rmSync(r, { recursive: true, force: true }); }
});

// ───────────── floors carry more than a lower bound ─────────────
console.log('\nconstraint preservation');
t('floors: only the lower bound moves; caps and exclusions survive', () => {
  // `>=3.9,<4.0` became `>=3.15`, dropping a chosen cap;
  // `>=3.8,!=3.9.*,<3.14` became `>=3.15`, REVERSING the declared intent
  eq(raiseLowerBound('>=3.9,<4.0', '3.15'), '>=3.15,<4.0');
  eq(raiseLowerBound('>=3.9, <4', '3.15'), '>=3.15,<4');
  eq(raiseLowerBound('>=3.10', '3.15'), '>=3.15');
  eq(raiseLowerBound('>3.8', '3.15'), '>=3.15');
});
t('floors: a cap below the new floor means refuse, not flatten', () => {
  // raising the floor past the cap makes the constraint unsatisfiable
  eq(raiseLowerBound('>=3.8,!=3.9.*,<3.14', '3.15'), '>=3.8,!=3.9.*,<3.14');
});
t('floors: a compatible-release constraint is not a floor', () => {
  eq(raiseLowerBound('~=3.9', '3.15'), '~=3.9');
});
t('floors: every gemspec in the tree is edited, not the first one', () => {
  // rails ships 13 gemspecs; one was edited and twelve left declaring a
  // different minimum — gems published with contradictory support contracts
  const r = mkdtempSync(join(tmpdir(), 'ru-gs-'));
  try {
    writeFileSync(join(r, 'Gemfile'), "ruby '3.3.5'\n");
    for (const g of ['rails.gemspec', 'activesupport/activesupport.gemspec',
                     'actionpack/actionpack.gemspec', 'tools/releaser/releaser.gemspec']) {
      mkdirSync(join(r, g.slice(0, g.lastIndexOf('/')) || '.'), { recursive: true });
      writeFileSync(join(r, g), 's.required_ruby_version = ">= 3.3.5"\n');
    }
    const e = planPinEdits('ruby', r, '4.0.9', { raiseFloor: true })
      .edits.filter(x => x.rule === 'gemspec required_ruby_version');
    eq(e.length, 4, `expected all 4 gemspecs, got ${e.map(x => x.file).join(', ')}`);
  } finally { rmSync(r, { recursive: true, force: true }); }
});
t('floors: the declined preview is the line that would really change', () => {
  // the old preview grepped for the target's major digit and surfaced
  // `requires = ["setuptools>=83"]` and `# - Create "v1.x.y" git tag.`
  const r = mkdtempSync(join(tmpdir(), 'ru-pv-'));
  try {
    writeFileSync(join(r, 'pyproject.toml'),
      '[build-system]\nrequires = ["setuptools>=83"]\n\n[project]\nrequires-python = ">= 3.12"\n');
    const d = planPinEdits('python', r, '3.15.2').declinedFloors[0];
    ok(/requires-python/.test(d.would), `showed an unrelated line: ${d.would}`);
    ok(!/setuptools/.test(d.would), d.would);
    ok(/->/.test(d.would), 'and must show both sides');
  } finally { rmSync(r, { recursive: true, force: true }); }
});

console.log('\ntox basepython names an executable');
t('tox: basepython gets major.minor — the binary that exists', () => {
  // `basepython = python3.15.2` is no executable on any system; every tox env died
  const tox = PIN_RULES.python('3.15.2').find(r => r.file === 'tox.ini');
  const out = tox.edit('[testenv:py314]\nbasepython = python3.14\n');
  ok(/basepython = python3\.15$/m.test(out), out.trim());
});
t('tox: a bare python3 is deliberate and is left alone', () => {
  const tox = PIN_RULES.python('3.15.2').find(r => r.file === 'tox.ini');
  const before = '[testenv:black]\nbasepython = python3\n';
  eq(tox.edit(before), before);
});
t('tox: the free-threaded suffix is preserved', () => {
  const tox = PIN_RULES.python('3.15.2').find(r => r.file === 'tox.ini');
  ok(/python3\.15t$/m.test(tox.edit('basepython = python3.14t\n')));
});

console.log('\n.NET Framework is a port, not a version');
t('dotnet: net472 reads as 4.7, never 472', () => {
  const norm = byId.dotnet.normalizeVersion;
  ok(norm, 'the adapter must export its normaliser so nobody reimplements it');
  eq(norm('net472'), '4.7');
  eq(norm('net46'), '4.6');
  eq(norm('net8.0'), '8');
  eq(norm('net10.0'), '10');
  eq(norm('netstandard2.0'), '', 'netstandard is not a runtime version');
});
t('dotnet: plan uses the adapter normaliser, not its own', () => {
  const src = readFileSync(S('plan.mjs'), 'utf8');
  ok(/adapter\?\.normalizeVersion/.test(src),
     'plan reimplemented this and read net472 as version 472 across 119 roslyn plans');
});

// ───────────── verify judges pins and floors differently ─────────────
console.log('\nverify: pins vs floors');
function vRepo(files) {
  const r = mkdtempSync(join(tmpdir(), 'ru-v-'));
  for (const [f, body] of Object.entries(files)) {
    const full = join(r, f);
    mkdirSync(full.slice(0, full.lastIndexOf('/')), { recursive: true });
    writeFileSync(full, body);
  }
  return r;
}
const verifyOf = (lang, dir, target) => runJson(process.execPath, [S('verify.mjs'), lang, dir, target]).data;
const gate = (v, name) => (v.gates || []).find(g => g.name.includes(name));

t('verify: a library whose floor was correctly NOT raised still passes', () => {
  // the catch-22: the gate demanded a declared version equal to the target,
  // while remediate correctly refuses to raise a consumer-facing floor. Every
  // library — symfony, rails, django, nest — was permanently "blocked".
  const r = vRepo({ 'package.json': '{"name":"lib","engines":{"node":">= 20"},"dependencies":{}}' });
  try {
    const v = verifyOf('node', r, '26.12.1');
    const g = gate(v, 'declared version matches target');
    eq(g.status, 'pass', g.detail);
    ok(/semver-breaking/.test(g.detail), 'and must say why leaving it is correct');
  } finally { rmSync(r, { recursive: true, force: true }); }
});
t('verify: a stale PIN still fails', () => {
  const r = vRepo({ 'package.json': '{"name":"app","dependencies":{}}', '.nvmrc': '20.11.1\n' });
  try {
    const g = gate(verifyOf('node', r, '26.12.1'), 'declared version matches target');
    eq(g.status, 'fail', JSON.stringify(g));
    ok(/PINS still name the old runtime/.test(g.detail), g.detail);
  } finally { rmSync(r, { recursive: true, force: true }); }
});
t('verify: a stale pin is caught at the TARGET\'s precision, per language', () => {
  // `majorOf` truncated to the first dotted component, so .php-version 8.1
  // against target 8.4 compared "8" to "8" and a stale pin reported as clean
  const cases = [
    ['php', { 'composer.json': '{"name":"x","require":{"php":"^8.1"}}', '.php-version': '8.1\n' }, '8.4', 'fail'],
    ['php', { 'composer.json': '{"name":"x","require":{"php":"^8.4"}}', '.php-version': '8.4\n' }, '8.4', 'pass'],
    ['python', { 'pyproject.toml': '[project]\nname="x"\nrequires-python=">=3.11"\n', '.python-version': '3.11\n' }, '3.13', 'fail'],
    ['node', { 'package.json': '{"name":"x","dependencies":{}}', '.nvmrc': '20.11.1\n' }, '26.12.1', 'fail'],
    ['node', { 'package.json': '{"name":"x","dependencies":{}}', '.nvmrc': '26.1.0\n' }, '26.12.1', 'pass'],
  ];
  for (const [lang, files, target, want] of cases) {
    const r = mkdtempSync(join(tmpdir(), 'ru-prec-'));
    try {
      for (const [f, b] of Object.entries(files)) writeFileSync(join(r, f), b);
      const g = gate(verifyOf(lang, r, target), 'declared version matches target');
      eq(g.status, want, `${lang} pin ${JSON.stringify(Object.values(files)[1])} vs ${target}: ${g.detail}`);
    } finally { rmSync(r, { recursive: true, force: true }); }
  }
});
t('verify: a floor ABOVE the target is a real failure', () => {
  const r = vRepo({ 'package.json': '{"name":"lib","engines":{"node":">= 28"},"dependencies":{}}' });
  try {
    const g = gate(verifyOf('node', r, '26.12.1'), 'declared version matches target');
    eq(g.status, 'fail', JSON.stringify(g));
    ok(/requires more than you are shipping/.test(g.detail), g.detail);
  } finally { rmSync(r, { recursive: true, force: true }); }
});
t('verify: floors in different packages are not "drift"', () => {
  // flattening declaredMajors across every nested package made drift
  // unavoidable on any monorepo, contradicting detect's own driftCount: 0
  const r = vRepo({
    'package.json': '{"name":"root","engines":{"node":">= 20"},"workspaces":["a","b"]}',
    'a/package.json': '{"name":"a","engines":{"node":">= 18"},"dependencies":{"x":"1"}}',
    'b/package.json': '{"name":"b","engines":{"node":">= 22"},"dependencies":{"y":"1"}}' });
  try {
    const g = gate(verifyOf('node', r, '26.12.1'), 'drift');
    eq(g.status, 'pass', g.detail);
    ok(/cannot drift/.test(g.detail), g.detail);
  } finally { rmSync(r, { recursive: true, force: true }); }
});
t('verify: two PINS that disagree are drift', () => {
  const r = vRepo({ 'package.json': '{"name":"app","dependencies":{}}',
                    '.nvmrc': '20.11.1\n', '.node-version': '22.1.0\n' });
  try {
    const g = gate(verifyOf('node', r, '26.12.1'), 'drift');
    eq(g.status, 'fail', JSON.stringify(g));
    ok(/pin two different versions/.test(g.detail), g.detail);
  } finally { rmSync(r, { recursive: true, force: true }); }
});

// ───────────── research tells the truth about versions ─────────────
console.log('\nresearch: real versions only');
t('research: a version that does not exist is refused', async () => {
  // `research php 8.9` reported supportedLongerThanCurrent: true for a release
  // that has never existed, and that flowed into a written pin
  for (const [lang, cur, bogus] of [['php', '8.3', '8.9'], ['python', '3.12', '9.9']]) {
    const r = run(process.execPath, [S('research.mjs'), lang, cur, bogus]);
    ok(r.status !== 0, `${lang} ${bogus} must be refused`);
    ok(/is not a release endoflife\.date knows about/.test(r.stderr), r.stderr.slice(0, 120));
    ok(/Known cycles:/.test(r.stderr), 'and must list what IS real');
  }
}, { net: true });
t('research: an unrecognised CURRENT version is never reported as healthy', async () => {
  const v = runJson(process.execPath, [S('research.mjs'), 'dotnet', '472']);
  ok(v.data?.currentUnrecognised, 'net472 is not a dotnet cycle');
  ok(/UNKNOWN, not "fine"/.test(v.data.currentUnrecognised.meaning));
}, { net: true });
t('research: LTS beats newest wherever the product has LTS', async () => {
  // java auto-targeted non-LTS 27 (EOL 2027-04) over 25 LTS (EOL 2032-10),
  // shortening the support window by five years and calling it an upgrade
  const v = runJson(process.execPath, [S('research.mjs'), 'java', '17']);
  ok(v.data, 'research ran');
  eq(v.data.target.lts, true, `picked ${v.data.target.version}, which is not LTS`);
}, { net: true });

// ───────────── CI edits ─────────────
console.log('\nCI rewriting');
function ciRepo(files) {
  const r = mkdtempSync(join(tmpdir(), 'ru-ci-'));
  for (const [f, body] of Object.entries(files)) {
    const full = join(r, f);
    mkdirSync(full.slice(0, full.lastIndexOf('/')), { recursive: true });
    writeFileSync(full, body);
  }
  return r;
}
const wf = (name, body) => [`.github/workflows/${name}`, body];
t('ci: the lowest-supported job is never collapsed, even in another file', () => {
  // symfony keeps its 8.1 and 8.2 jobs in separate workflow files, so a
  // per-file check saw each as single-valued and rewrote every one of them
  const r = ciRepo(Object.fromEntries([
    wf('current.yml', 'jobs:\n  a:\n    steps:\n      - with:\n          php-version: "8.4"\n'),
    wf('lowest.yml',  'jobs:\n  b:\n    steps:\n      - with:\n          php-version: "8.1"\n'),
  ]));
  try {
    const e = planCiEdits('php', r, '8.5.12');
    eq(e.length, 1, 'only the newest job moves');
    ok(e[0].file.endsWith('current.yml'), e[0].file);
    eq(e.skipped.length, 1);
    ok(/lowest-supported/.test(e.skipped[0].reason));
    ok(/deletes the only proof/.test(e.skipped[0].advice));
  } finally { rmSync(r, { recursive: true, force: true }); }
});
t('ci: each setup-* action gets the precision it actually accepts', () => {
  // setup-php publishes only major.minor builds — "8.5.12" fails to provision.
  // setup-node takes full semver, where pinning the patch is the better answer.
  const cases = [['php', '8.4', '8.5.12', '8.5'], ['node', '20.11.1', '24.22.1', '24.22.1']];
  for (const [lang, from, target, want] of cases) {
    const r = ciRepo(Object.fromEntries([wf('a.yml',
      `jobs:\n  a:\n    steps:\n      - with:\n          ${lang}-version: "${from}"\n`)]));
    try {
      const e = planCiEdits(lang, r, target);
      ok(e.length === 1 && new RegExp(`${lang}-version: "${want.replace(/\./g, '\\.')}"`).test(e[0].after),
         `${lang}: wanted ${want}, got ${e[0]?.after}`);
    } finally { rmSync(r, { recursive: true, force: true }); }
  }
});
t('ci: an image whose NAME merely contains the runtime is left alone', () => {
  // dunglas/frankenphp:1.12.1-php8.4 had FrankenPHP's own version replaced
  const body = 'jobs:\n  a:\n    container:\n      image: dunglas/frankenphp:1.12.1-php8.4\n';
  const r = ciRepo(Object.fromEntries([wf('a.yml', body)]));
  try { eq(planCiEdits('php', r, '8.5.12').length, 0); }
  finally { rmSync(r, { recursive: true, force: true }); }
});
t('ci: a templated tag is never written into', () => {
  // produced `cimg/node:26.12.1<< pipeline.parameters.node-version >>`
  for (const tag of ['<< pipeline.parameters.node-version >>', '${{ matrix.node }}', '${NODE_VERSION}']) {
    const r = ciRepo({ '.circleci/config.yml': `jobs:\n  a:\n    docker:\n      - image: cimg/node:${tag}\n` });
    try { eq(planCiEdits('node', r, '26.12.1').length, 0, tag); }
    finally { rmSync(r, { recursive: true, force: true }); }
  }
});
t('ci: a genuine image tag still moves', () => {
  const r = ciRepo(Object.fromEntries([wf('a.yml', 'jobs:\n  a:\n    container:\n      image: node:20-alpine3.19\n')]));
  try {
    const e = planCiEdits('node', r, '24.1.0');
    eq(e.length, 1);
    ok(/node:24\.1\.0-alpine/.test(e[0].after), e[0].after);
  } finally { rmSync(r, { recursive: true, force: true }); }
});

// ───────────── a bulk dependency upgrade can wreck a repo ─────────────
console.log('\ndependency upgrade safety');
function depRepo(files) { return ciRepo(files); }
t('deps: a vendored Go module refuses a bulk upgrade', () => {
  // `go get -u ./...` updated go.mod but not vendor/, and kubernetes could no
  // longer build a single package — while remediate reported deps.ok: true
  const r = depRepo({ 'go.mod': 'module k\n\ngo 1.22\n', 'vendor/modules.txt': '# x\n' });
  try {
    const v = runJson(process.execPath, [S('remediate.mjs'), 'go', r, '1.24.0', '--deps', 'minor']);
    ok(v.data.dependencies.refused, 'must refuse');
    ok(v.data.dependencies.blockers.some(b => /vendors its dependencies/.test(b.why)));
    eq(v.data.dependencies.command, undefined, 'and must not even name a command to run');
  } finally { rmSync(r, { recursive: true, force: true }); }
});
t('deps: replace-pinned modules are seen in both spellings', () => {
  const block = 'module k\n\ngo 1.22\n\nreplace (\n\tk8s.io/api => ./staging/src/k8s.io/api\n)\n';
  const bare  = 'module k\n\ngo 1.22\n\nreplace k8s.io/api => ./staging/src/k8s.io/api\n';
  for (const [name, gomod] of Object.entries({ block, bare })) {
    const r = depRepo({ 'go.mod': gomod });
    try {
      const v = runJson(process.execPath, [S('remediate.mjs'), 'go', r, '1.24.0', '--deps', 'minor']);
      ok(v.data.dependencies.blockers?.some(b => /replace-pinned/.test(b.why)), `${name} form not detected`);
    } finally { rmSync(r, { recursive: true, force: true }); }
  }
});
t('deps: a go.work workspace blocks a floor raise', () => {
  const r = depRepo({ 'go.mod': 'module k\n\ngo 1.22\n', 'go.work': 'go 1.21\n\nuse .\n' });
  try {
    const v = runJson(process.execPath, [S('remediate.mjs'), 'go', r, '1.24.0', '--deps', 'minor']);
    ok(v.data.dependencies.blockers.some(b => /go\.work/.test(b.why)));
  } finally { rmSync(r, { recursive: true, force: true }); }
});
t('deps: Yarn Berry is not driven with Yarn 1 commands', () => {
  const r = depRepo({ 'package.json': '{"name":"x","packageManager":"yarn@4.18.1"}' });
  try {
    const v = runJson(process.execPath, [S('remediate.mjs'), 'node', r, '24.1.0', '--deps', 'minor']);
    ok(v.data.dependencies.blockers?.some(b => /yarn@4/.test(b.why)), JSON.stringify(v.data.dependencies));
  } finally { rmSync(r, { recursive: true, force: true }); }
});
t('deps: an ordinary repo is not blocked', () => {
  const r = depRepo({ 'go.mod': 'module k\n\ngo 1.22\n' });
  try {
    const v = runJson(process.execPath, [S('remediate.mjs'), 'go', r, '1.24.0', '--deps', 'minor']);
    ok(!v.data.dependencies.refused, JSON.stringify(v.data.dependencies.blockers));
  } finally { rmSync(r, { recursive: true, force: true }); }
});
t('deps: --force-deps is the documented opt-out', () => {
  const src = readFileSync(S('remediate.mjs'), 'utf8');
  ok(/--force-deps/.test(src));
  ok(/only if you have read each one/.test(src), 'and it must say what forcing means');
});

// ───────────── gate capability is a promise ─────────────
console.log('\ngate capability');
t('every gateCapable adapter actually implements a CVE lookup', () => {
  // go exported runtimeCves(); verify only looked for matchRuntimeCve(), so the
  // Go gate silently SKIPPED on every run while printing its own description.
  // A skipped gate reads as a pass.
  for (const a of adapters) {
    if (!a.gateCapable) continue;
    ok(a.matchRuntimeCve || a.runtimeCves,
       `${a.id} declares gateCapable but exports neither matchRuntimeCve nor runtimeCves`);
    ok(a.cveSource?.url, `${a.id} is gate-capable but names no CVE source`);
  }
});
t('verify consults both CVE lookup shapes', () => {
  const src = readFileSync(S('verify.mjs'), 'utf8');
  ok(/A\.matchRuntimeCve \|\| A\.runtimeCves/.test(src), 'verify must accept either interface');
});
t('a gate-capable adapter with no lookup is called a bug, not a pass', () => {
  const src = readFileSync(S('verify.mjs'), 'utf8');
  ok(/this is a bug, not a clean bill of health/.test(src));
});
t('an adapter that cannot rank severity gates on total', () => {
  // Go's vuln DB assigns no severity; counting high/critical there is always 0
  const go = byId.go;
  eq(go.gateMetric, 'total', 'go must gate on total, not on high/critical');
  const src = readFileSync(S('verify.mjs'), 'utf8');
  ok(/A\.gateMetric === 'total'/.test(src), 'verify must honour gateMetric');
});

// ───────────── diffs git will actually apply ─────────────
// Under MODE=plan the diff IS the deliverable. These shapes all produced
// patches git refused: one-line pin files, edits closer than 2x context, and
// newly created files.
console.log('\nunified diffs');
function gitApplies(before, after, name = 'f') {
  const r = mkdtempSync(join(tmpdir(), 'ru-diff-'));
  try {
    const g = (...a) => run('git', ['-C', r, ...a]);
    g('init', '-q', '.'); g('config', 'user.email', 't@t'); g('config', 'user.name', 't');
    if (before !== '') writeFileSync(join(r, name), before);
    g('add', '-A'); g('commit', '-q', '-m', 'x', '--allow-empty');
    const d = unified(name, before, after);
    writeFileSync(join(r, 'p.diff'), d);
    const chk = g('apply', '--check', 'p.diff');
    return { ok: chk.status === 0, err: (chk.stderr || '').trim(), diff: d };
  } finally { rmSync(r, { recursive: true, force: true }); }
}
const DIFF_CASES = {
  'a one-line pin file': ['3.14.9\n', '3.15.2\n'],
  'a file with no trailing newline': ['3.14.9', '3.15.2'],
  'a file that gains a trailing newline': ['3.14.9', '3.15.2\n'],
  'two edits closer than 2x context': ['a\nb\nX\nd\ne\nf\nX\nh\n', 'a\nb\nY\nd\ne\nf\nY\nh\n'],
  'three near edits (tox.ini shape)': ['p1\nq\np2\nq\np3\nq\n', 'P1\nq\nP2\nq\nP3\nq\n'],
  'two edits far apart': [
    Array.from({ length: 30 }, (_, i) => 'line' + i).join('\n') + '\n',
    Array.from({ length: 30 }, (_, i) => i === 2 ? 'Y' : i === 25 ? 'Z' : 'line' + i).join('\n') + '\n'],
  'the first line': ['a\nb\nc\n', 'Z\nb\nc\n'],
  'the last line': ['a\nb\nc\n', 'a\nb\nZ\n'],
  'a block that grows': ['a\nb\nc\n', 'a\nx\ny\nz\nc\n'],
  'a newly created file': ['', '3.15.2\n'],
};
for (const [name, [b, a]] of Object.entries(DIFF_CASES))
  t(`diff: git apply accepts ${name}`, () => {
    const r = gitApplies(b, a);
    ok(r.ok, `${r.err}\n${r.diff.replace(/^/gm, '      ')}`);
  });
t('diff: a created file is diffed against /dev/null', () => {
  const d = unified('new.txt', '', 'x\n');
  ok(d.startsWith('--- /dev/null\n'), d.split('\n')[0]);
  ok(/^@@ -0,0 \+1,1 @@$/m.test(d), d);
});
t('diff: no change produces no diff', () => eq(unified('f', 'a\n', 'a\n'), ''));
t('diff: a missing trailing newline is marked', () => {
  ok(/\\ No newline at end of file/.test(unified('f', 'a', 'b')));
});
t('diff: hunks never overlap', () => {
  const d = unified('f', 'a\nb\nX\nd\ne\nf\nX\nh\n', 'a\nb\nY\nd\ne\nf\nY\nh\n');
  const heads = [...d.matchAll(/^@@ -(\d+),(\d+)/gm)].map(m => [+m[1], +m[2]]);
  for (let i = 1; i < heads.length; i++)
    ok(heads[i][0] > heads[i - 1][0] + heads[i - 1][1] - 1,
       `hunk ${i} starts at ${heads[i][0]} but the previous ends at ${heads[i - 1][0] + heads[i - 1][1] - 1}`);
});

// ───────────── probe runner ─────────────
console.log('\nprobe runner');
t('probe: refuses an incomplete invocation', () => {
  const r = run(process.execPath, [S('probe.mjs'), 'node', 'ms', '2.0.0']);
  ok(r.status !== 0);
  ok(/usage/.test(r.stderr), r.stderr.slice(0, 120));
});
t('probe: refuses a missing probe file', () => {
  const r = run(process.execPath, [S('probe.mjs'), 'node', 'ms', '1', '2', '--probe', '/no/such']);
  ok(r.status !== 0);
  ok(/no such probe file/.test(r.stderr), r.stderr.slice(0, 120));
});
t('probe: a compiled language says why it has no runner, and does not claim safety', () => {
  const f = join(tmpdir(), 'ru-p.txt'); writeFileSync(f, 'x');
  try {
    const r = run(process.execPath, [S('probe.mjs'), 'rust', 'serde', '1', '2', '--probe', f]);
    ok(r.status !== 0);
    ok(/no runner for "rust"/.test(r.stderr), r.stderr.slice(0, 200));
    // the honest caveat must survive: a clean build is NOT a behaviour check
    ok(/behaviour change passes a clean build/i.test(r.stderr), r.stderr.slice(0, 300));
  } finally { rmSync(f, { force: true }); }
});
t('probe: every supported ecosystem can install, run and read back a version', () => {
  // the three pieces each ecosystem entry must supply; a missing one silently
  // reported "not installed" for a successful install
  const src = readFileSync(S('probe.mjs'), 'utf8');
  const langs = [...src.matchAll(/^  (node|python|php|ruby): \{/gm)].map(m => m[1]);
  eq(langs.length, 4, 'four ecosystems');
  for (const l of langs) {
    const body = src.slice(src.indexOf(`  ${l}: {`));
    for (const k of ['install:', 'exec:', 'installed:'])
      ok(body.slice(0, 1400).includes(k), `${l} is missing ${k}`);
  }
});
t('probe: a silent probe is inconclusive, never "identical"', () => {
  // the dangerous failure: a probe that prints nothing matches itself exactly
  const src = readFileSync(S('probe.mjs'), 'utf8');
  ok(/if \(!bOut\.trim\(\)\) outcome = 'inconclusive'/.test(src),
     'empty output must be downgraded out of "identical"');
});
t('probe: identical output carries the limit of what it proved', () => {
  const src = readFileSync(S('probe.mjs'), 'utf8');
  ok(/says nothing about calls it did not make/.test(src), 'the caveat must ship with the verdict');
});
t('no ESM script calls require() — it is not defined there', () => {
  // this failed silently inside a catch{} and reported every successful pip and
  // gem install as "not installed"
  const bad = [];
  const SCRIPTS = join(HERE, '..', 'scripts');
  for (const f of walkMjs(SCRIPTS)) {
    // strip comments AND strings with the project's own stripper — a message
    // that merely mentions "require() time" is not a call
    const code = stripNonCode(readFileSync(f, 'utf8'), 'node');
    code.split('\n').forEach((ln, i) => {
      if (/(^|[^.\w$])require\s*\(/.test(ln))
        bad.push(`${f.slice(SCRIPTS.length + 1)}:${i + 1}: ${ln.trim().slice(0, 80)}`);
    });
  }
  eq(bad.length, 0, 'require() in ESM:\n    ' + bad.join('\n    '));
});

// ───────────── repo shape ─────────────
// shape drives the guidance the skill gives. 'single' tells the user to
// "upgrade the ROOT pin once" — catastrophic advice for a 213-package repo.
console.log('\nrepo shape');
function mkRepo(files) {
  const r = mkdtempSync(join(tmpdir(), 'ru-shape-'));
  for (const [f, body] of Object.entries(files)) {
    const full = join(r, f);
    mkdirSync(full.slice(0, full.lastIndexOf('/')), { recursive: true });
    writeFileSync(full, body);
  }
  return r;
}
const shapeOf = r => runJson(process.execPath, [S('detect.mjs'), r, '--json']).data;

t('shape: a lone project is single', () => {
  const r = mkRepo({ 'pyproject.toml': '[project]\nname="x"\nrequires-python=">=3.11"\n' });
  try { const d = shapeOf(r); eq(d.shape, 'single'); eq(d.siblingPackages, 0); }
  finally { rmSync(r, { recursive: true, force: true }); }
});
t('shape: sibling packages make a monorepo in ANY ecosystem', () => {
  // the defect: this was a Node-only test, so every PHP/Go/.NET/Java monorepo
  // was reported 'single'
  const cases = {
    php: { 'composer.json': '{"require":{"php":"^8.2"}}',
           'src/A/composer.json': '{"require":{"php":"^8.2"}}',
           'src/B/composer.json': '{"require":{"php":"^8.2"}}' },
    go: { 'go.mod': 'module m\n\ngo 1.22\n',
          'a/go.mod': 'module m/a\n\ngo 1.22\n',
          'b/go.mod': 'module m/b\n\ngo 1.22\n' },
  };
  for (const [lang, files] of Object.entries(cases)) {
    const r = mkRepo(files);
    try {
      const d = shapeOf(r);
      eq(d.shape, 'monorepo', `${lang} with 2 siblings and no workspace file`);
      eq(d.siblingPackages, 2, lang);
    } finally { rmSync(r, { recursive: true, force: true }); }
  }
});
t('shape: one sibling is not yet a monorepo', () => {
  const r = mkRepo({ 'composer.json': '{"require":{"php":"^8.2"}}',
                     'src/A/composer.json': '{"require":{"php":"^8.2"}}' });
  try { eq(shapeOf(r).shape, 'single'); }
  finally { rmSync(r, { recursive: true, force: true }); }
});
t('shape: a pure workspace root stays multi-package', () => {
  // a root that pins nothing must not be told to "upgrade the ROOT pin once"
  const r = mkRepo({ 'Cargo.toml': '[workspace]\nmembers = ["a", "b"]\n',
                     'a/Cargo.toml': '[package]\nname="a"\nrust-version="1.70"\n',
                     'b/Cargo.toml': '[package]\nname="b"\nrust-version="1.70"\n' });
  try {
    const d = shapeOf(r);
    eq(d.shape, 'multi-package', 'no root package means no root pin');
    ok(d.siblingPackages >= 2, 'siblings are still counted');
  } finally { rmSync(r, { recursive: true, force: true }); }
});
t('shape: guidance exists for every shape it can emit', () => {
  const src = readFileSync(S('detect.mjs'), 'utf8');
  const emitted = [...src.matchAll(/shape = '([a-z-]+)'/g)].map(m => m[1]);
  const guided = [...src.matchAll(/^\s+'?([a-z-]+)'?:\s*'[^']{20,}/gm)].map(m => m[1]);
  for (const sh of new Set(emitted))
    ok(guided.includes(sh), `shape '${sh}' is emitted but has no guidance`);
});

// ───────────── dependency behaviour verification ─────────────
// A type checker catches SHAPE changes only. It cannot catch the same call
// returning a different answer. These cover the machinery that finds where
// that matters.
console.log('\ndependency change detection');
t('lockdiff: understands every supported lockfile', () => {
  ok(LOCKFILES.length >= 10, `${LOCKFILES.length} lockfiles`);
  for (const f of ['package-lock.json', 'composer.lock', 'Cargo.lock', 'go.sum',
                   'Gemfile.lock', 'poetry.lock', 'mix.lock', 'pnpm-lock.yaml'])
    ok(LOCKFILES.includes(f), f);
});
t('lockdiff: classifies the size of a move', () => {
  eq(bump('1.0.0', '1.0.1').level, 'patch');
  eq(bump('1.0.0', '1.3.0').level, 'minor');
  eq(bump('1.0.0', '3.0.0').level, 'major');
  eq(bump('1.0.0', '3.0.0').majorsCrossed, 2);
  eq(bump('1.0.0', '1.0.0'), null, 'no move is not a change');
});
t('lockdiff: npm lockfile, added/removed/changed', () => {
  const before = JSON.stringify({ packages: { 'node_modules/a': { version: '1.0.0' },
                                              'node_modules/b': { version: '2.0.0' } } });
  const after = JSON.stringify({ packages: { 'node_modules/a': { version: '3.0.0' },
                                             'node_modules/c': { version: '1.0.0' } } });
  const d = diffLocks('package-lock.json', before, after);
  eq(d.counts.changed, 1); eq(d.counts.added, 1); eq(d.counts.removed, 1); eq(d.counts.major, 1);
  eq(d.changed[0].name, 'a');
});
t('lockdiff: a nested transitive package is read', () => {
  // transitive moves are where silent behaviour changes hide
  const before = JSON.stringify({ packages: { 'node_modules/a/node_modules/deep': { version: '1.0.0' } } });
  const after = JSON.stringify({ packages: { 'node_modules/a/node_modules/deep': { version: '2.0.0' } } });
  eq(diffLocks('package-lock.json', before, after).changed[0].name, 'deep');
});
t('lockdiff: composer and cargo', () => {
  const cb = JSON.stringify({ packages: [{ name: 'acme/x', version: 'v1.0.0' }] });
  const ca = JSON.stringify({ packages: [{ name: 'acme/x', version: 'v2.0.0' }] });
  eq(diffLocks('composer.lock', cb, ca).changed[0].level, 'major');
  const rb = '[[package]]\nname = "tokio"\nversion = "1.0.0"\n';
  const ra = '[[package]]\nname = "tokio"\nversion = "1.4.0"\n';
  eq(diffLocks('Cargo.lock', rb, ra).changed[0].level, 'minor');
});

t('lockdiff: the same package installed at several versions at once', () => {
  // a large repo installs duplicates constantly — nest ships semver at 2
  // versions and glob at 4. Collapsing them to one hid 4 of 6 real moves.
  const mk = o => JSON.stringify({ packages: Object.fromEntries(
    Object.entries(o).map(([k, v]) => [k, { version: v }])) });
  const before = mk({ 'node_modules/semver': '6.3.1', 'node_modules/sver/node_modules/semver': '6.3.1' });
  const after  = mk({ 'node_modules/semver': '7.8.5', 'node_modules/sver/node_modules/semver': '6.3.1' });
  const d = diffLocks('package-lock.json', before, after);
  eq(d.counts.changed, 1, 'the move must be seen even though a copy stayed put');
  eq(d.changed[0].from, '6.3.1'); eq(d.changed[0].to, '7.8.5');
  ok(d.changed[0].copies, 'and the duplication is reported');
  ok(/may resolve to any of them/.test(d.changed[0].note));
});
t('lockdiff: a reshuffled lockfile is not an upgrade', () => {
  // the mirror risk of keying by name: iteration order deciding the answer
  const mk = o => JSON.stringify({ packages: Object.fromEntries(
    Object.entries(o).map(([k, v]) => [k, { version: v }])) });
  const a = mk({ 'node_modules/x': '1.0.0', 'node_modules/p/node_modules/x': '2.0.0' });
  const b = mk({ 'node_modules/p/node_modules/x': '2.0.0', 'node_modules/x': '1.0.0' });
  eq(diffLocks('package-lock.json', a, b).counts.changed, 0);
});
t('lockdiff: npm lockfile v1 has no packages map', () => {
  const v1 = deps => JSON.stringify({ lockfileVersion: 1, dependencies: deps });
  const d = diffLocks('package-lock.json',
    v1({ a: { version: '1.0.0', dependencies: { b: { version: '2.0.0' } } } }),
    v1({ a: { version: '1.0.0', dependencies: { b: { version: '3.0.0' } } } }));
  eq(d.counts.changed, 1, 'the nested dependencies tree must be walked');
  eq(d.changed[0].name, 'b');
});

t('lockdiff: pnpm v9 quotes scoped keys', () => {
  // only SCOPED names are quoted in v9, so an unquoted-only pattern dropped
  // every @babel/*, @swc/*, @types/* — 0 of 2113 parsed on next.js
  const v9 = (ver) => `lockfileVersion: '9.0'\n\npackages:\n\n  '@babel/core@${ver}':\n    resolution: {integrity: sha}\n\n  postcss@8.5.23:\n    resolution: {integrity: sha}\n`;
  const d = diffLocks('pnpm-lock.yaml', v9('7.0.0'), v9('7.26.10'));
  eq(d.counts.changed, 1);
  eq(d.changed[0].name, '@babel/core');
});
t('lockdiff: pnpm v6 slash-prefixed keys still parse', () => {
  const v6 = (ver) => `lockfileVersion: 6.0\n\npackages:\n\n  /@babel/core@${ver}:\n    dev: false\n`;
  eq(diffLocks('pnpm-lock.yaml', v6('7.0.0'), v6('7.26.10')).changed[0].name, '@babel/core');
});

console.log('\nwhat a type checker can and cannot catch');
t('typecover: an untyped project is reported as unchecked', () => {
  const r = mkdtempSync(join(tmpdir(), 'ru-tc-'));
  try {
    writeFileSync(join(r, 'package.json'), '{"name":"x"}');
    const p = projectTypeChecking('node', r);
    eq(p.checker, null);
    ok(/NOTHING catches/.test(p.note), p.note);
  } finally { rmSync(r, { recursive: true, force: true }); }
});
t('typecover: TypeScript is detected, and strictness distinguished', () => {
  const r = mkdtempSync(join(tmpdir(), 'ru-tc2-'));
  try {
    writeFileSync(join(r, 'tsconfig.json'), '{"compilerOptions":{"strict":true}}');
    const p = projectTypeChecking('node', r);
    eq(p.checker, 'typescript'); eq(p.strict, true);
    writeFileSync(join(r, 'tsconfig.json'), '{"compilerOptions":{}}');
    ok(/non-strict/.test(projectTypeChecking('node', r).note));
  } finally { rmSync(r, { recursive: true, force: true }); }
});
t('typecover: a compiler is a checker, but never for behaviour', () => {
  for (const lang of ['go', 'rust', 'java', 'dotnet']) {
    const p = projectTypeChecking(lang, '/nonexistent');
    eq(p.enabled, true, lang);
    ok(/NOT behaviour/i.test(p.note), `${lang}: ${p.note}`);
  }
});
t('typecover: behaviour is NEVER statically checked, in any language', () => {
  // the whole premise: no configuration makes this true
  for (const lang of ['node', 'python', 'go', 'rust', 'java', 'ruby', 'php']) {
    const c = catchability(lang, '/nonexistent', 'anything');
    eq(c.behaviourChecked, false, lang);
    eq(c.needsRuntimeProbe, true, lang);
  }
});

t('typecover: "not installed" is unknown, never "checked"', () => {
  // shapeChecked was `pkg.typed !== false`, so a repo with no node_modules —
  // the normal state of a fresh clone — reported every package as statically
  // checked and majorsWithNoStaticCheck: 0. A safety claim from not looking.
  const r = mkdtempSync(join(tmpdir(), 'ru-tcu-'));
  try {
    writeFileSync(join(r, 'package.json'), '{"name":"x","dependencies":{"ghost":"1"}}');
    writeFileSync(join(r, 'tsconfig.json'), '{"compilerOptions":{"strict":true}}');
    const c = catchability('node', r, 'ghost');
    eq(c.verdict, 'unknown', JSON.stringify(c));
    eq(c.shapeChecked, false, 'must not claim a check it did not verify');
    ok(/unknown, not confirmed/.test(c.why), c.why);
    eq(c.behaviourChecked, false);
  } finally { rmSync(r, { recursive: true, force: true }); }
});

console.log('\nimport specifiers live inside strings');
t('strings: stripComments keeps the module specifier', () => {
  // stripNonCode blanks strings, which erases the package name being searched
  const src = "// require('ms') in a comment\nconst ms = require('ms');\n";
  const noComments = stripComments(src, 'node');
  ok(/require\('ms'\)/.test(noComments), `specifier erased: ${JSON.stringify(noComments)}`);
  ok(!/in a comment/.test(noComments), 'the comment is still removed');
  const full = stripNonCode(src, 'node');
  ok(!/'ms'/.test(full), 'stripNonCode still blanks strings, as it should');
});
t('strings: call sites are found, comment mentions are not', () => {
  const r = mkdtempSync(join(tmpdir(), 'ru-cs-'));
  try {
    writeFileSync(join(r, 'package.json'), '{"name":"x","dependencies":{"ms":"2.1.2"}}');
    writeFileSync(join(r, 'lock.before'), JSON.stringify({ packages: { 'node_modules/ms': { version: '2.1.2' } } }));
    writeFileSync(join(r, 'package-lock.json'), JSON.stringify({ packages: { 'node_modules/ms': { version: '3.0.0' } } }));
    mkdirSync(join(r, 'src'), { recursive: true });
    writeFileSync(join(r, 'src/real.js'), "const ms = require('ms');\n");
    writeFileSync(join(r, 'src/talk.js'), "// we should drop require('ms') one day\n");
    const v = runJson(process.execPath, [S('depverify.mjs'), 'node', r, '--before', join(r, 'lock.before')]);
    ok(v.data, 'produced JSON');
    const p = v.data.probePlan.find(x => x.package === 'ms');
    ok(p, 'ms is in the probe plan');
    eq(p.filesTouching, 1, 'only the real call site counts');
    eq(p.where[0].file, 'src/real.js');
  } finally { rmSync(r, { recursive: true, force: true }); }
});
t('depverify: refuses without a before-snapshot', () => {
  const r = mkdtempSync(join(tmpdir(), 'ru-nb-'));
  try {
    writeFileSync(join(r, 'package.json'), '{"name":"x"}');
    writeFileSync(join(r, 'package-lock.json'), '{"packages":{}}');
    const v = run(process.execPath, [S('depverify.mjs'), 'node', r]);
    ok(v.status !== 0, 'must refuse');
    ok(/before/i.test(v.stderr), 'and say a snapshot is needed BEFORE upgrading');
  } finally { rmSync(r, { recursive: true, force: true }); }
});
t('depverify: ranks an unchecked major above a checked patch', () => {
  const r = mkdtempSync(join(tmpdir(), 'ru-rank-'));
  try {
    writeFileSync(join(r, 'package.json'), '{"name":"x"}');
    writeFileSync(join(r, 'lock.before'), JSON.stringify({ packages: {
      'node_modules/big': { version: '1.0.0' }, 'node_modules/small': { version: '2.0.0' } } }));
    writeFileSync(join(r, 'package-lock.json'), JSON.stringify({ packages: {
      'node_modules/big': { version: '4.0.0' }, 'node_modules/small': { version: '2.0.1' } } }));
    mkdirSync(join(r, 'src'), { recursive: true });
    writeFileSync(join(r, 'src/a.js'), "require('big');require('big');\nrequire('small');\n");
    const v = runJson(process.execPath, [S('depverify.mjs'), 'node', r, '--before', join(r, 'lock.before')]);
    eq(v.data.probePlan[0].package, 'big', 'the major move ranks first');
    ok(v.data.probePlan[0].priority > v.data.probePlan[1].priority);
    ok(/different answer/i.test(v.data.theGap), 'and the premise is stated');
  } finally { rmSync(r, { recursive: true, force: true }); }
});
t('depverify: nextStep is a command you can actually run', () => {
  // this threw on a real repo because the field was named `name`, not `package`
  const r = mkdtempSync(join(tmpdir(), 'ru-ns-'));
  try {
    writeFileSync(join(r, 'package.json'), '{"name":"x","dependencies":{"ms":"2.1.3"}}');
    writeFileSync(join(r, 'lock.before'), JSON.stringify({ packages: { 'node_modules/ms': { version: '2.0.0' } } }));
    writeFileSync(join(r, 'package-lock.json'), JSON.stringify({ packages: { 'node_modules/ms': { version: '2.1.3' } } }));
    mkdirSync(join(r, 'src'), { recursive: true });
    writeFileSync(join(r, 'src/a.js'), "const ms = require('ms');\n");
    const v = runJson(process.execPath, [S('depverify.mjs'), 'node', r, '--before', join(r, 'lock.before')]);
    ok(v.data, 'produced JSON on a repo with a direct call site');
    const cmd = v.data.nextStep;
    ok(/probe\.mjs/.test(cmd), 'names the probe runner');
    const m = cmd.match(/node (\S+probe\.mjs) (\S+) (\S+) (\S+) (\S+) --probe (\S+)/);
    ok(m, `nextStep is not a parseable command:\n${cmd}`);
    ok(existsSync(m[1]), `probe runner path does not exist: ${m[1]}`);
    eq(m[2], 'node'); eq(m[3], 'ms'); eq(m[4], '2.0.0'); eq(m[5], '2.1.3');
    ok(m[6].endsWith('.mjs'), `wrong probe extension for node: ${m[6]}`);
    ok(!/undefined/.test(cmd), `nextStep contains "undefined": ${cmd}`);
  } finally { rmSync(r, { recursive: true, force: true }); }
});
t('depverify: no output field ever contains the string "undefined"', () => {
  const r = mkdtempSync(join(tmpdir(), 'ru-undef-'));
  try {
    writeFileSync(join(r, 'package.json'), '{"name":"x"}');
    writeFileSync(join(r, 'lock.before'), JSON.stringify({ packages: { 'node_modules/a': { version: '1.0.0' } } }));
    writeFileSync(join(r, 'package-lock.json'), JSON.stringify({ packages: { 'node_modules/a': { version: '2.0.0' } } }));
    const v = runJson(process.execPath, [S('depverify.mjs'), 'node', r, '--before', join(r, 'lock.before')]);
    ok(v.data, 'produced JSON');
    ok(!/"[^"]*undefined[^"]*"/.test(JSON.stringify(v.data)), 'a template literal interpolated undefined');
  } finally { rmSync(r, { recursive: true, force: true }); }
});
t('depverify: a transitive change is reported, not hidden', () => {
  const r = mkdtempSync(join(tmpdir(), 'ru-tr-'));
  try {
    writeFileSync(join(r, 'package.json'), '{"name":"x"}');
    writeFileSync(join(r, 'lock.before'), JSON.stringify({ packages: { 'node_modules/deep': { version: '1.0.0' } } }));
    writeFileSync(join(r, 'package-lock.json'), JSON.stringify({ packages: { 'node_modules/deep': { version: '2.0.0' } } }));
    const v = runJson(process.execPath, [S('depverify.mjs'), 'node', r, '--before', join(r, 'lock.before')]);
    eq(v.data.summary.changedButNotImported, 1);
    ok(/still reaches you/i.test(v.data.changedButNotImported[0].note));
  } finally { rmSync(r, { recursive: true, force: true }); }
});

// ───────────── source autofix ─────────────
console.log('\nsource autofix');
function fix(...a) { return runJson(process.execPath, [S('fix.mjs'), ...a]); }
function srcRepo(files, fn) {
  const r = mkdtempSync(join(tmpdir(), 'ru-fix-'));
  try {
    run('git', ['init', '-q'], { cwd: r });
    run('git', ['config', 'user.email', 't@t'], { cwd: r });
    run('git', ['config', 'user.name', 'T'], { cwd: r });
    for (const [f, body] of Object.entries(files)) {
      const full = join(r, f);
      const i = full.lastIndexOf('/');
      // a file with no directory part gave slice(0, -1) — a truncated path
      if (i > 0) mkdirSync(full.slice(0, i), { recursive: true });
      writeFileSync(full, body);
    }
    run('git', ['add', '-A'], { cwd: r }); run('git', ['commit', '-qm', 'init'], { cwd: r });
    return fn(r);
  } finally { rmSync(r, { recursive: true, force: true }); }
}

t('fix: only rules with a hand-written autofix are applied', () => {
  const all = Object.values(RULES).flat();
  const auto = all.filter(r => r.autofix);
  ok(auto.length >= 5, `expected a real autofix set, got ${auto.length}`);
  // a behaviour change needs a test, not an edit — never an autofix
  eq(all.filter(r => r.severity === 'behaviour' && r.autofix).length, 0,
     'no behaviour-class rule may carry an autofix');
  // An autofix must be a pure RENAME: same meaning, every time it matches.
  // Two rules broke this — PHP's `${}` rewrite (which also hit escaped dollars,
  // .env placeholders and preg backreferences) and Go's x/exp prefix strip
  // (whose stdlib replacements have different signatures). Both now report only.
  for (const r of auto)
    ok(!/scope.*any/.test(String(r.scope)) || r.scope !== 'any',
       `${r.what}: an autofix may not run on raw text including comments`);
});
t('fix: --list separates automatic from needs-a-human, with reasons', () => srcRepo(
  { 'package.json': '{"name":"x","engines":{"node":">=20"}}', 'a.js': 'const x = 1;\n' }, r => {
    const v = fix('node', r, '20.11.1', '26.12.1', '--list');
    ok(v.data.automatic.length >= 1, 'some rules are automatic');
    ok(v.data.needsAHuman.length >= 1, 'some need a human');
    for (const x of v.data.needsAHuman) ok(x.why && x.why.length > 30, `${x.id} must say why`);
    ok(/Nothing is written without --apply/.test(v.data.choiceIsYours), 'the choice is the user\'s');
  }));
t('fix: dry run writes nothing', () => srcRepo(
  { 'mix.exs': 'def project, do: [elixir: "~> 1.12"]\n', 'a.ex': 'Logger.warn("x")\n' }, r => {
    const before = readFileSync(join(r, 'a.ex'), 'utf8');
    const v = fix('elixir', r, '1.12', '1.20');
    eq(v.data.mode, 'dry-run');
    ok(v.data.editCount > 0, 'it found something');
    eq(readFileSync(join(r, 'a.ex'), 'utf8'), before, 'but changed nothing');
  }));
t('fix: NEVER edits inside a comment', () => srcRepo(
  { 'mix.exs': 'def project, do: [elixir: "~> 1.12"]\n',
    'a.ex': '# Logger.warn in a comment\nLogger.warn("real")\n' }, r => {
    const v = fix('elixir', r, '1.12', '1.20');
    eq(v.data.editCount, 1, 'exactly one edit — the real call, not the comment');
    eq(v.data.changes[0].edits[0].line, 2, 'on line 2');
  }));
t('scan: a dquote-scoped rule sees interpolation, and NOTHING else', () => srcRepo(
  { 'composer.json': '{"name":"a/b","require":{"php":"^8.0"}}',
    'real.php': '<?php\n$s = "hello ${name}";\n',
    'literal.php': "<?php\n$s = '${PUSHER_APP_KEY}';\n",
    'escaped.php': '<?php\n$s = "<?php \\${$v} = 1;";\n',
    'backref.php': "<?php\n$s = preg_replace('/x/', '${1}', 'y');\n",
    'comment.php': '<?php\n// use ${name} here\n',
    'tpl.blade.php': '<div x-text="`${total}`"></div>\n' }, r => {
    // The autofix for this rule rewrote all five of the non-findings into
    // valid-but-wrong PHP that `php -l` accepted. Detection must be narrow.
    const v = scan('php', r, '8.0', '8.4');
    const files = (v.data.details || []).map(d => d.file);
    eq(files.length, 1, `expected only real.php, got ${JSON.stringify(files)}`);
    eq(files[0], 'real.php');
  }));
t('fix: the php interpolation rule offers no autofix', () => srcRepo(
  { 'composer.json': '{"name":"a/b","require":{"php":"^8.0"}}',
    'a.php': '<?php\n$s = "hello ${name}";\n' }, r => {
    // it is reported, and left to a human — rewriting it is a judgement call
    const v = fix('php', r, '8.0', '8.4');
    eq(v.data.editCount, 0, 'must not rewrite');
    const rule = RULES.php.find(x => /\$\{\} string interpolation/.test(x.what));
    eq(rule.autofix, null);
    eq(rule.scope, 'dquote');
  }));
t('scan: a code-strings rule sees import paths but not prose', () => srcRepo(
  { 'go.mod': 'module x\n\ngo 1.20\n',
    'real.go': 'package main\nimport "golang.org/x/exp/slices"\n',
    'prose.go': 'package main\n// we should drop golang.org/x/exp/slices someday\n' }, r => {
    const v = scan('go', r, '1.20', '1.27');
    const files = (v.data.details || []).map(d => d.file);
    eq(files.length, 1, `expected only real.go, got ${JSON.stringify(files)}`);
    eq(files[0], 'real.go');
  }));
t('fix: the go x/exp rule offers no autofix', () => srcRepo(
  { 'go.mod': 'module x\n\ngo 1.20\n',
    'a.go': 'package main\nimport "golang.org/x/exp/slices"\n' }, r => {
    // stripping the prefix compiles to a DIFFERENT program: stdlib maps.Keys
    // returns iter.Seq, and slices.SortFunc takes cmp() int, not less() bool
    const v = fix('go', r, '1.20', '1.27');
    eq(v.data.editCount, 0, 'must not rewrite');
    const rule = RULES.go.find(x => /graduated to the stdlib/.test(x.what));
    eq(rule.autofix, null);
    ok(/signatures CHANGED/.test(rule.fix), 'and must say why it is a port');
  }));
t('fix: --only applies a subset', () => srcRepo(
  { 'mix.exs': 'def project, do: [elixir: "~> 1.12"]\n',
    'a.ex': 'use Bitwise\nLogger.warn("x")\n' }, r => {
    const all = fix('elixir', r, '1.12', '1.20');
    ok(all.data.editCount >= 2, 'both found by default');
    const one = fix('elixir', r, '1.12', '1.20', '--only', all.data.rulesSelected[0]);
    ok(one.data.editCount < all.data.editCount, 'a subset applies fewer');
  }));
t('fix: --apply refuses where guard would refuse', () => srcRepo(
  { 'mix.exs': 'def project, do: [elixir: "~> 1.12"]\n', 'a.ex': 'Logger.warn("x")\n' }, r => {
    const before = readFileSync(join(r, 'a.ex'), 'utf8');
    const v = fix('elixir', r, '1.12', '1.20', '--apply');     // still on the default branch
    eq(v.data.refused, true, 'must refuse');
    eq(readFileSync(join(r, 'a.ex'), 'utf8'), before, 'and write nothing');
  }));
t('fix: --apply writes on a guarded branch', () => srcRepo(
  { 'mix.exs': 'def project, do: [elixir: "~> 1.12"]\n',
    'a.ex': '# Logger.warn stays\nLogger.warn("x")\nMix.Config.config(:a)\n' }, r => {
    runJson(process.execPath, [S('guard.mjs'), 'branch', r, 'elixir', '1.20.4']);
    const v = fix('elixir', r, '1.12', '1.20', '--apply');
    eq(v.data.mode, 'apply');
    const out = readFileSync(join(r, 'a.ex'), 'utf8');
    ok(/# Logger\.warn stays/.test(out), 'the comment is untouched');
    ok(/Logger\.warning\("x"\)/.test(out), 'the call is rewritten');
    ok(/^Config\.config/m.test(out), 'Mix.Config is rewritten');
  }));
t('fix: overlapping matches never corrupt a line', () => srcRepo(
  { 'mix.exs': 'def project, do: [elixir: "~> 1.12"]\n',
    'a.ex': 'Logger.warn(Logger.warn("nested"))\n' }, r => {
    const v = fix('elixir', r, '1.12', '1.20');
    const after = v.data.changes[0].diff.split('\n').filter(l => l.startsWith('+') && !l.startsWith('+++'))[0];
    ok(!/warninging|warningwarn/.test(after), `mangled output: ${after}`);
  }));

// ───────────── pull requests ─────────────
console.log('\npull requests — user picks the tool');
function pr(...a) { return runJson(process.execPath, [S('pr.mjs'), ...a]); }
t('pr: detect lists every tool and never decides', () => gitRepo(r => {
  const v = pr('detect', r);
  ok(v.data, 'produced JSON');
  const ids = v.data.available.map(t => t.id).sort();
  eq(ids, ['az', 'bb', 'gh', 'glab', 'patch', 'push', 'tea'],
     'GitHub, GitLab, Azure DevOps, Gitea and Bitbucket, plus two universal routes');
  ok(v.data.suggestion, 'a suggestion exists');
  ok(/not a decision|whichever/i.test(v.data.choiceIsYours), 'and it is framed as the user\'s choice');
  // each route either carries a note or says how to authenticate
  for (const t2 of v.data.available)
    ok((t2.note && t2.note.length > 10) || (t2.auth && t2.auth.length > 5),
       `${t2.id} must explain itself or say how to authenticate`);
}));
t('pr: open without --tool refuses and explains the options', () => gitRepo(r => {
  const v = run(process.execPath, [S('pr.mjs'), 'open', r]);
  ok(v.status !== 0, 'must not proceed');
  const j = JSON.parse(v.stdout);
  eq(j.error, 'no --tool given');
  eq(j.howToChoose.length, PR_PROVIDERS.length, 'every route explained');
}));
t('pr: open without --push changes nothing', () => gitRepo(r => {
  run('git', ['checkout', '-qb', 'runtime/node-24.22.1'], { cwd: r });
  writeFileSync(join(r, 'package.json'), '{"name":"x","engines":{"node":">=24.22.1 <25"}}');
  run('git', ['commit', '-aqm', 'pin'], { cwd: r });
  const v = pr('open', r, '--tool', 'push');
  eq(v.data.pushed, false, 'nothing pushed');
  eq(v.data.opened, false, 'nothing opened');
  ok(/dry run/.test(v.data.note), 'and it says so');
}));
t('pr: patch tool writes files and contacts no remote', () => gitRepo(r => {
  run('git', ['checkout', '-qb', 'runtime/node-24.22.1'], { cwd: r });
  writeFileSync(join(r, 'package.json'), '{"name":"x","engines":{"node":">=24.22.1 <25"}}');
  run('git', ['commit', '-aqm', 'pin'], { cwd: r });
  const v = pr('open', r, '--tool', 'patch', '--out', join(r, 'out.patch'));
  eq(v.data.pushed, false);
  ok(v.data.wrote.length === 2, 'patch + body written');
  ok(readFileSync(join(r, 'out.patch'), 'utf8').includes('Subject:'), 'a real patch');
}));
t('pr: refuses to open a PR for a branch with no commits', () => gitRepo(r => {
  run('git', ['checkout', '-qb', 'runtime/node-24.22.1'], { cwd: r });
  const v = run(process.execPath, [S('pr.mjs'), 'open', r, '--tool', 'patch', '--push']);
  ok(v.status !== 0 && /no commits ahead/.test(v.stderr), 'refuses an empty branch');
}));
t('pr: never contains a force-push path', () => {
  const src = readFileSync(S('pr.mjs'), 'utf8').split('\n').filter(l => !l.trim().startsWith('//')).join('\n');
  ok(!/--force|\+HEAD|forceWithLease/.test(src), 'no force push anywhere');
});

// ───────────────────────── CI and build config ─────────────────────────
console.log('\nCI and build config rewriting');
t('config: CI runtime version is rewritten', () => withFixture('ci-and-config', r => {
  const e = planCiEdits('node', r, '24.22.1');
  ok(e.length === 1, `expected 1 CI file, got ${e.length}`);
  ok(/node-version: 24\.22\.1/.test(e[0].after), 'node version moved');
}));
t('config: a sibling python-version is left alone', () => withFixture('ci-and-config', r => {
  const e = planCiEdits('node', r, '24.22.1');
  ok(/python-version: 3\.11/.test(e[0].after), 'python must not be touched by a node upgrade');
}));
t('config: a CI matrix is never collapsed', () => withFixture('ci-and-config', r => {
  const e = planCiEdits('node', r, '24.22.1');
  ok(/\[18\.20\.0, 20\.11\.1\]/.test(e[0].after), 'the matrix list must survive verbatim');
  const adv = ciMatrixAdvice('node', r, '18.20.0', '24.22.1');
  ok(adv && /migration window/.test(adv.advice), 'and the advice must explain why');
}));
t('config: tsconfig target and engine-strict move with the runtime', () => withFixture('ci-and-config', r => {
  const e = planConfigEdits('node', r, '24.22.1');
  const files = e.map(x => x.file);
  ok(files.includes('tsconfig.json'), 'tsconfig');
  ok(files.includes('.npmrc'), 'npmrc');
  ok(/ES2023/.test(e.find(x => x.file === 'tsconfig.json').after), 'target raised');
  ok(/engine-strict=true/.test(e.find(x => x.file === '.npmrc').after), 'engines made enforcing');
}));

// ───────────────── version precision in written edits ─────────────────
// Every case here was a real wrong edit found by running the tool against
// real open-source repositories. A wrong edit is worse than no edit.
console.log('\nedit precision (regressions from real repos)');
const applyRule = (lang, target, file, before) => {
  const r = PIN_RULES[lang](target).find(x => x.file === file || (x.glob && x.glob.test(file)));
  ok(r, `${lang} has no rule for ${file}`);
  return r.edit(before);
};

t('precision: go directive is major.minor, never a patch', () => {
  // gorilla/mux: `go 1.20` became `go 1.27.3`
  eq(applyRule('go', '1.27.3', 'go.mod', 'module x\n\ngo 1.20\n').trim().split('\n').pop(), 'go 1.27');
});
t('precision: composer caret takes major.minor, not a patch', () => {
  // briannesbitt/Carbon: "^8.1" became "^8.5.12", pinning consumers to a patch
  const out = applyRule('php', '8.5.12', 'composer.json', '{"require":{"php":"^8.1"}}');
  ok(/"php":"\^8\.5"/.test(out), out);
});
t('precision: elixir ~> keeps the minor window open', () => {
  // elixir-plug/plug: "~> 1.15" became "~> 1.20.4", narrowing >=1.20 <2.0 to >=1.20.4 <1.21
  const out = applyRule('elixir', '1.20.4', 'mix.exs', 'def project, do: [elixir: "~> 1.15"]');
  ok(/~> 1\.20"/.test(out), out);
});
t('precision: python requires-python is a minor floor', () => {
  // pallets/click: ">=3.10" became ">=3.15.1", rejecting every earlier 3.15 patch
  const out = applyRule('python', '3.15.1', 'pyproject.toml', '[project]\nrequires-python = ">=3.10"\n');
  ok(/">=3\.15"/.test(out), out);
});
t('precision: rust MSRV is major.minor', () => {
  // BurntSushi/ripgrep: rust-version became "1.99.1"; MSRV convention is "1.99"
  const out = applyRule('rust', '1.99.1', 'Cargo.toml', '[package]\nrust-version = "1.96"\n');
  ok(/rust-version = "1\.99"/.test(out), out);
});
t('precision: ruby required_ruby_version is a floor', () => {
  // sinatra: '>= 2.7.8' became '>= 4.0.9'
  const out = applyRule('ruby', '4.0.9', 'x.gemspec', "s.required_ruby_version = '>= 2.7.8'\n");
  ok(/>= 4\.0'/.test(out), out);
});
t('precision: perl keeps its zero-padded numeric form', () => {
  // mojolicious/mojo: `use 5.016;` became `use 5.44.0;`, which Perl reads differently
  const out = applyRule('perl', '5.44.0', 'Makefile.PL', "use 5.016;\nrequires => {perl => '5.016'},\n");
  ok(/use 5\.044;/.test(out), out);
  ok(!/5\.44\.0/.test(out), 'must not emit a v-string where a numeric literal was');
});
t('precision: scala NEVER rewrites a cross-build val of another series', () => {
  // typelevel/cats: `val Scala213 = "2.13.18"` was rewritten to "3.10.0",
  // silently destroying the 2.13 cross-build
  const src = 'val Scala212 = "2.12.21"\nval Scala213 = "2.13.18"\nval Scala3 = "3.3.8"\n'
            + 'ThisBuild / scalaVersion := Scala213\n';
  const out = applyRule('scala', '3.10.0', 'build.sbt', src);
  ok(/val Scala213 = "2\.13\.18"/.test(out), 'the 2.13 val must survive untouched');
  ok(/val Scala212 = "2\.12\.21"/.test(out), 'and so must 2.12');
});
t('precision: scala DOES rewrite a val of the same series', () => {
  const src = 'val Scala3 = "3.3.8"\nThisBuild / scalaVersion := Scala3\n';
  const out = applyRule('scala', '3.10.0', 'build.sbt', src);
  ok(/val Scala3 = "3\.10\.0"/.test(out), out);
});
t('precision: dotnet leaves a same-band SDK pin alone', () => {
  // serilog: global.json SDK 10.0.100 was rewritten to runtime 10.0.13 — a downgrade
  const out = applyRule('dotnet', '10.0.13', 'global.json', '{"sdk":{"version":"10.0.100"}}');
  eq(out, '{"sdk":{"version":"10.0.100"}}', 'same feature band: no edit');
});
t('precision: erlang rewrites the erlang.mk Makefile pin', () => {
  // ninenines/cowboy pins OTP in the Makefile, not rebar.config
  const out = applyRule('erlang', '29.1.2', 'Makefile', 'AUTO_CI_OTP ?= OTP-LATEST-27+\n');
  ok(/OTP-LATEST-29\+/.test(out), out);
});

// ───────────── add-a-pin when the manifest declares none ─────────────
console.log('\nadd-pin');
t('addpin: creates a version file when the manifest pins nothing', () => {
  const r = mkdtempSync(join(tmpdir(), 'ru-addpin-'));
  try {
    writeFileSync(join(r, 'deno.json'), '{"version":"17.2.0"}');
    const e = planAddPin('deno', r, '2.9.8');
    ok(e && e.created, 'a pin is created');
    eq(e.file, '.deno-version');
    ok(!/17\.2\.0/.test(e.after), 'must not confuse the package version with the runtime version');
  } finally { rmSync(r, { recursive: true, force: true }); }
});
t('addpin: adds engines.node without disturbing the rest of package.json', () => {
  const r = mkdtempSync(join(tmpdir(), 'ru-addpin2-'));
  try {
    writeFileSync(join(r, 'package.json'), '{\n  "name": "x",\n  "scripts": { "test": "t" }\n}\n');
    const e = planAddPin('node', r, '24.22.1');
    ok(e && !e.created, 'edits the existing manifest');
    const o = JSON.parse(e.after);
    eq(o.name, 'x'); eq(o.scripts.test, 't');
    ok(/^>=24\.22$/.test(o.engines.node), `a floor, with no upper cap: ${o.engines.node}`);
  } finally { rmSync(r, { recursive: true, force: true }); }
});
t('addpin: never fires when a pin already exists', () => {
  const r = mkdtempSync(join(tmpdir(), 'ru-addpin3-'));
  try {
    writeFileSync(join(r, 'package.json'), '{"name":"x","engines":{"node":">=20"}}');
    eq(planAddPin('node', r, '24.22.1'), null);
  } finally { rmSync(r, { recursive: true, force: true }); }
});
t('addpin: every language that CAN add a pin, does', () => {
  // dotnet is deliberately absent. A global.json does not exist by default, and
  // creating one makes every contributor's build select a specific SDK — a
  // version that is not derivable from a runtime release number anyway.
  const DELIBERATELY_ABSENT = new Set(['dotnet']);
  for (const a of adapters) {
    if (DELIBERATELY_ABSENT.has(a.id)) {
      eq(ADD_PIN_RULES[a.id], undefined, `${a.id} must NOT invent a pin`);
      continue;
    }
    ok(ADD_PIN_RULES[a.id], `${a.id} has no add-pin rule`);
  }
});
t('addpin: the reason dotnet has none is written down', () => {
  const src = readFileSync(join(HERE, '..', 'scripts', 'lib', 'edits.mjs'), 'utf8');
  ok(/No dotnet entry on purpose/.test(src), 'a deliberate omission must say so');
});

// ───────────────────────── the plan ─────────────────────────
console.log('\nplan synthesis');
function plan(...a) { return runJson(process.execPath, [S('plan.mjs'), ...a]); }

t('plan: emits ordered steps with exit conditions', () => withFixture('breaking-src', r => {
  const v = plan(r, '--target', '26.12.1', '--policy', 'gate');
  ok(v.data, 'produced JSON');
  const p = v.data.plans[0];
  ok(p.steps.length >= 3, `expected >=3 steps, got ${p.steps.length}`);
  for (const s of p.steps) {
    ok(s.title && s.why && s.exit, `step ${s.n} must have title, why and exit`);
    ok(Array.isArray(s.actions) && s.actions.length, `step ${s.n} must have actions`);
  }
  eq(p.steps.map(s => s.n), p.steps.map((_, i) => i + 1), 'steps are numbered in order');
}));
t('plan: hard blockers are cleared before the runtime moves', () => withFixture('breaking-src', r => {
  const p = plan(r, '--target', '26.12.1').data.plans[0];
  const phases = p.steps.map(s => s.phase);
  const ri = phases.indexOf('runtime');
  if (phases.includes('unblock')) ok(phases.indexOf('unblock') < ri, 'unblock precedes runtime');
  if (phases.includes('characterize')) ok(phases.indexOf('characterize') < ri, 'characterize precedes runtime');
  ok(phases.indexOf('dependencies') > ri, 'dependencies follow the runtime, in their own step');
  ok(phases.indexOf('verify') === phases.length - 1, 'verify is last');
}));
t('plan: carries rollback, test strategy and risk', () => withFixture('breaking-src', r => {
  const p = plan(r, '--target', '26.12.1').data.plans[0];
  ok(p.rollback?.trigger && p.rollback.procedure.length, 'rollback with a trigger');
  ok(p.testStrategy?.ladder.length >= 4, 'a test ladder');
  ok(p.testStrategy.deprecationsFatal.length > 5, 'how to make deprecations fatal');
  ok(['low', 'medium', 'high'].includes(p.risk.level), 'a risk level');
  ok(p.risk.signals.length, 'with named signals');
}));
t('plan: estimate scales with the work', () => withFixture('breaking-src', r => {
  const withBreaks = plan(r, '--target', '26.12.1').data.plans[0].estimatePoints;
  const clean = withFixture('single-node', r2 => plan(r2, '--target', '24.22.1').data.plans[0].estimatePoints);
  ok(withBreaks > clean, `a repo with breaking changes must estimate higher (${withBreaks} vs ${clean})`);
}));
t('plan: separates pre-existing debt from upgrade blockers', () => withFixture('breaking-src', r => {
  const p = plan(r, '--target', '26.12.1').data.plans[0];
  ok(p.technicalDebt.length > 0, 'debt is reported');
  ok(!p.blockers.some(b => /url\.parse/.test(b.detail || '')), 'but never counted as a blocker');
}));
t('plan: markdown renders without placeholders', () => withFixture('breaking-src', r => {
  const v = run(process.execPath, [S('plan.mjs'), r, '--target', '26.12.1', '--format', 'md']);
  ok(v.stdout.includes('# Upgrade plan'), 'has a heading');
  ok(!/undefined|\$SK|\[object Object\]/.test(v.stdout), 'no unexpanded placeholders');
  ok(/### Rollback/.test(v.stdout) && /### Test strategy/.test(v.stdout), 'carries every section');
}));


// ───────── multi-language and container-variant correctness ─────────
console.log('\nmulti-language targets');
t('multilang: an ambiguous target is applied to NO language', () => withFixture('polyglot', r => {
  // handing a Kotlin version to a Java target produced "java 8 -> 2.4.0".
  // With several languages and one bare --target, the safe reading is that it
  // belongs to none of them: each resolves its own.
  const v = plan(r, '--target', '24.22.1');
  ok(v.data, 'produced JSON');
  for (const p of v.data.plans)
    ok(p.target !== '24.22.1' || p.lang === 'node',
       `${p.lang} must not inherit another language's target (got ${p.target})`);
  const go = v.data.plans.find(p => p.lang === 'go');
  ok(go && /^1\./.test(go.target), `go resolved its own target: ${go?.target}`);
}));
t('multilang: --target applies when the language is unambiguous', () => withFixture('polyglot', r => {
  const v = plan(r, '--lang', 'node', '--target', '24.22.1');
  const node = v.data.plans.find(p => p.lang === 'node');
  eq(node.target, '24.22.1', 'one language in scope: the target applies');
}));
t('multilang: per-language targets can be given explicitly', () => withFixture('polyglot', r => {
  const v = plan(r, '--target', 'node=24.22.1,go=1.24.0');
  eq(v.data.plans.find(p => p.lang === 'node').target, '24.22.1', 'node');
  eq(v.data.plans.find(p => p.lang === 'go').target, '1.24.0', 'go');
  const php = v.data.plans.find(p => p.lang === 'php');
  ok(php && php.target !== '24.22.1' && php.target !== '1.24.0', 'php resolves its own');
}));
t('multilang: the repo root is the headline target', () => withFixture('mixed-single', r => {
  // mixed-single has BOTH node and php at the root
  const v = plan(r);
  const dirs = v.data.plans.map(p => p.dir);
  eq(dirs[0], '.', `root must sort first, got ${dirs.join(',')}`);
}));
t('multilang: an ambiguous single target is flagged, not silently applied', () => withFixture('polyglot', r => {
  const v = run(process.execPath, [S('plan.mjs'), r, '--target', '24.22.1']);
  ok(/applies to one language/.test(v.stderr), 'the ambiguity is reported on stderr');
}));

console.log('\ncontainer variant suffixes');
t('suffix: an Alpine too old for the runtime is moved forward', () => {
  // Node 24 musl builds need Alpine >= 3.20; leaving -alpine3.19 yields an
  // image that cannot run the runtime it claims to pin
  eq(mapSuffix('-alpine3.19'), '-alpine3.22');
  eq(mapSuffix('-alpine3.20'), '-alpine3.22');
  eq(mapSuffix('-bullseye'), '-bookworm');
  eq(mapSuffix('-alpine3.22'), '-alpine3.22', 'a current variant is left alone');
  eq(mapSuffix('-slim'), '-slim', 'an unknown variant is preserved verbatim');
});
t('suffix: CI container images get the same mapping as Dockerfiles', () => {
  const r = mkdtempSync(join(tmpdir(), 'ru-sfx-'));
  try {
    writeFileSync(join(r, 'package.json'), '{"name":"x"}');
    mkdirSync(join(r, '.github', 'workflows'), { recursive: true });
    writeFileSync(join(r, '.github/workflows/ci.yml'),
      'jobs:\n  b:\n    container:\n      image: node:20.11.1-alpine3.19\n');
    writeFileSync(join(r, 'Dockerfile'), 'FROM node:20.11.1-alpine3.19\n');
    const ci = planCiEdits('node', r, '24.22.1');
    const df = PIN_RULES.node('24.22.1').find(x => x.file === 'Dockerfile')
      .edit('FROM node:20.11.1-alpine3.19\n');
    ok(/alpine3\.22/.test(ci[0].after), `CI: ${ci[0].after.trim()}`);
    ok(/alpine3\.22/.test(df), `Dockerfile: ${df.trim()}`);
  } finally { rmSync(r, { recursive: true, force: true }); }
});

// ───────────── forges and issue trackers ─────────────
console.log('\nforges and trackers');
function issue(...a) { return runJson(process.execPath, [S('issue.mjs'), ...a]); }

t('forge: every major host is identified from its remote URL', () => {
  const cases = [
    ['git@github.com:a/b.git', 'github'],
    ['https://gitlab.com/a/b.git', 'gitlab'],
    ['git@bitbucket.org:a/b.git', 'bitbucket'],
    ['https://dev.azure.com/org/proj/_git/repo', 'azure'],
    ['https://acme.visualstudio.com/proj/_git/repo', 'azure'],
    ['https://codeberg.org/a/b.git', 'gitea'],
    ['https://gitlab.internal.corp/a/b.git', 'gitlab'],
  ];
  for (const [url, want] of cases) eq(hostOf(url), want, url);
  // a self-hosted forge we do not recognise is reported verbatim, not guessed
  eq(hostOf('git@git.acme.internal:a/b.git'), 'git.acme.internal');
  eq(hostOf(null), null);
});
t('forge: a compare URL is produced per forge', () => {
  for (const host of ['github', 'gitlab', 'bitbucket', 'azure']) {
    const u = compareUrl(host, 'a/b', 'main', 'runtime/node-24');
    ok(u && u.startsWith('http'), `${host}: ${u}`);
    ok(u.includes('runtime/node-24'), `${host} URL names the branch`);
  }
});
t('forge: PR providers cover GitHub, GitLab, Azure, Gitea, Bitbucket + 2 universal', () => {
  const ids = PR_PROVIDERS.map(p => p.id);
  for (const want of ['gh', 'glab', 'az', 'tea', 'bb', 'push', 'patch']) ok(ids.includes(want), want);
  // every CLI provider must know how to build its own arguments and say how to auth
  for (const p of PR_PROVIDERS.filter(x => x.args)) {
    ok(typeof p.args === 'function', `${p.id} args`);
    ok(p.auth, `${p.id} must say how to authenticate`);
    const a = p.args({ base: 'main', branch: 'b', title: 't', body: 'd' });
    ok(Array.isArray(a) && a.length > 3, `${p.id} builds args`);
  }
});
t('forge: a suggestion is never null — there is always a route', () => {
  for (const host of ['github', 'gitlab', 'azure', 'bitbucket', 'gitea', 'git.acme.internal', null])
    ok(pickSuggestion(PR_PROVIDERS, host), `no suggestion for ${host}`);
});
t('tracker: providers cover Jira, Azure Boards, GitHub, GitLab, Linear, Gitea + CLI-less', () => {
  const ids = ISSUE_PROVIDERS.map(p => p.id);
  for (const want of ['jira', 'jira-mcp', 'az-boards', 'gh-issue', 'glab-issue', 'linear', 'tea-issue', 'csv', 'markdown'])
    ok(ids.includes(want), want);
  for (const p of ISSUE_PROVIDERS.filter(x => x.args)) {
    const a = p.args({ title: 't', body: 'b', type: 'Task', labels: ['x'] });
    ok(Array.isArray(a) && a.includes('t'), `${p.id} passes the title through`);
  }
});
t('tracker: csv and markdown need no CLI and contact nothing', () => {
  for (const id of ['csv', 'markdown', 'jira-mcp']) {
    const p = ISSUE_PROVIDERS.find(x => x.id === id);
    eq(p.bin, null, `${id} must need no binary`);
  }
});
t('tracker: create without --tool refuses and lists every option', () => {
  const r = mkdtempSync(join(tmpdir(), 'ru-iss-'));
  try {
    writeFileSync(join(r, 'plan.json'), JSON.stringify({ totalEstimatePoints: 5, plans: [
      { dir: '.', name: 'svc', lang: 'node', current: '20.11.1', target: '24.22.1',
        verdict: 'proceed', estimatePoints: 5, risk: { level: 'low', signals: [] },
        eol: { isEol: true, date: '2026-04-30', targetEol: '2028-04-30' },
        cve: { gateCapable: true, currentBlocking: 12, targetBlocking: 0, removed: 12 },
        steps: [{ n: 1, title: 'x', why: 'y', exit: 'z' }] }] }));
    const v = run(process.execPath, [S('issue.mjs'), 'create', '--plan', join(r, 'plan.json')]);
    ok(v.status !== 0, 'must not proceed');
    const j = JSON.parse(v.stdout);
    eq(j.error, 'no --tool given');
    eq(j.howToChoose.length, ISSUE_PROVIDERS.length, 'every tracker is explained');
    eq(j.ticketsReady, 2, 'an epic plus one task');
  } finally { rmSync(r, { recursive: true, force: true }); }
});
t('tracker: csv output is valid and carries the epic + each target', () => {
  const r = mkdtempSync(join(tmpdir(), 'ru-iss2-'));
  try {
    writeFileSync(join(r, 'plan.json'), JSON.stringify({ totalEstimatePoints: 9, plans: [
      { dir: 'a', name: 'a', lang: 'node', current: '20', target: '24', verdict: 'proceed',
        estimatePoints: 4, risk: { level: 'high', signals: ['x'] }, steps: [] },
      { dir: 'b', name: 'b', lang: 'php', current: '8.1', target: '8.4', verdict: 'proceed',
        estimatePoints: 5, risk: { level: 'low', signals: [] }, steps: [] }] }));
    const out = join(r, 'out.csv');
    const v = issue('create', r, '--plan', join(r, 'plan.json'), '--tool', 'csv', '--out', out);
    eq(v.data.filed, false, 'csv files nothing remotely');
    const text = readFileSync(out, 'utf8');
    const Q = String.fromCharCode(34);
    let quotes = 0; for (const c of text) if (c === Q) quotes++;
    eq(quotes % 2, 0, 'quotes are balanced');
    ok(/Epic/.test(text) && /node 20 -> 24/.test(text) && /php 8\.1 -> 8\.4/.test(text), 'all rows present');
    ok(/high-risk/.test(text), 'risk is carried into labels');
  } finally { rmSync(r, { recursive: true, force: true }); }
});
t('tracker: an uninstalled CLI still shows the command and the alternatives', () => {
  const r = mkdtempSync(join(tmpdir(), 'ru-iss3-'));
  try {
    writeFileSync(join(r, 'plan.json'), JSON.stringify({ plans: [
      { dir: '.', name: 's', lang: 'node', current: '20', target: '24', verdict: 'proceed',
        estimatePoints: 3, risk: { level: 'low', signals: [] }, steps: [] }] }));
    const v = issue('create', r, '--plan', join(r, 'plan.json'), '--tool', 'linear');
    eq(v.data.filed, false);
    ok(v.data.setup && /install linear/.test(v.data.setup), 'says how to install');
    ok(v.data.alternatives.includes('--tool csv'), 'offers a route that needs nothing');
    ok(v.data.wouldRun.length >= 2, 'shows the commands it would run');
  } finally { rmSync(r, { recursive: true, force: true }); }
});
t('tracker: PR tool and issue tool are independent choices', () => {
  // reviewing on GitHub while tracking in Jira is normal
  const prIds = new Set(PR_PROVIDERS.map(p => p.id));
  const issueIds = new Set(ISSUE_PROVIDERS.map(p => p.id));
  eq([...prIds].filter(x => issueIds.has(x)), [], 'the two registries share no ids');
});

// ───────────────────────── doctor ─────────────────────────
console.log('\ndoctor');
t('doctor: every forge and tracker CLI is reported', () => {
  // doctor had a hardcoded tool list, so the seven forge/tracker CLIs added
  // later were invisible. It now derives them from the provider registries.
  const d = runJson(process.execPath, [S('doctor.mjs')]);
  const known = new Set(d.data.tools.map(t => t.tool));
  for (const p of [...PR_PROVIDERS, ...ISSUE_PROVIDERS])
    if (p.bin && p.bin !== 'git') ok(known.has(p.bin), `${p.bin} is not reported by doctor`);
});
t('doctor: there is always a usable route with no CLI', () => {
  const d = runJson(process.execPath, [S('doctor.mjs')]);
  ok(d.data.alwaysAvailable.pullRequest.length >= 2, 'at least push and patch');
  ok(d.data.alwaysAvailable.issues.length >= 2, 'at least csv and markdown');
  ok(d.data.pullRequestRoutes.some(r => r.usable), 'some PR route is usable right now');
  ok(d.data.issueRoutes.some(r => r.usable), 'some issue route is usable right now');
});
t('reports tools and what degrades', () => {
  const d = runJson(process.execPath, [S('doctor.mjs')]);
  ok(d.data, 'doctor produced JSON');
  ok(d.data.tools.length > 5, 'tool list');
  ok(d.data.tools.every(t => t.present || t.degradesWithout), 'every absent tool explains the cost');
  eq(d.data.missingRequired, [], 'node itself must be present');
});

// ───────────────────────── summary ─────────────────────────
console.log(`\n\x1b[32m${pass} passed\x1b[0m  \x1b[31m${fail} failed\x1b[0m  \x1b[33m${skip} skipped\x1b[0m`);
if (failures.length) {
  console.log('\nfailures:');
  for (const [n, m] of failures) console.log(`  ${n}\n    ${m}`);
}
process.exit(fail > 0 ? 1 : 0);
