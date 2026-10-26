#!/usr/bin/env node
// Zero-dependency test runner. `node tests/run.mjs [--filter substr]`
// Network-dependent cases are skipped automatically when offline or unreachable.
import { build, destroy, FIXTURES } from './fixtures.mjs';
import { runJson, run } from '../scripts/lib/sh.mjs';
import { fetchJson } from '../scripts/lib/io.mjs';
import { satisfies, rangeMajor, rangeMajorMinor, compare } from '../scripts/lib/semver.mjs';
import { adapters, byId, adaptersForManifest } from '../scripts/adapters/index.mjs';
import { FRAMEWORK_MAP, UNTRACKED, frameworkEol } from '../scripts/lib/frameworks.mjs';
import { PIN_RULES, planPinEdits, unified, planCiEdits, planConfigEdits, ciMatrixAdvice,
         planAddPin, ADD_PIN_RULES } from '../scripts/lib/edits.mjs';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
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
const withFixture = (name, fn) => { const r = build(name); try { return fn(r); } finally { destroy(r); } };

// ───────────────────────── semver ─────────────────────────
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
const guard = (...a) => runJson(process.execPath, [S('guard.mjs'), ...a]);
const guardRaw = (...a) => run(process.execPath, [S('guard.mjs'), ...a]);

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
const remediate = (...a) => runJson(process.execPath, [S('remediate.mjs'), ...a]);

t('remediate: dry-run writes nothing', () => withFixture('single-node', r => {
  const before = readFileSync(join(r, 'package.json'), 'utf8');
  const v = remediate('node', r, '24.22.1', '--deps', 'none');
  ok(v.data, 'produced JSON');
  eq(v.data.mode, 'dry-run');
  ok(v.data.runtimePins.count >= 3, `expected >=3 pins, got ${v.data.runtimePins.count}`);
  eq(readFileSync(join(r, 'package.json'), 'utf8'), before, 'file must be byte-identical');
}));
t('remediate: rewrites every pin location for node', () => withFixture('single-node', r => {
  const v = remediate('node', r, '24.22.1', '--deps', 'none');
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
    const v = remediate('node', r, '24.22.1', '--deps', 'none', '--apply');
    eq(v.data.mode, 'apply');
    ok(!v.data.refused, 'must not refuse on a runtime/* branch');
    eq(readFileSync(join(r, '.nvmrc'), 'utf8').trim(), 'v24.22.1', 'nvmrc rewritten');
    ok(/">=24\.22\.1 <25"/.test(readFileSync(join(r, 'package.json'), 'utf8')), 'engines rewritten');
  } finally { rmSync(r, { recursive: true, force: true }); }
});
t('remediate: dotnet container tag uses MAJOR.MINOR, not the full SDK build', () => {
  const rules = PIN_RULES.dotnet('9.0.100');
  const docker = rules.find(r => r.rule === 'Dockerfile FROM');
  const out = docker.edit('FROM mcr.microsoft.com/dotnet/sdk:6.0 AS build\n');
  ok(/dotnet\/sdk:9\.0\b/.test(out) && !/9\.0\.100/.test(out), `got: ${out.trim()}`);
  const gj = rules.find(r => r.rule === 'sdk.version');
  ok(/9\.0\.100/.test(gj.edit('{"sdk":{"version":"6.0.418"}}')), 'global.json keeps the full build');
});
t('remediate: unified diff round-trips', () => {
  const before = 'a\nb\nc\n', after = 'a\nB\nc\n';
  const d = unified('f.txt', before, after);
  ok(/^--- a\/f\.txt/m.test(d) && /^\+\+\+ b\/f\.txt/m.test(d), 'headers');
  ok(/^-b$/m.test(d) && /^\+B$/m.test(d), 'the changed line appears on both sides');
});

// ───────────────────────── source scanning ─────────────────────────
console.log('\nsource breaking-change scan');
const scan = (...a) => runJson(process.execPath, [S('scan.mjs'), ...a]);

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
  const v = scan('rust', r, '1.70', '1.85');
  eq(v.data.rulesApplied, 0);
  ok(/not catalogued|NOT "nothing breaks"/i.test(v.data.note || ''), 'must not imply safety');
}));

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
    ok(/^>=24\.22\.1/.test(o.engines.node), o.engines.node);
  } finally { rmSync(r, { recursive: true, force: true }); }
});
t('addpin: never fires when a pin already exists', () => {
  const r = mkdtempSync(join(tmpdir(), 'ru-addpin3-'));
  try {
    writeFileSync(join(r, 'package.json'), '{"name":"x","engines":{"node":">=20"}}');
    eq(planAddPin('node', r, '24.22.1'), null);
  } finally { rmSync(r, { recursive: true, force: true }); }
});
t('addpin: every language can add a pin', () => {
  for (const a of adapters) ok(ADD_PIN_RULES[a.id], `${a.id} has no add-pin rule`);
});

// ───────────────────────── the plan ─────────────────────────
console.log('\nplan synthesis');
const plan = (...a) => runJson(process.execPath, [S('plan.mjs'), ...a]);

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

// ───────────────────────── doctor ─────────────────────────
console.log('\ndoctor');
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
