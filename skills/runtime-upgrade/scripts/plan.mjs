#!/usr/bin/env node
// THE PLAN. Runs every read-only phase, then synthesises an ordered, gated,
// estimated upgrade plan: what breaks, what blocks, in what order, how to
// verify each step, and how to get back if it goes wrong.
//
//   node plan.mjs <dir> [--target V] [--lang L] [--policy gate|report]
//                       [--format json|md] [--only a,b]
import { resolve, existsSync, join, emit, die } from './lib/io.mjs';
import { runJson, run, have } from './lib/sh.mjs';
import { byId } from './adapters/index.mjs';
import { satisfies } from './lib/semver.mjs';
import { parseArgv } from './lib/io.mjs';
import { planPinEdits, planCiEdits, planConfigEdits, ciMatrixAdvice } from './lib/edits.mjs';
import { rulesFor } from './lib/breaking.mjs';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const S = n => join(HERE, n);
const argv = process.argv.slice(2);
const flag = n => { const i = argv.indexOf('--' + n); return i >= 0 ? argv[i + 1] : null; };
// `plan.mjs --target 21 <dir>` resolved "21" as the directory
const A_ = parseArgv(argv, ['target', 'only', 'policy', 'lang', 'format']);
const DIR = resolve(A_.positional[0] || '.');
if (!existsSync(DIR)) die(`no such directory: ${DIR}`);
/**
 * --target names ONE version, but a repo can hold several runtimes. Handing a
 * Kotlin version to a Java target produced "java 8 -> 2.4.0" and a cycle count
 * of 0. A target applies only to the language it belongs to; every other
 * language resolves its own.
 *
 * Accepts either `--target 24.22.1` (single language) or
 * `--target node=24.22.1,java=25` (explicit per language).
 */
const RAW_TARGET = flag('target');
const TARGET_BY_LANG = {};
let SINGLE_TARGET = null;
if (RAW_TARGET) {
  if (RAW_TARGET.includes('=')) {
    for (const pair of RAW_TARGET.split(',')) {
      const [l, v] = pair.split('=').map(x => x.trim());
      if (l && v) TARGET_BY_LANG[l] = v;
    }
  } else SINGLE_TARGET = RAW_TARGET;
}
const WANT_LANG = flag('lang');
const POLICY = flag('policy') === 'report' ? 'report' : 'gate';
const FORMAT = flag('format') === 'md' ? 'md' : 'json';
const ONLY = flag('only') ? flag('only').split(',').map(s => s.trim()) : null;

// .NET numbers the SDK (10.0.100) and the runtime (10.0.13) differently, so
// comparing a global.json SDK build against a runtime release reads as a
// downgrade. The TFM is the compatibility axis — use it.
const DEPLOY_PINS = ['targetFramework', 'dockerfile', 'nvmrc', 'nodeVersion', 'phpVersionFile',
                     'pythonVersion', 'rubyVersion', 'perlVersion', 'denoVersionFile',
                     'bunVersionFile', 'toolVersions', 'lockPlatform', 'sdkmanrc', 'javaVersionFile'];
const FLOORS = ['engines', 'requirePhp', 'requiresPython', 'poetryPython', 'pythonRequires',
                'gemfileRuby', 'gemspecRuby', 'rustVersion', 'minimumOtp', 'makefileOtp',
                'goDirective', 'mavenRelease', 'javaVersionProp', 'kotlinPlugin', 'versionCatalog',
                'scalaVersion', 'mixElixir', 'cpanfilePerl', 'denoJson'];
// global.json pins the SDK (10.0.100 / 11.0.100-rc). endoflife.date reports the
// RUNTIME (10.0.13). They are different number spaces, so treating the SDK as
// "the current version" made roslyn's root read as "11.0.100 -> 10.0.13,
// proceed" — a downgrade presented as an upgrade. The TFM is the real axis.
const NOT_A_RUNTIME_VERSION = ['globalJsonSdk'];

// ───────────── discover ─────────────
const det = runJson(process.execPath, [S('detect.mjs'), DIR]);
if (!det.data) die('detect.mjs produced no output: ' + (det.stderr || '').slice(0, 300));
let targets = det.data.targets.filter(t => !t.error);
if (WANT_LANG) targets = targets.filter(t => t.lang === WANT_LANG);
if (ONLY) targets = targets.filter(t => ONLY.some(o => t.dir.includes(o) || (t.name || '').includes(o)));
// A target with no pin and no floor is not necessarily unplannable. A library
// commonly declares nothing and simply tests a CI matrix — fastify, axios and
// socket.io all do. Dropping those produced NO plan, NO finding and NO
// explanation for a perfectly real repo, which is the worst output available.
// Keep them when the matrix gives us something to plan from; pickCurrent()
// treats the lowest entry as the effective floor.
const planFrom = t => !!t.declaredMajors || (t.ciMatrix || []).some(v => /^\d/.test(String(v)));
const undeclared = targets.filter(t => !planFrom(t));
targets = targets.filter(planFrom);

