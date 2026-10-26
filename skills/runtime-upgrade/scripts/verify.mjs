#!/usr/bin/env node
// Phase 5 — VERIFY. Runs the gates that prove an upgrade landed.
// Exits 1 if any gate FAILS (under policy=gate) — exit 0 always under policy=report.
// usage: node verify.mjs <lang> <dir> <target> [--image TAG] [--policy gate|report]
import { join, resolve, existsSync, readJson, fetchJson, emit, die } from './lib/io.mjs';
import { have, run, runJson } from './lib/sh.mjs';
import { byId } from './adapters/index.mjs';

const argv = process.argv.slice(2);
const [langArg, dirArg, target] = argv;
if (!langArg || !dirArg || !target) die('usage: verify.mjs <lang> <dir> <target> [--image TAG] [--policy gate|report]', 2);
const flag = n => { const i = argv.indexOf('--' + n); return i >= 0 ? argv[i + 1] : null; };
const IMAGE = flag('image');
const POLICY = flag('policy') === 'report' ? 'report' : 'gate';
const A = byId[langArg] || die(`unsupported language: ${langArg}`, 2);
const DIR = resolve(dirArg);
const tmaj = (target.match(/^\d+(\.\d+)?/) || [''])[0];

const gates = [];
const add = (status, name, detail = '') => gates.push({ status, name, detail });
const PASS = 'pass', FAIL = 'fail', SKIP = 'skip';

// ---- gate 1 + 2: pins agree, and pins name the target ----
// These two gates used to flatten `declaredMajors` across EVERY target in the
// repo — floors, pins, vendored copies, publish stubs and examples alike. On
// kubernetes, symfony, rails, roslyn and next.js that guaranteed a FAIL while
// detect itself reported driftCount: 0, and on any library it produced a
// catch-22: the gate demanded a declared version equal to the target, while
// remediate correctly refused to raise the consumer-facing floor to get it.
//
// So judge the two kinds separately:
//   a PIN  says what THIS checkout runs      -> must equal the target
//   a FLOOR says the minimum consumers need  -> must be <= the target
// A floor below the target is satisfied, not violated. That is what a floor is.
const det = runJson(process.execPath, [join(import.meta.dirname ?? new URL('.', import.meta.url).pathname, 'detect.mjs'), DIR]);
const mine = (det.data?.targets || []).filter(t => t.lang === A.id);
const split = v => String(v || '').split(',').map(x => x.trim()).filter(Boolean);
const cmpMajor = (a, b) => {
  const A2 = String(a).split('.').map(Number), B2 = String(b).split('.').map(Number);
  for (let i = 0; i < Math.max(A2.length, B2.length); i++) {
    const x = A2[i] || 0, y = B2[i] || 0;
    if (x !== y) return x - y;
  }
  return 0;
};

const drifted = mine.filter(t => t.drift);
const allPins = [...new Set(mine.flatMap(t => split(t.pinnedMajors)))];
const allFloors = [...new Set(mine.flatMap(t => split(t.floorMajors)))];

if (!mine.length) add(SKIP, 'version drift', 'no target for this language');
else if (drifted.length)
  add(FAIL, 'version drift',
    `${drifted.length} target(s) pin two different versions at once: ` +
    drifted.slice(0, 3).map(t => `${t.dir} [${t.pinnedMajors}]`).join('; '));
else if (!allPins.length)
  add(PASS, 'no version drift', 'nothing is pinned — only consumer-facing floors are declared, which cannot drift');
else add(PASS, 'no version drift', `pinned: ${allPins.join(', ')}`);

// gate 2 — pins must BE the target; floors must merely PERMIT it
const wantMajor = A.id === 'node' ? tmaj.split('.')[0] : tmaj;
// Compare at the precision the TARGET names, not at the first dotted component.
// `majorOf` truncated both sides, so a `.php-version` pinned to 8.1 against a
// target of 8.4 compared "8" to "8" and passed — a stale pin reported as clean.
// `wantMajor` is already per-language (node "26", php "8.4", go "1.27").
const atTargetPrecision = v => {
  const depth = String(wantMajor).split('.').length;
  return String(v).split('.').slice(0, depth).join('.');
};
const stalePins = allPins.filter(p => atTargetPrecision(p) !== String(wantMajor));
const floorsAbove = allFloors.filter(f => cmpMajor(f, wantMajor) > 0);
if (!allPins.length && !allFloors.length) add(SKIP, 'declared version matches target', 'nothing declares a version');
else if (stalePins.length)
  add(FAIL, 'declared version matches target',
    `these PINS still name the old runtime: ${stalePins.join(', ')} (target ${wantMajor})`);
else if (floorsAbove.length)
  add(FAIL, 'declared version matches target',
    `a declared FLOOR is above the target: ${floorsAbove.join(', ')} > ${wantMajor} — the project requires more than you are shipping`);
else if (!allPins.length)
  add(PASS, 'declared version matches target',
    `nothing is pinned; the floor(s) ${allFloors.join(', ')} permit ${wantMajor}. ` +
    `Raising a floor is semver-breaking for consumers, so leaving it put is correct, not a gap.`);
