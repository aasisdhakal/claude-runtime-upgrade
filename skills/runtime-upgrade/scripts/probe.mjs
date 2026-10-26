#!/usr/bin/env node
// usage: node probe.mjs <lang> <package> <from> <to> --probe <file> [--keep] [--timeout S]
//
// Runs ONE probe file against TWO versions of a dependency and diffs the output.
//
// This exists because of a gap nothing else closes. A type checker — tsc, mypy,
// go build, rustc — only ever rejects a SHAPE change: a renamed export, a changed
// signature, a different return type. It cannot reject the same call returning a
// different ANSWER. An unstable sort, a timezone rule, a rounding mode, a changed
// hash, a new default. Those compile perfectly and are wrong at runtime. And in
// Python, Ruby, PHP or plain JS nothing checks even the shape.
//
// So the only honest proof that an upgraded dependency still behaves the same is
// to run it both ways and compare. That is all this does. It is deliberately dumb:
// the judgement of WHAT to exercise belongs in the probe file, written against the
// repo's real call sites.
//
// The probe must print deterministic lines. Anything carrying a clock, a random
// seed, a hash of a temp path or an iteration order the library does not promise
// will differ between runs and drown the real signal — normalise it in the probe,
// not here, because only the probe's author knows which of those matter.
import { mkdtempSync, writeFileSync, rmSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, basename } from 'node:path';
import { run, have } from './lib/sh.mjs';
import { emit, die } from './lib/io.mjs';

const argv = process.argv.slice(2);
const flag = n => { const i = argv.indexOf('--' + n); return i >= 0 ? argv[i + 1] : null; };
const has = n => argv.includes('--' + n);
const pos = argv.filter((a, i) => !a.startsWith('--') && !(i > 0 && argv[i - 1].startsWith('--')
  && ['probe', 'timeout', 'entry'].includes(argv[i - 1].slice(2))));
const [LANG, PKG, FROM, TO] = pos;
const PROBE = flag('probe');
const TIMEOUT = Number(flag('timeout') || 120) * 1000;
if (!LANG || !PKG || !FROM || !TO || !PROBE)
  die('usage: probe.mjs <lang> <package> <from> <to> --probe <file> [--keep] [--timeout S]', 2);
if (!existsSync(PROBE)) die(`no such probe file: ${PROBE}`, 2);
const PROBE_SRC = readFileSync(PROBE, 'utf8');

// ─────────────────────────────────────────────────────────────────────────────
// Per-ecosystem: how to install one pinned version into a scratch dir, and how
// to run a file against it. Each entry is deliberately the PLAINEST invocation
// of the ecosystem's own tool — not the fastest. A clever install that resolves
// differently from what the repo would do defeats the purpose.
// ─────────────────────────────────────────────────────────────────────────────
const ECO = {
  node: {
    tool: 'npm', probeName: ext => 'probe' + (ext || '.mjs'),
    setup: d => { writeFileSync(join(d, 'package.json'), '{"name":"probe","private":true,"type":"module"}\n'); },
    install: (d, pkg, v) => ['npm', ['install', '--silent', '--no-audit', '--no-fund',
                                     '--prefix', d, `${pkg}@${v}`]],
    exec: (d, f) => ['node', [f]],
    // npm resolves the real published artefact, so the installed version is proof
    installed: (d, pkg) => {
      try { return JSON.parse(readFileSync(join(d, 'node_modules', pkg, 'package.json'), 'utf8')).version; }
      catch { return null; }
    },
  },
  python: {
    tool: 'pip', probeName: () => 'probe.py',
    setup: () => {},
    install: (d, pkg, v) => ['pip', ['install', '--quiet', '--disable-pip-version-check',
                                     '--target', join(d, 'site'), `${pkg}==${v}`]],
    exec: (d, f) => ['python3', [f]],
    env: d => ({ PYTHONPATH: join(d, 'site') }),
    installed: (d, pkg) => {
      const norm = pkg.replace(/[-_.]+/g, '_').toLowerCase();
      try {
        for (const e of readdirSync(join(d, 'site'))) {
          const m = e.match(/^(.+?)-(.+?)\.dist-info$/);
          if (m && m[1].replace(/[-_.]+/g, '_').toLowerCase() === norm) return m[2];
        }
      } catch {}
      return null;
    },
  },
  php: {
    tool: 'composer', probeName: () => 'probe.php',
    setup: d => { writeFileSync(join(d, 'composer.json'), '{"require":{}}\n'); },
    install: (d, pkg, v) => ['composer', ['require', '--quiet', '--no-interaction',
                                          '--working-dir', d, '--with-all-dependencies', `${pkg}:${v}`]],
    exec: (d, f) => ['php', ['-d', 'error_reporting=E_ALL', f]],
    installed: (d, pkg) => {
      try {
        const l = JSON.parse(readFileSync(join(d, 'composer.lock'), 'utf8'));
        return (l.packages || []).find(p => p.name === pkg)?.version?.replace(/^v/, '') ?? null;
      } catch { return null; }
    },
  },
  ruby: {
    tool: 'gem', probeName: () => 'probe.rb',
    setup: () => {},
    install: (d, pkg, v) => ['gem', ['install', pkg, '-v', v, '--install-dir', join(d, 'gems'),
                                     '--no-document', '--silent']],
    exec: (d, f) => ['ruby', [f]],
    env: d => ({ GEM_HOME: join(d, 'gems'), GEM_PATH: join(d, 'gems') }),
    installed: (d, pkg) => {
      try {
        return readdirSync(join(d, 'gems', 'specifications'))
          .map(s => s.match(new RegExp('^' + pkg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '-(.+)\\.gemspec$')))
          .find(Boolean)?.[1] ?? null;
      } catch { return null; }
    },
  },
};