const langsInScope = [...new Set(targets.map(t => t.lang))];
if (SINGLE_TARGET && langsInScope.length > 1 && !WANT_LANG) {
  process.stderr.write(
    `note: --target ${SINGLE_TARGET} applies to one language, but ${langsInScope.length} were found `
    + `(${langsInScope.join(', ')}). Each resolves its own target. Use --lang <l>, or `
    + `--target ${langsInScope.map(l => l + '=<version>').join(',')} to be explicit.\n`);
}

const plans = [];
for (const t of targets) {
  const A = byId[t.lang];
  if (!A) continue;
  // a prebuilt-binary publish stub has no source to upgrade; planning one both
  // invents story points and can hand it the pilot slot
  if (t.platformPublishStub) continue;
  const dir = t.dir === '.' ? DIR : join(DIR, t.dir);
  const current = pickCurrent(t, A);

  // ── research ──
  // only pass a target that belongs to THIS language
  const explicit = TARGET_BY_LANG[t.lang]
    || (SINGLE_TARGET && (WANT_LANG === t.lang || langsInScope.length === 1) ? SINGLE_TARGET : null);
  const res = runJson(process.execPath,
    [S('research.mjs'), t.lang, current, ...(explicit ? [explicit] : [])]);
  const r = res.data;
  const target = r?.target?.version || explicit || null;
  if (!target) { plans.push({ dir: t.dir, lang: t.lang, error: 'could not resolve a target version' }); continue; }

  // ── assess ──
  const asm = runJson(process.execPath, [S('assess.mjs'), t.lang, dir, target]);
  const a = asm.data || {};

  // ── scan source ──
  const scn = runJson(process.execPath, [S('scan.mjs'), t.lang, dir, current, target, '--include-existing']);
  const sc = scn.data || { findings: 0, bySeverity: {}, details: [] };

  // ── frameworks ──
  const fw = runJson(process.execPath, [S('frameworks.mjs'), dir]);
  // frameworks.mjs re-detects the WHOLE subtree under `dir`, so flatMapping
  // every perTarget entry hung each subdirectory's findings on THIS target. A
  // monorepo root inherited every nested app's frameworks: next.js's root plan
  // carried `nextjs 13 (EOL 2024-12-21)` from an upgrade-eval fixture five
  // levels down, as a major blocker worth +2 points. Grafana's GO plan listed
  // react sixteen times. Take only the entry for this directory.
  const mine = (fw.data?.perTarget || []).filter(p => p.dir === '.' && p.lang === t.lang);
  const dedupe = (xs, key) => {
    const seen = new Set();
    return xs.filter(x => { const k = key(x); if (seen.has(k)) return false; seen.add(k); return true; });
  };
  const frameworks = dedupe(mine.flatMap(p => p.frameworks || []), f => `${f.product}@${f.declared}`);
  const fwUntracked = dedupe(mine.flatMap(p => p.untracked || []), u => String(u.dep || u));
  const fwEol = frameworks.filter(f => f.isEol);
  // findings from BELOW this target are real, but they belong to those targets
  const fwElsewhere = (fw.data?.perTarget || [])
    .filter(p => p.dir !== '.' && (p.frameworks || []).some(f => f.isEol))
    .map(p => ({ dir: p.dir, eol: p.frameworks.filter(f => f.isEol).map(f => `${f.product} ${f.cycle}`) }));

  // ── what the edit phase will touch ──
  const pins = planPinEdits(t.lang, dir, target).edits;
  const ci = planCiEdits(t.lang, dir, target);
  const cfg = planConfigEdits(t.lang, dir, target);
  const matrix = ciMatrixAdvice(t.lang, dir, current, target);

  // ── blockers ──
  const blockers = [];
  // Does the target actually SATISFY what this project declares? grafana's root
  // says `engines.node ">= 22 <25"` and the plan happily targeted 26.12.1 with
  // zero blockers — the string `<25` appeared nowhere in 59 plans. A declared
  // cap the target breaches is the project telling you not to do this.
  for (const [field, value] of Object.entries(t.declared || {})) {
    if (!value || typeof value !== 'string') continue;
    if (!/[<>=~^]/.test(value)) continue;              // a bare pin, not a range
    if (/\(test matrix\)/.test(value)) continue;        // deliberate breadth
    let ok = true;
    try { ok = satisfies(target, value); } catch { continue; }
    if (ok) continue;
    // only a declared UPPER bound is a real contradiction; a floor below the
    // target is satisfied by definition and is handled by the floor policy
    if (!/<|~>|\^/.test(value)) continue;
    blockers.push({ kind: 'declared-constraint-breached', item: `${field}: ${value}`,
      detail: `the target ${target} does not satisfy the constraint this project declares `
            + `(${field} = "${value}"). Something here was deliberately capped.`,
      fix: 'find out why the cap is there before raising it — a cap is usually a known incompatibility, '
         + 'not an oversight. If it is stale, widen it in the same change and say so.',
      severity: 'blocker' });
  }
  // A .NET Framework TFM is not an old version of .NET — it is a DIFFERENT,
  // Windows-only runtime. Moving net472 to net10.0 is a cross-platform port:
  // AppDomains, WCF server, System.Web, Windows-only APIs and binary
  // serialization all have to go. Counted as "5 release cycles crossed" it read
  // as an ordinary bump; it is the single largest item in any plan that has one.
  if (t.netFrameworkTfms?.length)
    blockers.push({ kind: 'platform-port', item: t.netFrameworkTfms.join(';'),
      detail: '.NET Framework is a separate Windows-only runtime, not an older .NET. This is a port, not a version bump: '
            + 'AppDomains, System.Web, WCF server-side and binary serialization have no equivalent.',
      fix: 'run `dotnet upgrade-assistant analyze` and scope the port before planning any version work',
      severity: 'blocker' });
  // netstandard is a compatibility surface, not a runtime. A project that only
  // targets netstandard has nothing to upgrade.
  if (t.netStandardTfms?.length && !t.netFrameworkTfms?.length
      && String(t.declaredMajors || '') === '')
    blockers.push({ kind: 'not-a-runtime-target', item: t.netStandardTfms.join(';'),
      detail: 'this project targets only netstandard — a compatibility surface consumed by a runtime, not a runtime itself. There is no version here to move.',
      severity: 'major' });
  for (const n of (a.nativeBlockers || []))
    blockers.push({ kind: 'native-abi', item: `${n.name}@${n.version}`, detail: n.note, severity: 'blocker' });
  for (const f of dedupeByFileRule((sc.details || []).filter(d => d.severity === 'removed' && !d.preExisting)))
    blockers.push({ kind: 'removed-api', item: `${f.file}:${f.line}`, detail: f.what, fix: f.fix, severity: 'blocker' });
  for (const f of fwEol)
    blockers.push({ kind: 'framework-eol', item: `${f.product} ${f.cycle}`,
      detail: `EOL ${f.eol}; newest supported is ${f.newestSupported?.cycle}`, severity: 'major' });
  // the import and the call site are the same finding — report the file once
  const behaviour = dedupeByFileRule((sc.details || []).filter(d => d.severity === 'behaviour' && !d.preExisting));
  const preExisting = dedupeByFileRule((sc.details || []).filter(d => d.preExisting));
  for (const f of behaviour)
    blockers.push({ kind: 'behaviour-change', item: `${f.file}:${f.line}`, detail: f.what, fix: f.fix, severity: 'major' });

  const adv = a.dependencyAdvisories || {};
  const advBlocking = (adv.critical || 0) + (adv.high || 0);

  // ── gate decision ──
  const gateMetric = r?.gateMetric || null;
  const runtimeBlocking = r?.target?.cve?.blocking ?? 0;
  const runtimeTotal = r?.target?.cve?.total ?? 0;
  const gateValue = gateMetric === 'total' ? runtimeTotal : runtimeBlocking;
  const gateFails = POLICY === 'gate' &&
    ((r?.gateCapable && gateValue > 0) || advBlocking > 0 || blockers.some(b => b.severity === 'blocker'));

  // ── estimate ──
  // counted from the published cycle list, not inferred from the numbers
  const crossed = r?.distance?.cyclesCrossed ?? 0;
  const editionJump = !!r?.distance?.editionJump;
  const points = estimate({ pins, ci, cfg, blockers, scan: sc,
    deps: (t.deps || 0) + (t.devDeps || 0), fwEol, crossed, edition: editionJump });

  plans.push({
    dir: t.dir, lang: t.lang, name: t.name,
    current, target,
    eol: { isEol: r?.current?.isEol, date: r?.current?.eol, supportEnds: r?.current?.supportEnds,
           targetEol: r?.target?.eol },
    drift: t.drift ? { majors: t.declaredMajors, declared: t.declared } : null,
    cve: { gateCapable: !!r?.gateCapable, gateMetric,
           currentBlocking: r?.current?.cve?.blocking ?? 0, currentTotal: r?.current?.cve?.total ?? 0,
           targetBlocking: runtimeBlocking, targetTotal: runtimeTotal,
           removed: r?.cveDelta?.blockingRemoved ?? 0, note: r?.gateNote || null },
    dependencyAdvisories: { critical: adv.critical ?? null, high: adv.high ?? null, total: adv.total ?? null,
                            tool: adv.tool ?? null, error: adv.error ?? null },
    frameworks: { tracked: frameworks.map(f => ({ product: f.product, cycle: f.cycle, eol: f.eol, isEol: f.isEol,
                                                  newest: f.newestSupported?.cycle })),
                  untracked: fwUntracked.map(u => u.label) },
    sourceScan: { rulesApplied: sc.rulesApplied, filesScanned: sc.filesScanned,
                  findings: sc.findings, bySeverity: sc.bySeverity, hotspots: sc.hotspots,
                  causedByThisUpgrade: sc.causedByThisUpgrade, preExisting: sc.preExistingFindings },
    technicalDebt: preExisting.map(f => ({ at: `${f.file}:${f.line}`, what: f.what, fix: f.fix,
      deprecatedSince: f.introducedIn })),
    nativeNoise: (a.nativeAddons || []).filter(n => n.kind === 'napi').map(n => n.name),
    edits: { pins: pins.map(e => `${e.file} (${e.rule})`),
             ci: ci.map(e => `${e.file} (${e.rule})`),
             config: cfg.map(e => `${e.file} (${e.rule})`),
             ciMatrix: matrix },
    currentInferredFrom: currentIsInferred(t)
      ? { source: 'CI test matrix', values: t.ciMatrix,
          meaning: 'this project declares no runtime pin or floor. The lowest matrix entry is '
                 + 'treated as the effective floor — it is the oldest runtime CI still green-lights. '
                 + 'Nothing here is drift, and raising it means dropping a tested version.' }
      : undefined,
    blockers,
    // assess's own caveats — dropped entirely before, so on the one repo where
    // N-API classification is the headline risk the plan showed nativeNoise: []
    // and no blocker, with no hint that nothing had been checked
    assessCaveats: (a?.notes || []).length ? a.notes : undefined,
    nativeEnumerated: a?.nativeEnumerated ?? undefined,
    // EOL frameworks found UNDER this target — reported, not charged to it
    frameworksEolBelowThisTarget: fwElsewhere.length ? fwElsewhere.slice(0, 10) : undefined,
    verdict: gateFails ? 'blocked'
           : (blockers.length || editionJump || crossed >= 3) ? 'proceed-with-conditions'
           : 'proceed',
    estimatePoints: points,
    autofixable: sc.autofixable ?? 0,
    steps: steps({ lang: t.lang, dir: t.dir, absDir: dir, current, target, pins, ci, cfg,
                   blockers, behaviour, a, r, autofixable: sc.autofixable ?? 0 }),
    rollback: rollback({ lang: t.lang, dir: t.dir, current, target }),
    testStrategy: testStrategy({ lang: t.lang, current, target, behaviour }),
    cyclesCrossed: crossed, editionJump,
    stepwise: editionJump
      ? `${current} → ${target} crosses a language EDITION boundary. This is a port: expect source changes `
        + `throughout, and plan it as its own project rather than a version bump.`
      : crossed >= 3
      ? `Do NOT go ${current} → ${target} in one change. Move one release cycle at a time, testing and committing between each.`
      : null,
    risk: risk({ t, blockers, behaviour, a, advBlocking, crossed, edition: editionJump,
                 lang: t.lang, from: current, to: target }),
  });
}

