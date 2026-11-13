#!/usr/bin/env node
// Write-mode enforcement. SECURITY.md promises these; this file is what makes
// them true. Every promise is checked here, not merely instructed in a prompt.
//
//   guard.mjs preflight <dir>                      is it safe to write at all?
//   guard.mjs branch    <dir> <lang> <target>      create/switch to runtime/<lang>-<target>
//   guard.mjs commit    <dir> -m <msg> [--phase P] [--include <path>]...
//                                                  validate, then commit
//   guard.mjs status    <dir>                      what guard sees
//
// Exits non-zero and explains when a rule is violated. Never pushes. Never
// force-pushes. Never touches a remote.
import { resolve, join, relative, existsSync, emit, die } from './lib/io.mjs';
import { have, run } from './lib/sh.mjs';
import { ADD_PIN_RULES } from './lib/edits.mjs';
import { ENGINES } from './lib/engines.mjs';
import { LOCKFILES } from './lib/lockdiff.mjs';

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
  // requirements.txt is NOT here: a project with only a requirements.txt has
  // no pyproject.toml to pair it with, and was refused for it.
  ['pyproject.toml', ['poetry.lock', 'uv.lock', 'pdm.lock']],
];

// Files this tool (or the package manager / engine it drives) CREATES. An
// untracked file is staged only when it is one of these or is named with
// --include. `git add -A` staged every untracked file in the repository — a
// developer's stray `.env` went into the commit right after preflight had
// called the tree clean.
const TOOL_OUTPUTS = new Set([
  ...PAIRS.flatMap(([, locks]) => locks), ...LOCKFILES,
  ...Object.values(ADD_PIN_RULES).map(mk => mk('0')).filter(r => r.create).map(r => r.file),
  ...Object.values(ENGINES).map(e => e.configFile).filter(Boolean),
  '.nvmrc', '.node-version', '.go-version', 'rust-toolchain',
]);

