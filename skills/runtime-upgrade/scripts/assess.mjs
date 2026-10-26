#!/usr/bin/env node
// Phase 3 — ASSESS. Blockers between a directory and a target runtime.
// usage: node assess.mjs <lang> <dir> <target-version>
import { join, resolve, existsSync, readJson, readdirSync, statSync, walk, emit, die } from './lib/io.mjs';
import { have, run, runJson } from './lib/sh.mjs';
import { byId } from './adapters/index.mjs';

const [, , langArg, dirArg, target] = process.argv;
if (!langArg || !dirArg || !target) die('usage: assess.mjs <lang> <dir> <target-version>', 2);
const A = byId[langArg];
if (!A) die(`unsupported language: ${langArg}`, 2);
const DIR = resolve(dirArg);
if (!existsSync(DIR)) die(`no such directory: ${DIR}`);
const tmaj = (target.match(/^\d+(\.\d+)?/) || [''])[0];

const notes = [];
const result = { lang: A.id, dir: DIR, target, gateCapable: A.gateCapable };

if (A.id === 'node') {
  // ---------- dependency advisories ----------
  let audit = { data: null };
  if (existsSync(join(DIR, 'pnpm-lock.yaml')) && have('pnpm')) {
    audit = runJson('pnpm', ['audit', '--json'], { cwd: DIR });
  } else if (existsSync(join(DIR, 'package-lock.json')) && have('npm')) {
    audit = runJson('npm', ['audit', '--omit=dev', '--json'], { cwd: DIR });
  } else if (existsSync(join(DIR, 'yarn.lock')) && have('yarn')) {
    audit = runJson('yarn', ['npm', 'audit', '--json'], { cwd: DIR });
  } else {
    notes.push('no supported lockfile found, or its package manager is not installed');
  }
  result.dependencyAdvisories = audit.data?.metadata?.vulnerabilities || audit.data?.metadata || {};

  // ---------- native addons: ABI-pinned vs N-API ----------
  // Explicit ABI-numbered .node filenames are DEFINITIVE evidence of ABI pinning
  // and take precedence over a napi directory. Getting this backwards is the
  // single most expensive error this script can make.
  const nm = join(DIR, 'node_modules');
  const addons = [];
  if (existsSync(nm)) {
    const nodeFiles = walk(nm, { match: n => n.endsWith('.node'), maxDepth: 6, limit: 3000, skip: new Set() });
    const gyps = walk(nm, { match: n => n === 'binding.gyp', maxDepth: 5, limit: 1000, skip: new Set() });
    const dirs = new Set();
    for (const f of [...nodeFiles, ...gyps]) {
      let d = f.slice(0, f.lastIndexOf('/'));
      d = d.replace(/\/build\/Release.*$/, '').replace(/\/obj\.target.*$/, '')
           .replace(/\/lib\/binding.*$/, '').replace(/\/prebuilds.*$/, '').replace(/\/lib$/, '');
      dirs.add(d);
    }
    for (const d of [...dirs].sort().slice(0, 80)) {
      const pkg = readJson(join(d, 'package.json'));
      if (!pkg?.name) continue;
      const napiDecl = Array.isArray(pkg.binary?.napi_versions) ? pkg.binary.napi_versions.join(',') : '';
      const own = walk(d, { match: n => n.endsWith('.node'), maxDepth: 4, limit: 200, skip: new Set() });
      const abis = [...new Set(own.map(f => (f.match(/[-_](\d{2,3})\.node$/) || [])[1]).filter(Boolean))]
        .map(Number).sort((a, b) => a - b);
      const napiDir = own.some(f => /\/napi-v\d+\//.test(f));
      let kind, note;
      if (abis.length) {
        kind = 'abi-pinned';
        note = `ships ABI-numbered binaries for NODE_MODULE_VERSION ${abis.join(',')} — needs a build for the target ABI or the upgrade BLOCKS`;
      } else if (napiDecl || napiDir) {
        kind = 'napi';
        note = `N-API${napiDecl ? ' v' + napiDecl : ''} — ABI-stable across Node majors, no rebuild needed`;
      } else if (existsSync(join(d, 'binding.gyp'))) {
        kind = 'source-build';
        note = 'compiles from source at install — build toolchain required in the image';
      } else {
        kind = 'prebuilt-platform';
        note = 'platform-specific prebuilt package — verify a build exists for the target runtime and libc';
      }
      addons.push({ name: pkg.name, version: pkg.version || '?', kind, abis: abis.join(','), note });
    }
  } else {
    notes.push('node_modules absent — native addon classification skipped. Install dependencies first for a complete assessment.');
  }
  result.nativeAddons = addons;
  result.nativeBlockers = addons.filter(a => a.kind === 'abi-pinned');

  // ---------- direct dependency floors (network-bound, opt-in) ----------
  result.directDepEngines = [];
  if (process.env.RU_ENGINES === '1' && have('npm')) {
    const pkg = readJson(join(DIR, 'package.json')) || {};
    const deps = Object.keys(pkg.dependencies || {}).slice(0, Number(process.env.RU_ENGINES_MAX || 60));
    for (const p of deps) {
      const r = run('npm', ['view', p, 'engines.node', '--silent'], { cwd: DIR, timeout: 15000 });
      const e = r.stdout.trim().replace(/^['"]|['"]$/g, '');
      if (e) result.directDepEngines.push({ pkg: p, engines: e });
    }
  } else {
    notes.push('directDepEngines is empty unless RU_ENGINES=1 (network-bound)');
  }
  notes.push('nativeBlockers are the ONLY addons that stop the upgrade; napi entries are no-ops and belong in nativeNoise, never in a ticket');

} else if (A.id === 'php') {
  const hasComposer = have('composer');
  if (!hasComposer) {
    result.dependencyAdvisories = { error: 'composer not installed — bootstrap it first (see references/php.md)' };
    notes.push('composer absent: advisories, prohibits and platform-reqs all skipped');
  } else {
    const aud = runJson('composer', ['audit', '--format=json', '--no-interaction'], { cwd: DIR });
    result.dependencyAdvisories = aud.data || { error: aud.parseError || aud.error || 'no output' };
    result.blockingPackages = run('composer', ['prohibits', `php:${tmaj}`, '--no-interaction'], { cwd: DIR }).stdout.trim().slice(0, 4000);
    result.platformReqs = run('composer', ['check-platform-reqs', '--no-interaction'], { cwd: DIR }).stdout.trim().slice(0, 4000);
  }
  if (have('php')) {
    result.loadedExtensions = run('php', ['-m']).stdout.split('\n').map(s => s.trim()).filter(s => s && !s.startsWith('[')).sort();
    const info = run('php', ['-i']).stdout;
    result.zendModuleApi = (info.match(/^PHP API\s*=>\s*(\S+)/m) || [])[1] || null;
    result.threadSafety = (info.match(/^Thread Safety\s*=>\s*(\S+)/m) || [])[1] || null;
    result.phpVersion = run('php', ['-r', 'echo PHP_VERSION;']).stdout.trim();
  } else {
    notes.push('php binary absent — extension and ABI inspection skipped');
  }
  notes.push('every loaded extension must be recompiled for a new PHP MINOR — PHP has no N-API equivalent');
  notes.push('diff `php -m` between the old and new image; an extension present on old and missing on new is a boot-time failure');
  notes.push('never set config.platform-check=false to silence errors — it defers a build error into a runtime crash');
  if (A.gateNote) notes.push(A.gateNote);
}

result.notes = notes;
emit(result);