function dedupeByFileRule(list) {
  const seen = new Set();
  return list.filter(f => { const k = f.file + '::' + f.what; if (seen.has(k)) return false; seen.add(k); return true; });
}

/**
 * What "current" means depends on what the repo is.
 *   An APPLICATION pins a deployment version (.nvmrc, Dockerfile, .tool-versions)
 *     — that is what runs, and what you are moving.
 *   A LIBRARY declares only a floor (`^8.1`, `>=3.10`) and tests a matrix above
 *     it. Its constraint is the FLOOR; the newest version CI happens to test is
 *     not what you are upgrading from.
 * Taking the CI version made php-carbon look like 8.5 -> 8.5.12: a no-op.
 */
function pickCurrent(t, adapter) {
  const d = t.declared || {};
  // An adapter that knows how to read its own version strings MUST be the one
  // that does it. Reimplementing this here read `net472` as "472".
  const generic = v => {
    const x = String(v).split(';')[0];
    return (x.match(/(\d+(?:\.\d+){0,2})/) || [])[1];
  };
  const num = adapter?.normalizeVersion
    ? (v => adapter.normalizeVersion(String(v).split(/[;|]/)[0]) || undefined)
    : generic;
  for (const k of DEPLOY_PINS) if (d[k] && !NOT_A_RUNTIME_VERSION.includes(k)) { const m = num(d[k]); if (m) return m; }
  for (const k of FLOORS)      if (d[k] && !NOT_A_RUNTIME_VERSION.includes(k)) { const m = num(d[k]); if (m) return m; }
  // last resort: the LOWEST declared major, never the highest
  const all = String(t.declaredMajors || '').split(',').filter(Boolean)
    .sort((a, b) => parseFloat(a) - parseFloat(b));
  if (all[0]) return all[0];

  // A library often pins NOTHING and simply tests a matrix — fastify, axios and
  // socket.io all do exactly that. With no pin and no floor those targets fell
  // through to "undeclared" and plan.mjs emitted nothing at all for them: no
  // plan, no finding, no explanation. Silence on a real repo is the worst
  // output this tool can produce.
  //
  // A matrix is NOT a pin and must never count as drift, but it is still
  // evidence of what the project supports. The LOWEST entry is the effective
  // floor — the oldest runtime they still green-light — so that is the honest
  // "current" to plan from.
  const matrix = (t.ciMatrix || []).map(v => String(v).replace(/\.x$/, ''))
    .filter(v => /^\d/.test(v))
    .sort((a, b) => parseFloat(a) - parseFloat(b));
  return matrix[0] || '';
}