// Patterns that must never enter a commit this tool makes.
const SECRET_RE = [
  [/-----BEGIN (RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/, 'private key block'],
  [/\bAKIA[0-9A-Z]{16}\b/, 'AWS access key id'],
  [/\bghp_[A-Za-z0-9]{36}\b/, 'GitHub personal access token'],
  [/\bgithub_pat_[A-Za-z0-9_]{22,}\b/, 'GitHub fine-grained token'],
  [/\bxox[baprs]-[A-Za-z0-9-]{10,}/, 'Slack token'],
  [/\bsk-[A-Za-z0-9]{32,}\b/, 'API secret key'],
  [/\b(?:password|passwd|secret|api[_-]?key|token)\s*[:=]\s*["'][^"'\s]{12,}["']/i, 'hardcoded credential'],
  [/\b[a-z][a-z0-9+.-]*:\/\/[^\s:@\/]+:[^\s:@\/]{3,}@[\w.-]/i, 'credentials embedded in a URL'],
];

// --literal-pathspecs: a staged file named `a[1].js` or `*.env` must be looked
// up as that file, not expanded as a pattern that matches something else.
const git = (dir, ...args) =>
  run('git', ['--literal-pathspecs', '-c', 'core.quotePath=false', ...args], { cwd: dir, timeout: 30000 });
const nul = s => s.split('\0').filter(Boolean);

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
// -z everywhere a filename is read. Without it git C-quotes any non-ASCII name
// (`"caf\303\251.env"`), the quoted string matches no pathspec, and the secret
// scan of that file silently scanned nothing.
function stagedFiles(dir) {
  return nul(git(dir, 'diff', '--cached', '--name-only', '-z').stdout);
}
function untrackedFiles(dir) {
  return nul(git(dir, 'ls-files', '--others', '--exclude-standard', '-z').stdout);
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

  const untracked = untrackedFiles(dir);
  add(true, 'untracked files are never swept into a commit',
      untracked.length ? `${untracked.length} untracked file(s) will be left alone unless the tool created them or --include names them` : 'none');

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
  // Keying on BASENAMES paired any go.mod in the monorepo with any go.sum
  // elsewhere in it. A manifest and its lockfile are a pair only inside the
  // SAME directory.
  const base = f => f.split('/').pop();
  const dirOf = f => f.includes('/') ? f.slice(0, f.lastIndexOf('/')) : '.';
  const byDir = new Map();
  for (const f of files) {
    const d = dirOf(f);
    if (!byDir.has(d)) byDir.set(d, new Set());
    byDir.get(d).add(base(f));
  }
  const bad = [], notes = [];
  const at = (d, f) => d === '.' ? f : `${d}/${f}`;
  for (const [d, names] of byDir)
  for (const [manifest, locks] of PAIRS) {
    const hasM = names.has(manifest);
    const hasL = locks.some(l => names.has(l));
    // `dir` is the repository root and `files` are root-relative, so the
    // lockfile and the manifest are looked up in THEIR directory. Joining on the
    // root checked packages/a/package.json against the root lockfile, which let
    // a dependency change in a sub-package through whenever the root had none.
    const lock = locks.find(l => existsSync(join(dir, d, l)));
    if (hasM && !hasL && lock && manifestChangedDeps(dir, at(d, manifest)))
      bad.push(`${at(d, manifest)} dependencies changed without its lockfile (${lock})`);
    // A lockfile moving alone is what an in-range update produces (`npm update`,
    // `cargo update`, `bundle update`) — the manifest's ranges already admit the
    // new versions. Refusing it made `remediate --deps minor` uncommittable.
    if (hasL && !hasM) notes.push(`${at(d, locks.find(l => names.has(l)))} moved without ${manifest} — an in-range refresh`);
  }
  return { bad, notes };
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
// Every git call below runs from the REPOSITORY ROOT. `git diff --cached
// --name-only` prints root-relative names whatever the cwd is; passing those
// back as pathspecs from a subdirectory matched nothing, so `guard commit
// packages/api` scanned no file and checked no pair — and committed an AWS key.
const TOP = git(DIR, 'rev-parse', '--show-toplevel').stdout.trim() || DIR;

if (cmd === 'status' || cmd === 'preflight') {
  const results = checks(TOP);
  const failed = results.filter(r => !r.ok);
  emit({
    dir: DIR, repoRoot: TOP, branch: currentBranch(TOP), command: cmd,
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
  const dirty = porcelain(TOP).filter(l => !l.startsWith('??'));
  if (dirty.length) die(`working tree is dirty (${dirty.length} file(s)) — commit or stash before branching`);
  const exists = git(TOP, 'rev-parse', '--verify', name).ok;
  const r = exists ? git(TOP, 'switch', name) : git(TOP, 'switch', '-c', name);
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

  const branch = currentBranch(TOP);
  if (PROTECTED.has(branch)) die(`refusing to commit on protected branch "${branch}"`);
  if (!BRANCH_RE.test(branch)) die(`refusing to commit on "${branch}" — write mode requires a runtime/* branch`);

  // --include <path> (repeatable): an untracked file or directory to commit,
  // given relative to <dir> or absolute.
  // Resolved through git's own prefix, not path arithmetic on DIR: TOP is a
  // real path and DIR may reach it through a symlink.
  const prefix = git(DIR, 'rev-parse', '--show-prefix').stdout.trim();
  const include = rest.flatMap((a, i) => a === '--include' && rest[i + 1] ? [rest[i + 1]] : [])
    .map(p => (p.startsWith('/') ? relative(TOP, p) : join(prefix, p)).split('\\').join('/').replace(/\/$/, ''));
  const included = f => include.some(p => f === p || f.startsWith(p + '/'));

  git(TOP, 'add', '-u');                               // tracked changes only
  const leftUntracked = [];
  for (const f of untrackedFiles(TOP)) {
    if (TOOL_OUTPUTS.has(f.split('/').pop()) || included(f)) git(TOP, 'add', '--', f);
    else leftUntracked.push(f);
  }
  const files = stagedFiles(TOP);
  if (!files.length) die(leftUntracked.length
    ? `nothing to commit — ${leftUntracked.length} untracked file(s) were left alone (${leftUntracked.slice(0, 3).join(', ')}); pass --include <path> to commit one`
    : 'nothing to commit');

  const pairs = pairViolations(TOP, files);
  const violations = [...pairs.bad];
  const secrets = secretScan(TOP, files);
  if (secrets.length) violations.push(...secrets);

  if (violations.length) {
    git(TOP, 'reset');                                  // leave the tree as we found it
    emit({ dir: DIR, repoRoot: TOP, branch, staged: files, blocked: violations, verdict: 'refused',
           note: 'index reset; nothing was committed' });
    process.exit(1);
  }

  // `guard commit -m "runtime: go 1.27.3" --phase runtime` produced
  // "runtime: runtime: go 1.27.3"
  const full = (phase && !message.toLowerCase().startsWith(phase.toLowerCase() + ':'))
    ? `${phase}: ${message}` : message;
  const r = run('git', ['commit', '-m', full], { cwd: TOP, timeout: 30000 });
  if (!r.ok) die(`commit failed: ${(r.stderr || r.stdout).trim()}`);
  emit({ dir: DIR, repoRoot: TOP, branch, phase: phase || null, files,
         ...(pairs.notes.length ? { notes: pairs.notes } : {}),
         ...(leftUntracked.length ? { leftUntracked, leftUntrackedNote:
           'untracked files this tool did not create are never committed; pass --include <path> to add one' } : {}),
         commit: git(TOP, 'rev-parse', '--short', 'HEAD').stdout.trim(), verdict: 'committed' });
  process.exit(0);
}

die(`unknown command: ${cmd}`, 2);