const eco = ECO[LANG];
if (!eco) die(`probe.mjs has no runner for "${LANG}". Supported: ${Object.keys(ECO).join(', ')}.\n` +
  `For compiled languages the repo's own build is the cheaper probe — but note it still only\n` +
  `checks SHAPE. A behaviour change passes a clean build.`, 2);
if (!have(eco.tool)) die(`${eco.tool} is not installed — cannot install ${PKG} to probe it`, 3);

// ─────────────────────────────────────────────────────────────────────────────
// One side of the comparison: fresh scratch dir, pinned install, run the probe.
// Each version gets its OWN directory. Installing over the top leaves the old
// version's transitive deps in place and the probe then measures a tree that
// never existed.
// ─────────────────────────────────────────────────────────────────────────────
function runAt(version) {
  const d = mkdtempSync(join(tmpdir(), `ru-probe-${PKG.replace(/[^a-z0-9]/gi, '-')}-`));
  const out = { version, dir: d };
  try {
    eco.setup(d);
    const ext = (basename(PROBE).match(/\.[a-z]+$/) || [])[0];
    const pf = join(d, eco.probeName(ext));
    writeFileSync(pf, PROBE_SRC);

    const [ic, ia] = eco.install(d, PKG, version);
    const ins = run(ic, ia, { cwd: d, timeout: TIMEOUT });
    out.installed = eco.installed(d, PKG);
    if (ins.status !== 0 || !out.installed) {
      out.ok = false;
      out.phase = 'install';
      out.error = (ins.stderr || ins.stdout || `exit ${ins.status}`).trim().slice(0, 1200);
      return out;
    }
    // the resolved version is the ground truth, not what we asked for
    if (out.installed !== version.replace(/^[v^~>=<\s]+/, ''))
      out.resolvedDifferently = true;

    const [xc, xa] = eco.exec(d, pf);
    const env = { ...process.env, ...(eco.env ? eco.env(d) : {}) };
    const r = run(xc, xa, { cwd: d, timeout: TIMEOUT, env });
    out.ok = true;
    out.phase = 'run';
    out.exit = r.status;
    out.stdout = (r.stdout || '').replace(/\r\n/g, '\n');
    out.stderr = (r.stderr || '').replace(/\r\n/g, '\n').slice(0, 4000);
    // a probe that throws on one version and not the other IS the finding
    out.threw = r.status !== 0;
    return out;
  } catch (e) {
    out.ok = false; out.phase = 'harness'; out.error = String(e.message || e);
    return out;
  } finally {
    if (!has('keep')) { try { rmSync(d, { recursive: true, force: true }); } catch {} }
  }
}

// scrub the scratch path: it differs between the two runs by construction and
// would otherwise show up as a difference in every single probe
const scrub = (s, d) => (s || '').split(d).join('<probe-dir>');

const before = runAt(FROM);
const after = runAt(TO);
const bOut = scrub(before.stdout, before.dir);
const aOut = scrub(after.stdout, after.dir);

// line-level diff — enough to point at the changed call, and the probe prints
// one labelled line per call precisely so this is readable
function diffLines(a, b) {
  const A = a.split('\n'), B = b.split('\n'), out = [];
  for (let i = 0; i < Math.max(A.length, B.length); i++)
    if (A[i] !== B[i]) out.push({ line: i + 1, before: A[i] ?? '<no line>', after: B[i] ?? '<no line>' });
  return out;
}

let outcome, headline;
if (!before.ok || !after.ok) {
  outcome = 'could-not-run';
  const f = !before.ok ? before : after;
  headline = `could not ${f.phase} ${PKG}@${f.version} — nothing was proven either way`;
} else if (before.threw && !after.threw) {
  outcome = 'changed';
  headline = `the probe THREW on ${FROM} and succeeded on ${TO}`;
} else if (!before.threw && after.threw) {
  outcome = 'changed';
  headline = `the probe succeeded on ${FROM} and THREW on ${TO} — a real regression in how this repo uses ${PKG}`;
} else if (bOut === aOut) {
  outcome = 'identical';
  headline = bOut.trim()
    ? `${PKG} ${FROM} -> ${TO}: byte-identical output across ${bOut.trim().split('\n').length} probed call(s)`
    : `the probe printed NOTHING on either version — it proves nothing, rewrite it to print each call's result`;
  if (!bOut.trim()) outcome = 'inconclusive';
} else {
  outcome = 'changed';
  headline = `${PKG} ${FROM} -> ${TO}: output DIFFERS — same code, different answer`;
}

emit({
  package: PKG, from: FROM, to: TO, lang: LANG,
  outcome, headline,
  installedBefore: before.installed, installedAfter: after.installed,
  resolvedDifferently: !!(before.resolvedDifferently || after.resolvedDifferently),
  differences: (before.ok && after.ok) ? diffLines(bOut, aOut) : [],
  stdoutBefore: bOut, stdoutAfter: aOut,
  stderrBefore: scrub(before.stderr, before.dir), stderrAfter: scrub(after.stderr, after.dir),
  exitBefore: before.exit, exitAfter: after.exit,
  error: before.error || after.error || null,
  probeFile: PROBE,
  caveat: outcome === 'identical'
    ? 'identical output proves only that the calls the probe made still answer the same. It says nothing about calls it did not make.'
    : undefined,
  whyThisExists: 'a type checker rejects shape changes, never behaviour changes; this runs the code instead',
}, outcome === 'changed' ? 1 : 0);