else add(PASS, 'declared version matches target', `pins read ${allPins.join(', ')}`);

// ---- gate 3: runtime CVEs at the target ----
// Two adapters implement this two different ways: node exposes a synchronous
// matcher over a curated database (`matchRuntimeCve`), go queries OSV directly
// (`runtimeCves`). verify only ever looked for the first, so Go — advertised in
// SKILL.md as gate-capable — SKIPPED every time while printing the note that
// describes the gate it had just not run. A "pass" on a Go repo meant nothing.
if (A.gateCapable && (A.matchRuntimeCve || A.runtimeCves)) {
  let hits = null, err = null;
  if (A.matchRuntimeCve) {
    const db = await fetchJson(A.cveSource.url);
    if (!db.data) err = db.error || 'database unavailable';
    else hits = A.matchRuntimeCve(db.data, target);
  } else {
    // this adapter returns { hits, error } rather than a bare array — the gate
    // had never actually run, so the shape mismatch had never been exercised
    try {
      const r = await A.runtimeCves(target);
      if (Array.isArray(r)) hits = r;
      else { hits = r?.hits ?? null; err = r?.error ?? null; }
    } catch (e) { err = String(e.message || e); }
  }
  if (err || !hits) add(SKIP, 'runtime CVEs at target', err || 'database unavailable');
  else {
    // Go's vulnerability database assigns no severity at all, so counting
    // high/critical there would always yield 0 — a guaranteed false pass.
    // gateMetric says which number this adapter can honestly gate on.
    const onTotal = A.gateMetric === 'total';
    const blocking = onTotal ? hits.length
      : hits.filter(h => h.severity === 'high' || h.severity === 'critical').length;
    const what = onTotal ? 'total' : 'high/critical';
    if (blocking === 0) add(PASS, 'runtime CVEs at target', `0 ${what} at ${target}`);
    else add(FAIL, 'runtime CVEs at target',
      `${blocking} ${what} still open at ${target}: ${hits.slice(0, 3).map(h => h.id || h).join(', ')}`);
  }
} else {
  add(SKIP, 'runtime CVEs at target',
    A.gateCapable ? 'adapter declares gateCapable but implements no CVE lookup — this is a bug, not a clean bill of health'
                  : (A.gateNote || 'no curated runtime CVE database'));
}

function yarnAuditArgs(dir) {
  const v = run('yarn', ['--version'], { cwd: dir, timeout: 10000 });
  const major = parseInt(String(v.stdout || '').trim().split('.')[0], 10);
  return major >= 2 ? ['npm', 'audit', '--json'] : ['audit', '--json'];
}

// ---- gate 4: dependency advisories ----
if (A.id === 'node') {
  // Three outcomes, not two. A crashed auditor used to be indistinguishable
  // from "no lockfile": when pnpm audit failed on a broken store, verify said
  // SKIP "no lockfile or package manager" with the lockfile RIGHT THERE and
  // pnpm installed — so under policy=gate the advisory gate silently evaporated.
  // yarn.lock was also never implemented despite being reported as absent.
  let audit = { data: null }, tool = null, why = null;
  const LOCKS = [['pnpm-lock.yaml', 'pnpm', ['audit', '--json']],
                 ['package-lock.json', 'npm', ['audit', '--omit=dev', '--json']],
                 ['bun.lock', 'bun', ['audit', '--json']],
                 // yarn v1 and Berry take DIFFERENT commands: `yarn audit` vs
                 // `yarn npm audit`. Running Berry's form under v1 fails with
                 // `Command "npm" not found`, which then read as "no lockfile".
                 ['yarn.lock', 'yarn', yarnAuditArgs(DIR)]];
  const present = LOCKS.filter(([f]) => existsSync(join(DIR, f)));
  if (!present.length) why = 'this project has no lockfile — there is nothing to audit';
  else {
    const usable = present.find(([, t]) => have(t));
    if (!usable) why = `found ${present.map(([f]) => f).join(', ')} but none of their package managers is installed`;
    else {
      tool = usable[1];
      audit = runJson(tool, usable[2], { cwd: DIR });
      if (!audit.data?.metadata?.vulnerabilities)
        why = `\`${tool} ${usable[2].join(' ')}\` produced no usable report` +
              (audit.stderr ? `: ${String(audit.stderr).trim().split('\n')[0].slice(0, 160)}` : '') +
              '. This is NOT a clean result — the gate could not run.';
    }
  }
  const v = audit.data?.metadata?.vulnerabilities;
  if (!v) add(SKIP, 'dependency advisories', why);
  else {
    const n = (v.critical || 0) + (v.high || 0);
    n === 0 ? add(PASS, 'dependency advisories', '0 critical/high')
            : add(FAIL, 'dependency advisories', `${v.critical || 0} critical, ${v.high || 0} high`);
  }
} else if (A.id === 'php') {
  if (!have('composer')) add(SKIP, 'composer gates', 'composer not installed');
  else {
    const pr = run('composer', ['check-platform-reqs', '--no-interaction'], { cwd: DIR });
    pr.ok ? add(PASS, 'composer check-platform-reqs', 'clean') : add(FAIL, 'composer check-platform-reqs', pr.stdout.slice(0, 200));
    const pb = run('composer', ['prohibits', `php:${tmaj}`, '--no-interaction'], { cwd: DIR });
    const blocked = pb.stdout.split('\n').filter(l => l.trim() && !/there is no installed package/i.test(l));
    blocked.length ? add(FAIL, `packages prohibiting php:${tmaj}`, blocked.slice(0, 5).join(' / '))
                   : add(PASS, `packages prohibiting php:${tmaj}`, 'none');
    const au = runJson('composer', ['audit', '--format=json', '--no-interaction'], { cwd: DIR });
    const n = Object.values(au.data?.advisories || {}).flat().length;
    n === 0 ? add(PASS, 'composer advisories', '0') : add(FAIL, 'composer advisories', String(n));
  }
}