/** Did `current` come from a CI matrix rather than a declaration? */
function currentIsInferred(t) {
  return !String(t.declaredMajors || '') && (t.ciMatrix || []).length > 0;
}

function estimate({ pins, ci, cfg, blockers, scan, deps, fwEol, crossed, edition }) {
  let p = 1;                                                 // the pin edit itself
  p += Math.min(3, Math.ceil((ci.length + cfg.length) / 2)); // config surface
  p += blockers.filter(b => b.severity === 'blocker').length * 3;
  p += blockers.filter(b => b.severity === 'major').length * 2;
  p += Math.min(5, Math.floor((scan.findings || 0) / 10));
  p += deps > 80 ? 5 : deps > 40 ? 3 : deps > 15 ? 2 : 1;    // dependency surface
  p += fwEol.length * 5;                                     // a dead framework is its own project
  // distance is the strongest predictor of effort and nothing above measured it
  p += edition ? 21 : crossed >= 6 ? 8 : crossed >= 3 ? 5 : crossed >= 2 ? 3 : crossed === 1 ? 1 : 0;
  return Math.min(55, p);
}

function steps({ lang, dir, absDir, current, target, pins, ci, cfg, blockers, behaviour, a, r, autofixable }) {
  const SK = HERE;
  const D = absDir;
  const out = [];
  const hard = blockers.filter(b => b.severity === 'blocker');
  if (hard.length) out.push({
    n: out.length + 1, phase: 'unblock',
    title: `Clear ${hard.length} hard blocker(s) BEFORE touching the runtime`,
    why: 'These fail on the target. Fixing them first keeps the runtime bump a one-variable change.',
    actions: hard.map(b => `${b.item} — ${b.detail}${b.fix ? ` → ${b.fix}` : ''}`),
    exit: 'every hard blocker has a landed fix or an explicit, owned deferral',
  });
  if (behaviour.length) out.push({
    n: out.length + 1, phase: 'characterize',
    title: `Write tests for ${behaviour.length} behaviour change(s) while still on ${current}`,
    why: 'Behaviour changes do not throw — they return different answers. Capture the CURRENT answer first, '
       + 'or you have nothing to compare against.',
    actions: behaviour.map(b => `${b.file}:${b.line} — ${b.what}${b.fix ? ` → ${b.fix}` : ''}`),
    exit: 'tests pass on the old runtime and assert the behaviour explicitly',
  });
  out.push({
    n: out.length + 1, phase: 'runtime',
    title: `Move the runtime pin ${current} → ${target}`,
    why: 'Bump the manifest floor first — it is what makes linters, codemods and resolvers report against the target.',
    actions: [
      ...pins.map(e => `rewrite ${e.file} (${e.rule})`),
      ...ci.map(e => `rewrite ${e.file} (${e.rule})`),
      ...cfg.map(e => `rewrite ${e.file} (${e.rule})`),
      `node ${SK}/remediate.mjs ${lang} ${D} ${target} --deps none --apply`,
    ],
    exit: `every declared location reads ${target}; the build succeeds; no version drift`,
  });
  if (autofixable) out.push({
    n: out.length + 1, phase: 'source-fix',
    title: `Apply ${autofixable} mechanical source fix(es)`,
    why: 'These rewrites are correct for every match, so a machine can make them. '
       + 'Everything else in the scan needs a human and is listed separately.',
    actions: [
      `node ${SK}/fix.mjs ${lang} ${D} ${current} ${target} --list    # what is automatic vs what is not`,
      `node ${SK}/fix.mjs ${lang} ${D} ${current} ${target}           # dry run: see the diffs`,
      `node ${SK}/fix.mjs ${lang} ${D} ${current} ${target} --apply   # guard preflight must pass`,
    ],
    exit: 'the mechanical fixes are in their own commit, separate from the runtime pin',
  });
  out.push({
    n: out.length + 1, phase: 'dependencies',
    title: 'Upgrade dependency packages',
    why: 'Separate commit from the runtime: if the build breaks you need to know which half did it.',
    actions: [
      `node ${SK}/remediate.mjs ${lang} ${D} ${target} --deps minor --apply   # stays in declared ranges`,
      `# then, deliberately: --deps latest   # crosses majors, rewrites the ranges themselves`,
      `node ${SK}/assess.mjs ${lang} ${D} ${target}   # the tree changed — re-assess`,
    ],
    exit: '0 critical/high advisories; lockfile regenerated with the new runtime',
  });
  out.push({
    n: out.length + 1, phase: 'verify',
    title: 'Prove it on the target',
    why: 'A green suite on the old runtime says nothing about the new one.',
    actions: [
      `node ${SK}/verify.mjs ${lang} ${D} ${target} --policy gate --image <tag>`,
      'run the suite with deprecations made fatal',
      'run the matrix on BOTH old and new for the whole migration window',
    ],
    exit: 'all gates pass; golden/characterization outputs match',
  });
  return out;
}

