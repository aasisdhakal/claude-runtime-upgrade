#!/usr/bin/env node
// Write-mode enforcement. SECURITY.md promises these; this file is what makes
// them true. Every promise is checked here, not merely instructed in a prompt.
//
//   guard.mjs preflight <dir>                      is it safe to write at all?
//   guard.mjs branch    <dir> <lang> <target>      create/switch to runtime/<lang>-<target>
//   guard.mjs commit    <dir> -m <msg> [--phase P] validate, then commit
//   guard.mjs status    <dir>                      what guard sees
//
// Exits non-zero and explains when a rule is violated. Never pushes. Never
// force-pushes. Never touches a remote.
import { resolve, join, existsSync, emit, die } from './lib/io.mjs';
import { have, run } from './lib/sh.mjs';

const PROTECTED = new Set(['main', 'master', 'develop', 'trunk', 'production', 'prod', 'release']);
const BRANCH_RE = /^runtime\/[a-z0-9.+-]+$/;

// manifest <-> lockfile pairs: committing one without the other leaves a repo
// in a state that is worse than either change alone.
const PAIRS = [
  ['package.json', ['package-lock.json', 'pnpm-lock.yaml', 'yarn.lock', 'bun.lock', 'bun.lockb']],
  ['composer.json', ['composer.lock']],
  ['go.mod', ['go.sum']],
  ['Cargo.toml', ['Cargo.lock']],
  ['Gemfile', ['Gemfile.lock']],
  ['pyproject.toml', ['poetry.lock', 'uv.lock', 'pdm.lock', 'requirements.txt']],
];