// ---- gate 5: the built image actually matches ----
if (IMAGE && have('docker')) {
  if (A.id === 'node') {
    const v = run('docker', ['run', '--rm', IMAGE, 'node', '-v']).stdout.trim();
    const abi = run('docker', ['run', '--rm', IMAGE, 'node', '-p', 'process.versions.modules']).stdout.trim();
    const ssl = run('docker', ['run', '--rm', IMAGE, 'node', '-p', 'process.versions.openssl']).stdout.trim();
    v === 'v' + target ? add(PASS, 'image runtime version', v) : add(FAIL, 'image runtime version', `${v || 'nothing'}, expected v${target}`);
    abi ? add(PASS, 'image NODE_MODULE_VERSION', abi) : add(SKIP, 'image NODE_MODULE_VERSION');
    ssl ? add(PASS, 'image openssl', ssl) : add(SKIP, 'image openssl');
  } else {
    const v = run('docker', ['run', '--rm', IMAGE, 'php', '-r', 'echo PHP_VERSION;']).stdout.trim();
    v.startsWith(tmaj) ? add(PASS, 'image php version', v) : add(FAIL, 'image php version', `${v || 'nothing'}, expected ${tmaj}.x`);
    const info = run('docker', ['run', '--rm', IMAGE, 'php', '-i']).stdout;
    const api = (info.match(/^PHP API\s*=>\s*(\S+)/m) || [])[1];
    api ? add(PASS, 'image Zend module API', api) : add(SKIP, 'image Zend module API');
    if (have('php')) {
      const clean = s => s.split('\n').map(x => x.trim()).filter(x => x && !x.startsWith('['));
      const oldx = new Set(clean(run('php', ['-m']).stdout));
      const newx = new Set(clean(run('docker', ['run', '--rm', IMAGE, 'php', '-m']).stdout));
      const missing = [...oldx].filter(e => !newx.has(e));
      missing.length ? add(FAIL, 'extensions preserved', 'missing in target image: ' + missing.join(', '))
                     : add(PASS, 'extensions preserved', `${newx.size} loaded`);
    }
  }
} else {
  add(SKIP, 'image checks', IMAGE ? 'docker not installed' : 'pass --image <tag> to enable');
}

const counts = gates.reduce((m, g) => (m[g.status] = (m[g.status] || 0) + 1, m), {});
const failed = counts[FAIL] || 0;

emit({
  lang: A.id, dir: DIR, target, policy: POLICY, image: IMAGE || null,
  gates, summary: counts, failed,
  verdict: failed === 0 ? 'pass' : (POLICY === 'gate' ? 'blocked' : 'findings-reported'),
  // was: node gets node hints, EVERY other language gets the PHP one — so a
  // dotnet, Go or Python run was told about E_DEPRECATED
  hints: ({
    node: ['run the suite with NODE_OPTIONS="--throw-deprecation --pending-deprecation" to make deprecations fail',
           '--pending-deprecation reports what the NEXT major removes — one cycle de-risks the following one'],
    php: ['E_DEPRECATED (8192) is NOT in PHP default error_reporting — set error_reporting(E_ALL) plus a handler that throws during tests'],
    python: ['run with `-W error::DeprecationWarning` — Python hides DeprecationWarning outside __main__ by default',
             'PYTHONWARNINGS=error::DeprecationWarning covers subprocesses too'],
    ruby: ['run with `-w` and set Warning[:deprecated] = true — Ruby 3 silences deprecations by default'],
    go: ['`go vet ./...` and `staticcheck` carry the deprecation knowledge the compiler does not',
         'the build succeeding proves SHAPE only — a behaviour change compiles clean'],
    rust: ['`cargo build` denies nothing by default; add `#![deny(deprecated)]` or `RUSTFLAGS="-D deprecated"`'],
    java: ['compile with `-Xlint:deprecation -Werror` — javac reports deprecations as notes otherwise'],
    dotnet: ['build with `-warnaserror` and check the obsoletion diagnostics (SYSLIB*, CA*) for this TFM'],
  }[A.id]) || [`${A.label}: make deprecations fail the build however this toolchain allows — `
             + 'a clean build checks shape, never behaviour'],
});

process.exit(failed > 0 && POLICY === 'gate' ? 1 : 0);