function rollback({ lang, dir, current, target }) {
  return {
    before: [`tag or note the currently deployed image digest`,
             `confirm the previous image tag is retained for >= 14 days`],
    trigger: 'define it BEFORE deploying: error-rate delta, p95 delta, or any OOMKill. '
           + 'Ambiguity during an incident is what turns a 5-minute rollback into an hour.',
    procedure: [
      `redeploy the previous image`,
      `git revert the runtime commit — the manifest AND the lockfile together`,
      `a mixed lockfile/runtime state is worse than either alone`,
    ],
    note: `reverting to ${current} re-exposes whatever CVEs the upgrade closed — it is a stopgap, not a resolution`,
  };
}

function testStrategy({ lang, current, target, behaviour }) {
  const deprFlags = {
    node: 'NODE_OPTIONS="--throw-deprecation --pending-deprecation" <test command>',
    python: 'PYTHONWARNINGS=error::DeprecationWarning <test command>',
    ruby: 'RUBYOPT=-W:deprecated <test command>',
    php: 'error_reporting(E_ALL) plus a handler that throws on E_DEPRECATED',
    java: '-Xlint:deprecation,removal -Werror',
    go: 'go vet ./... && go test -race ./...',
  }[lang] || 'enable the strictest deprecation reporting this toolchain offers';
  return {
    ladder: [
      '1. static — language-version linter; fastest signal, no execution',
      `2. matrix CI on BOTH ${current} and ${target} for the whole migration window`,
      '3. characterization/golden tests — capture outputs on the old runtime, replay on the new',
      '4. container parity — the built image must report the target version and ABI',
      '5. integration — every outbound TLS connection; hostname/cert validation tightens between majors',
    ],
    deprecationsFatal: deprFlags,
    mustCover: behaviour.length
      ? behaviour.map(b => `${b.file}:${b.line} — ${b.what}`)
      : ['no behaviour-class findings; golden tests still recommended for date/number formatting, '
       + 'sort stability, serialization and hashing'],
  };
}

