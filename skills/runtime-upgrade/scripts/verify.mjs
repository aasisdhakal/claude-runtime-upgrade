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

// ---- gate 1 + 2: declared version agrees everywhere, and names the target ----
const det = runJson(process.execPath, [join(import.meta.dirname ?? new URL('.', import.meta.url).pathname, 'detect.mjs'), DIR]);
const mine = det.data?.targets?.filter(t => t.lang === A.id) || [];
const majors = [...new Set(mine.flatMap(t => String(t.declaredMajors || '').split(',').filter(Boolean)))];
if (!majors.length) add(SKIP, 'version drift', 'no declared version found');
else if (majors.length === 1) add(PASS, 'no version drift', `declared: ${majors[0]}`);
else add(FAIL, 'version drift', `declared majors disagree: ${majors.join(', ')}`);

const wantMajor = A.id === 'node' ? tmaj.split('.')[0] : tmaj;
if (!majors.length) add(SKIP, 'declared version matches target');
else if (majors.includes(wantMajor)) add(PASS, 'declared version matches target', wantMajor);
else add(FAIL, 'declared version matches target', `declared ${majors.join(',')} but target is ${wantMajor}`);

// ---- gate 3: runtime CVEs at the target ----
if (A.gateCapable && A.matchRuntimeCve) {
  const db = await fetchJson(A.cveSource.url);
  if (!db.data) add(SKIP, 'runtime CVEs at target', db.error || 'database unavailable');
  else {
    const hits = A.matchRuntimeCve(db.data, target);
    const blocking = hits.filter(h => h.severity === 'high' || h.severity === 'critical').length;
    if (blocking === 0) add(PASS, 'runtime CVEs at target', `0 high/critical at ${target}`);
    else add(FAIL, 'runtime CVEs at target', `${blocking} high/critical still open at ${target}: ${hits.slice(0, 3).map(h => h.id).join(', ')}`);
  }
} else {
  add(SKIP, 'runtime CVEs at target', A.gateNote || 'no curated runtime CVE database');
}

// ---- gate 4: dependency advisories ----
if (A.id === 'node') {
  let audit = { data: null };
  if (existsSync(join(DIR, 'pnpm-lock.yaml')) && have('pnpm')) audit = runJson('pnpm', ['audit', '--json'], { cwd: DIR });
  else if (existsSync(join(DIR, 'package-lock.json')) && have('npm')) audit = runJson('npm', ['audit', '--omit=dev', '--json'], { cwd: DIR });
  const v = audit.data?.metadata?.vulnerabilities;
  if (!v) add(SKIP, 'dependency advisories', 'no lockfile or package manager');
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
  hints: A.id === 'node'
    ? ['run the suite with NODE_OPTIONS="--throw-deprecation --pending-deprecation" to make deprecations fail',
       '--pending-deprecation reports what the NEXT major removes — one cycle de-risks the following one']
    : ['E_DEPRECATED (8192) is NOT in PHP default error_reporting — set error_reporting(E_ALL) plus a handler that throws during tests'],
});

process.exit(failed > 0 && POLICY === 'gate' ? 1 : 0);
