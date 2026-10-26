#!/usr/bin/env node
// Zero-dependency test runner. `node tests/run.mjs [--filter substr]`
// Network-dependent cases are skipped automatically when offline or unreachable.
import { build, destroy, FIXTURES } from './fixtures.mjs';
import { runJson, run } from '../scripts/lib/sh.mjs';
import { fetchJson } from '../scripts/lib/io.mjs';
import { satisfies, rangeMajor, rangeMajorMinor, compare } from '../scripts/lib/semver.mjs';
import { adapters, byId } from '../scripts/adapters/index.mjs';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
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
  eq(adapters.map(a => a.id).sort(), ['dotnet','go','java','node','php','python','ruby','rust']));
t('node is gate-capable, php is not', () => { ok(byId.node.gateCapable === true, 'node'); ok(byId.php.gateCapable === false, 'php'); });
t('no two adapters claim the same manifest filename', () => {
  const seen = new Map();
  for (const a of adapters) for (const m of a.manifests) {
    ok(!seen.has(m), `${m} claimed by both ${seen.get(m)} and ${a.id}`);
    seen.set(m, a.id);
  }
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