function risk({ t, blockers, behaviour, a, advBlocking, crossed, edition, lang, from, to }) {
  const signals = [];
  if (t.containerOnly) signals.push('runtime pinned only in a Dockerfile — nothing in the manifest enforces it');
  if (t.drift) signals.push(`version drift across ${t.declaredMajors} — a defect that predates this upgrade`);
  if (behaviour.length) signals.push(`${behaviour.length} silent behaviour change(s) — these fail without throwing`);
  if (advBlocking > 0) signals.push(`${advBlocking} critical/high dependency advisories open`);
  if ((a.nativeBlockers || []).length) signals.push(`${a.nativeBlockers.length} ABI-pinned native addon(s)`);
  if ((t.deps || 0) + (t.devDeps || 0) > 80) signals.push('large dependency surface — expect unrelated breakage from the lockfile refresh');
  if (edition) signals.push(
    `${from} → ${to} crosses a language EDITION boundary — plan it as a port, not a version bump`);
  else if (crossed >= 6) signals.push(`${crossed} release cycles in one jump — move one cycle at a time`);
  else if (crossed >= 3) signals.push(`${crossed} release cycles crossed`);
  const level = (edition || blockers.some(b => b.severity === 'blocker') || crossed >= 6) ? 'high'
              : (crossed >= 3 || signals.length >= 3) ? 'medium'
              : signals.length ? 'medium' : 'low';
  return { level, signals: signals.length ? signals : ['no elevated risk signals detected'] };
}

// ───────────── sequencing across targets ─────────────
const ordered = [...plans].filter(p => !p.error).sort((a, b) =>
  (a.estimatePoints - b.estimatePoints) || (a.blockers.length - b.blockers.length));