// Patterns that must never enter a commit this tool makes.
const SECRET_RE = [
  [/-----BEGIN (RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/, 'private key block'],
  [/\bAKIA[0-9A-Z]{16}\b/, 'AWS access key id'],
  [/\bghp_[A-Za-z0-9]{36}\b/, 'GitHub personal access token'],
  [/\bgithub_pat_[A-Za-z0-9_]{22,}\b/, 'GitHub fine-grained token'],
  [/\bxox[baprs]-[A-Za-z0-9-]{10,}/, 'Slack token'],
  [/\bsk-[A-Za-z0-9]{32,}\b/, 'API secret key'],
  [/\b(?:password|passwd|secret|api[_-]?key|token)\s*[:=]\s*["'][^"'\s]{12,}["']/i, 'hardcoded credential'],
];

const git = (dir, ...args) => run('git', args, { cwd: dir, timeout: 30000 });

function requireRepo(dir) {
  if (!have('git')) die('git is not installed — write mode cannot enforce its own guarantees');
  const r = git(dir, 'rev-parse', '--is-inside-work-tree');
  if (!r.ok || r.stdout.trim() !== 'true') die(`not a git repository: ${dir}. Write mode refuses to edit untracked trees.`);
}

function currentBranch(dir) {
  const r = git(dir, 'rev-parse', '--abbrev-ref', 'HEAD');
  return r.ok ? r.stdout.trim() : null;
}
function porcelain(dir) {
  const r = git(dir, 'status', '--porcelain');
  return r.stdout.split('\n').map(l => l.trimEnd()).filter(Boolean);
}
function stagedFiles(dir) {
  const r = git(dir, 'diff', '--cached', '--name-only');
  return r.stdout.split('\n').map(s => s.trim()).filter(Boolean);
}

function checks(dir) {
  const out = [];
  const add = (ok, rule, detail) => out.push({ ok, rule, detail });

  const branch = currentBranch(dir);
  add(!!branch, 'repository resolves a branch', branch || 'detached HEAD');
  if (branch) {
    add(!PROTECTED.has(branch), 'not on a protected branch',
        PROTECTED.has(branch) ? `on "${branch}" — switch with: guard.mjs branch <dir> <lang> <target>` : branch);
    add(BRANCH_RE.test(branch), 'on a runtime/* branch',
        BRANCH_RE.test(branch) ? branch : `"${branch}" is not runtime/<lang>-<target>`);
  }

  const dirty = porcelain(dir).filter(l => !l.startsWith('??'));
  add(dirty.length === 0, 'working tree has no unrelated changes',
      dirty.length ? `${dirty.length} modified file(s): ${dirty.slice(0, 3).map(l => l.slice(3)).join(', ')}` : 'clean');

  const staged = stagedFiles(dir);
  add(staged.length === 0, 'nothing already staged',
      staged.length ? `${staged.length} file(s) staged before guard ran` : 'index clean');

  const up = git(dir, 'rev-list', '--count', '@{upstream}..HEAD');
  add(true, 'local commits ahead of upstream', up.ok ? up.stdout.trim() : 'no upstream configured');

  return out;
}

/**
 * Lines in a manifest diff that mean DEPENDENCIES moved, and therefore that the
 * lockfile must move with them. A runtime pin (`engines.node`, the `go`
 * directive, `rust-version`) changes no resolution, so demanding a lockfile
 * update for it refuses correct commits — which is exactly what it did against
 * chalk, ripgrep, click, Carbon and gorilla/mux.
 */
const RUNTIME_PIN_KEYS = /"(?:engines|devEngines|volta|packageManager)"|requires-python|python_requires|rust-version|required_ruby_version|^\s*[-+]\s*go\s+[\d.]|"php"\s*:|elixir:\s*"|minimum_otp_vsn|AUTO_CI_OTP|<maven\.compiler|jvmToolchain|TargetFramework|scalaVersion|MIN_PERL_VERSION|use\s+5\./;
const DEP_SECTION = /"(?:dependencies|devDependencies|peerDependencies|optionalDependencies|require|require-dev)"|^\s*[-+]\s*(?:require|gem|implementation|api)\s|^\s*[-+]\s*[\w.-]+\s*=\s*["'][\^~>=<\d]/;

const DEP_KEYS = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies',
                  'require', 'require-dev'];

/**
 * Did the DEPENDENCIES move, or only the runtime pin?
 *
 * Line heuristics cannot answer this: minified JSON puts `engines` and
 * `dependencies` on the same line, so any rule that classifies a whole line
 * either refuses correct commits or lets real dependency drift through.
 * For JSON manifests, compare the parsed dependency maps instead.
 */
function manifestChangedDeps(dir, file) {
  const show = ref => git(dir, 'show', `${ref}:${file}`).stdout;
  const staged = git(dir, 'show', `:${file}`).stdout;

  if (/\.json$/.test(file)) {
    try {
      const before = JSON.parse(show('HEAD') || '{}');
      const after = JSON.parse(staged || '{}');
      for (const k of DEP_KEYS) {
        // `require` in composer.json carries the php platform constraint, which
        // is a runtime pin, not a dependency
        const strip = o => { const c = { ...(o?.[k] || {}) }; delete c.php; delete c.node; return c; };
        if (JSON.stringify(strip(before)) !== JSON.stringify(strip(after))) return true;
      }
      return false;
    } catch { /* fall through to the line heuristic */ }
  }

  const d = git(dir, 'diff', '--cached', '-U0', '--', file).stdout;
  const changed = d.split('\n').filter(l => /^[-+]/.test(l) && !/^(\+\+\+|---)/.test(l));
  if (!changed.length) return false;
  const depLines = changed.filter(l => DEP_SECTION.test(l) && !RUNTIME_PIN_KEYS.test(l));
  return depLines.length > 0;
}

/** manifest and lockfile must move together — but only when deps actually moved */
function pairViolations(dir, files) {
  const base = f => f.split('/').pop();
  const names = new Set(files.map(base));
  const bad = [];
  for (const [manifest, locks] of PAIRS) {
    const hasM = names.has(manifest);
    const hasL = locks.some(l => names.has(l));
    const lockExists = locks.some(l => existsSync(join(dir, l)));
    if (hasM && !hasL && lockExists && manifestChangedDeps(dir, manifest))
      bad.push(`${manifest} dependencies changed without its lockfile (${locks.find(l => existsSync(join(dir, l)))})`);
    if (hasL && !hasM) bad.push(`a lockfile changed without ${manifest}`);
  }
  return bad;
}

function secretScan(dir, files) {
  const found = [];
  for (const f of files) {
    const r = git(dir, 'diff', '--cached', '-U0', '--', f);
    for (const line of r.stdout.split('\n')) {
      if (!line.startsWith('+') || line.startsWith('+++')) continue;
      for (const [re, label] of SECRET_RE) if (re.test(line)) { found.push(`${f}: possible ${label}`); break; }
    }
  }
  return [...new Set(found)];
}

const [, , cmd, dirArg, ...rest] = process.argv;
if (!cmd || !dirArg) die('usage: guard.mjs <preflight|branch|commit|status> <dir> [...]', 2);
const DIR = resolve(dirArg);
if (!existsSync(DIR)) die(`no such directory: ${DIR}`);
requireRepo(DIR);

if (cmd === 'status' || cmd === 'preflight') {
  const results = checks(DIR);
  const failed = results.filter(r => !r.ok);
  emit({
    dir: DIR, branch: currentBranch(DIR), command: cmd,
    checks: results, failed: failed.length,
    verdict: failed.length === 0 ? 'safe-to-write' : 'blocked',
    rules: {
      protectedBranches: [...PROTECTED],
      branchPattern: BRANCH_RE.source,
      neverPushes: true,
      pairedCommits: PAIRS.map(([m, l]) => `${m} <-> ${l[0]}`),
    },
  });
  process.exit(cmd === 'preflight' && failed.length ? 1 : 0);
}

if (cmd === 'branch') {
  const [lang, target] = rest;
  if (!lang || !target) die('usage: guard.mjs branch <dir> <lang> <target>', 2);
  const name = `runtime/${lang}-${target}`.replace(/[^a-zA-Z0-9./+-]/g, '-');
  if (!BRANCH_RE.test(name)) die(`refusing to create an off-pattern branch: ${name}`);
  const dirty = porcelain(DIR).filter(l => !l.startsWith('??'));
  if (dirty.length) die(`working tree is dirty (${dirty.length} file(s)) — commit or stash before branching`);
  const exists = git(DIR, 'rev-parse', '--verify', name).ok;
  const r = exists ? git(DIR, 'switch', name) : git(DIR, 'switch', '-c', name);
  if (!r.ok) die(`could not switch to ${name}: ${(r.stderr || r.stdout).trim()}`);
  emit({ dir: DIR, branch: name, created: !exists, note: 'guard never pushes; publishing this branch is a human action' });
  process.exit(0);
}

if (cmd === 'commit') {
  const mi = rest.findIndex(a => a === '-m' || a === '--message');
  const message = mi >= 0 ? rest[mi + 1] : null;
  const pi = rest.indexOf('--phase');
  const phase = pi >= 0 ? rest[pi + 1] : null;
  if (!message) die('usage: guard.mjs commit <dir> -m "<message>" [--phase <name>]', 2);

  const branch = currentBranch(DIR);
  if (PROTECTED.has(branch)) die(`refusing to commit on protected branch "${branch}"`);
  if (!BRANCH_RE.test(branch)) die(`refusing to commit on "${branch}" — write mode requires a runtime/* branch`);

  git(DIR, 'add', '-A');
  const files = stagedFiles(DIR);
  if (!files.length) die('nothing to commit');

  const violations = [...pairViolations(DIR, files)];
  const secrets = secretScan(DIR, files);
  if (secrets.length) violations.push(...secrets);

  if (violations.length) {
    git(DIR, 'reset');                                  // leave the tree as we found it
    emit({ dir: DIR, branch, staged: files, blocked: violations, verdict: 'refused',
           note: 'index reset; nothing was committed' });
    process.exit(1);
  }

  const full = (phase ? `${phase}: ` : '') + message;
  const r = run('git', ['commit', '-m', full], { cwd: DIR, timeout: 30000 });
  if (!r.ok) die(`commit failed: ${(r.stderr || r.stdout).trim()}`);
  emit({ dir: DIR, branch, phase: phase || null, files,
         commit: git(DIR, 'rev-parse', '--short', 'HEAD').stdout.trim(), verdict: 'committed' });
  process.exit(0);
}

die(`unknown command: ${cmd}`, 2);
