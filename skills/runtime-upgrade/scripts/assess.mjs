#!/usr/bin/env node
// Phase 3 — ASSESS. Blockers between a directory and a target runtime.
// usage: node assess.mjs <lang> <dir> <target-version>
import { join, resolve, existsSync, readJson, readdirSync, statSync, walk, emit, die } from './lib/io.mjs';
import { have, run, runJson } from './lib/sh.mjs';
import { byId } from './adapters/index.mjs';
import { readFileSync } from 'node:fs';
const require2fs = p => { try { return readFileSync(p, 'utf8'); } catch { return null; } };

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

} else {
  // ---------- generic adapter path ----------
  // Dependency advisories come from each ecosystem's own auditor when present.
  // Nothing here is faked: if the tool is absent we say so rather than report zero.
  const AUDITORS = {
    go:     { cmd: 'govulncheck', args: ['-format', 'json', './...'], install: 'go install golang.org/x/vuln/cmd/govulncheck@latest' },
    python: { cmd: 'pip-audit',   args: ['-f', 'json'],               install: 'pipx install pip-audit' },
    ruby:   { cmd: 'bundle',      args: ['audit', 'check', '--quiet'], install: 'gem install bundler-audit && bundle audit update' },
    rust:   { cmd: 'cargo',       args: ['audit', '--json'],          install: 'cargo install cargo-audit' },
    dotnet: { cmd: 'dotnet',      args: ['list', 'package', '--vulnerable', '--include-transitive'], install: 'ships with the .NET SDK' },
    java:   { cmd: null,          args: [],                            install: 'OWASP dependency-check, or `mvn versions:display-dependency-updates`' },
  };
  const au = AUDITORS[A.id];
  result.dependencyAdvisories = { tool: au?.cmd || null };
  if (au?.cmd && have(au.cmd)) {
    const r = runJson(au.cmd, au.args, { cwd: DIR, timeout: 180000 });
    result.dependencyAdvisories = r.data
      ? { tool: au.cmd, raw: r.data }
      : { tool: au.cmd, output: (r.stdout || r.stderr).slice(0, 4000), exitStatus: r.status };
  } else {
    result.dependencyAdvisories.error =
      `${au?.cmd || 'no standard auditor'} not installed — dependency advisories NOT checked. Install: ${au?.install || 'n/a'}`;
    notes.push(result.dependencyAdvisories.error);
  }

  // ---------- toolchain presence ----------
  const RUNTIME_BIN = { go: 'go', python: 'python3', ruby: 'ruby', rust: 'rustc', java: 'java', dotnet: 'dotnet' }[A.id];
  if (RUNTIME_BIN && have(RUNTIME_BIN)) {
    const vflag = A.id === 'go' ? ['version'] : A.id === 'java' ? ['-version'] : ['--version'];
    const r = run(RUNTIME_BIN, vflag, { timeout: 15000 });
    result.installedRuntime = ((r.stdout || r.stderr).split('\n')[0] || '').trim();
  } else {
    notes.push(`${RUNTIME_BIN || A.id} not installed locally — runtime inspection skipped`);
  }

  // ---------- the native/compiled-artifact axis, per language ----------
  // Shapes differ enough that a shared classifier would lie. Each adapter
  // states its own, and assess surfaces what can be checked cheaply.
  const target = byId[A.id];
  result.nativeModel = target.scan ? null : null;
  result.nativeAddons = [];
  result.nativeBlockers = [];
  if (A.id === 'go') {
    const gomod = require2fs(join(DIR, 'go.mod'));
    const cgo = /"C"/.test(gomod || '');
    result.nativeNote = cgo
      ? 'CGO is in use — the build is no longer statically self-contained; the target image needs a matching libc and toolchain'
      : 'pure Go: statically linked, no ABI axis. CGO_ENABLED=0 builds move between images freely';
    result.cgo = cgo;
  } else if (A.id === 'python') {
    result.nativeNote = 'binary wheels are tagged cp3XX-<abi>-<platform>. A new MINOR needs wheels published for that tag, or a source build with a compiler. Check `pip debug --verbose` for supported tags.';
  } else if (A.id === 'ruby') {
    result.nativeNote = 'native gems (C extensions) relink against the interpreter and must be rebuilt for a new MINOR. Check Gemfile.lock PLATFORMS for precompiled entries.';
  } else if (A.id === 'rust') {
    result.nativeNote = 'no ABI axis: crates always compile from source. `edition` is independent of toolchain version and does not need to move together.';
  } else if (A.id === 'java') {
    result.nativeNote = 'bytecode major version is the compatibility axis, not a binary ABI. `--release N` lets a newer JDK emit older bytecode, so the JDK and the target level move independently.';
  } else if (A.id === 'dotnet') {
    result.nativeNote = 'TFM (net8.0) is the compatibility axis; global.json `rollForward` decides which installed SDK a build will accept.';
  }
  if (A.gateNote) notes.push(A.gateNote);
}

result.notes = notes;
emit(result);