// the repo ROOT is the headline target; a sub-package must not outrank it
plans.sort((a, b) => (a.dir === '.' ? -1 : 0) - (b.dir === '.' ? -1 : 0));
const sequencing = ordered.length > 1 ? {
  order: ordered.map(p => p.dir),
  pilot: ordered[0]?.dir,
  pilotRationale: 'smallest estimate and fewest blockers — it validates the base images and the verification '
                + 'gates before anything with real blast radius moves',
  last: ordered[ordered.length - 1]?.dir,
  lastRationale: 'largest blast radius, and it benefits from every lesson learned above',
  sharedBlockers: sharedBlockers(plans),
} : null;

function sharedBlockers(ps) {
  const m = {};
  for (const p of ps) for (const b of (p.blockers || [])) (m[b.item] ??= []).push(p.dir);
  return Object.entries(m).filter(([, dirs]) => dirs.length > 1)
    .map(([item, dirs]) => ({ item, affects: dirs, note: 'fix once, apply everywhere' }));
}

// computed BEFORE the object that spreads it: a const referenced above its
// declaration is a TDZ ReferenceError, not an empty object
const collapsed = collapseMonorepo(det.data.shape, plans);

const out = {
  root: DIR, shape: det.data.shape, policy: POLICY,
  // emitting an empty plan for a repo that plainly has manifests reads as a
  // crash. If nothing is actionable, say why and what to do.
  nothingActionable: plans.length === 0 ? {
    reason: det.data.allTargetsUndeclared
      ? 'every target was found, but none declares a runtime version anywhere'
      : 'no target declared a runtime version',
    guidance: det.data.undeclaredGuidance
      || 'add a version pin (engines, .nvmrc, .tool-versions or a Dockerfile tag) so something enforces it',
    targetsFound: det.data.targetCount,
    ciVersionsSeen: (det.data.targets || []).map(t => t.declared?.ci).filter(Boolean),
    ancillaryTargets: det.data.ancillaryTargets || [],
  } : undefined,
  generatedFor: targets.length + ' target(s)',
  undeclaredTargets: undeclared.map(t => `${t.lang}: ${t.dir}`),
  // see collapseMonorepo below
  ...collapsed,
  totalEstimatePoints: (collapsed.plans || plans).reduce((n, p) => n + (p.estimatePoints || 0), 0),
  verdicts: (collapsed.plans || plans).reduce((m, p) => (m[p.verdict || 'error'] = (m[p.verdict || 'error'] || 0) + 1, m), {}),
  sequencing,
  plans: collapsed.plans || plans,
};

/**
 * One repo, one plan per DISTINCT upgrade — not one per package.
 *
 * SKILL.md says "never one ticket per workspace package", and then plan emitted
 * 215 of them for symfony, 123 for roslyn, 39 for laravel and 38 for k8s, each
 * with its own story points, sequencing entry and rendered ticket. A monorepo
 * has one CI, one release train and one decision; the per-package work is the
 * same mechanical pin edit repeated.
 *
 * Packages that differ — a different current version, a different verdict, a
 * blocker of their own — stay separate, because those are genuinely different
 * decisions. Identical ones collapse into a single plan that lists them.
 *
 * Cost model: the compatibility investigation is paid ONCE; each extra package
 * adds only the edit. So 215 packages is not 215x the work, and pretending it
 * is made the estimate useless.
 */
function collapseMonorepo(shape, plans) {
  if (!['monorepo', 'multi-package', 'polyrepo'].includes(shape) || plans.length < 3) return {};
  const key = p => [p.lang, p.current, p.target, p.verdict,
                    (p.blockers || []).map(b => b.kind).sort().join('|')].join('::');
  const groups = new Map();
  for (const p of plans) {
    const k = key(p);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(p);
  }
  if (groups.size === plans.length) return {};          // nothing is actually alike
  const out = [];
  for (const members of groups.values()) {
    if (members.length === 1) { out.push(members[0]); continue; }
    const lead = members.find(m => m.dir === '.') || members[0];
    const extra = members.length - 1;
    out.push({
      ...lead,
      dir: lead.dir,
      appliesTo: members.map(m => m.dir).sort(),
      packageCount: members.length,
      // the investigation once, plus the repeated edit
      estimatePoints: (lead.estimatePoints || 0) + Math.min(8, Math.ceil(extra / 4)),
      collapsedNote: `${members.length} packages in this repo make the SAME move `
        + `(${lead.current} -> ${lead.target}) with the same verdict. They are one change, not `
        + `${members.length}: the compatibility work is shared and only the pin edit repeats. `
        + `File ONE ticket for this repo, not one per package.`,
    });
  }
  const saved = plans.length - out.length;
  return { plans: out,
           collapsedFromPerPackage: { was: plans.length, now: out.length, merged: saved,
             why: 'identical upgrades in one repo are one decision; SKILL.md: never one ticket per workspace package' } };
}
if (FORMAT === 'md') process.stdout.write(markdown(out));
else emit(out);

function markdown(o) {
  const L = [];
  L.push(`# Upgrade plan — ${o.root}`, '');
  L.push(`**Shape:** ${o.shape} · **Targets:** ${o.plans.length} · **Policy:** ${o.policy} · **Estimate:** ${o.totalEstimatePoints} points`, '');
  if (o.undeclaredTargets.length) L.push(`> ⚠ No declared runtime: ${o.undeclaredTargets.join(', ')} — nothing enforces a version there.`, '');
  if (o.sequencing) {
    L.push('## Sequencing', '', `Pilot **${o.sequencing.pilot}** — ${o.sequencing.pilotRationale}`, '',
           `Last **${o.sequencing.last}** — ${o.sequencing.lastRationale}`, '',
           '`' + o.sequencing.order.join('` → `') + '`', '');
    if (o.sequencing.sharedBlockers.length) {
      L.push('### Shared blockers', '');
      for (const s of o.sequencing.sharedBlockers) L.push(`- **${s.item}** affects ${s.affects.join(', ')} — fix once`);
      L.push('');
    }
  }
  for (const p of o.plans) {
    if (p.error) { L.push(`## ${p.dir} — ERROR: ${p.error}`, ''); continue; }
    L.push(`## ${p.dir} · ${p.lang} ${p.current} → ${p.target}`, '');
    L.push(`**Verdict:** ${p.verdict} · **Risk:** ${p.risk.level} · **Estimate:** ${p.estimatePoints} points`, '');
    if (p.eol.isEol) L.push(`> **EOL since ${p.eol.date}.** Target supported to ${p.eol.targetEol}.`, '');
    if (p.drift) L.push(`> **Version drift:** ${p.drift.majors} — a defect that predates this upgrade.`, '');
    if (p.stepwise) L.push(`> ⚠ **${p.stepwise}**`, '');
    if (p.cve.gateCapable) L.push(`**Runtime CVEs:** ${p.cve.currentBlocking} → ${p.cve.targetBlocking} (${p.cve.removed} removed)`, '');
    else L.push(`**Runtime CVEs:** not gateable — ${(p.cve.note || '').slice(0, 160)}`, '');
    if (p.dependencyAdvisories.critical != null)
      L.push(`**Dependency advisories:** ${p.dependencyAdvisories.critical} critical, ${p.dependencyAdvisories.high} high`, '');
    if (p.frameworks.tracked.length)
      L.push(`**Frameworks:** ` + p.frameworks.tracked.map(f => `${f.product} ${f.cycle}${f.isEol ? ` (EOL ${f.eol} → ${f.newest})` : ''}`).join(', '), '');
    if (p.frameworks.untracked.length)
      L.push(`**Frameworks with no EOL feed:** ${p.frameworks.untracked.join(', ')} — judge from their own release notes.`, '');
    if (p.blockers.length) {
      L.push('### Blockers', '');
      for (const b of p.blockers) L.push(`- \`${b.severity}\` **${b.item}** — ${b.detail}${b.fix ? ` → *${b.fix}*` : ''}`);
      L.push('');
    }
    if (p.nativeNoise.length) L.push(`*Not blockers (N-API, ABI-stable): ${p.nativeNoise.join(', ')}*`, '');
    L.push('### Steps', '');
    for (const s of p.steps) {
      L.push(`**${s.n}. ${s.title}**`, '', `*${s.why}*`, '');
      for (const a of s.actions) L.push(`- ${a}`);
      L.push('', `> Exit: ${s.exit}`, '');
    }
    if (p.technicalDebt.length) {
      L.push('### Pre-existing debt (not caused by this upgrade)', '');
      L.push('*Already deprecated before the current version. Not blocking — but this is what the NEXT major turns into failures.*', '');
      for (const d of p.technicalDebt) L.push(`- \`${d.at}\` — ${d.what} *(since ${d.deprecatedSince})*${d.fix ? ` → ${d.fix}` : ''}`);
      L.push('');
    }
    L.push('### Test strategy', '');
    for (const x of p.testStrategy.ladder) L.push(`- ${x}`);
    L.push('', `**Make deprecations fatal:** \`${p.testStrategy.deprecationsFatal}\``, '');
    L.push('### Rollback', '');
    L.push(`**Trigger:** ${p.rollback.trigger}`, '');
    for (const x of p.rollback.procedure) L.push(`- ${x}`);
    L.push('', `> ${p.rollback.note}`, '');
    L.push('### Risk', '');
    for (const s of p.risk.signals) L.push(`- ${s}`);
    L.push('');
  }
  return L.join('\n');
}
