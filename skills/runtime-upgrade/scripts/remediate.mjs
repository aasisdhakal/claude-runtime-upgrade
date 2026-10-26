#!/usr/bin/env node
// Phase 4 — REMEDIATE. Bumps the runtime pins AND upgrades dependency packages.
//
//   node remediate.mjs <lang> <dir> <target> [options]
//     --deps none|patch|minor|latest   default: minor
//     --apply                          actually write (default is dry-run)
//     --no-lockfile                    skip lockfile regeneration
//     --phase <name>                   commit phase label when --apply
//
// Dry-run is the default and emits unified diffs. --apply refuses to touch a
// repo that guard.mjs would not let it commit to, so there is no path where
// changes land on a protected branch.
import { resolve, join, existsSync, readText, emit, die } from './lib/io.mjs';
import { have, run, runJson } from './lib/sh.mjs';
import { byId } from './adapters/index.mjs';
import { planPinEdits, planAddPin, unified, ruleKind, planCiEdits, planConfigEdits } from './lib/edits.mjs';
import { writeFileSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const [langArg, dirArg, target] = argv;
if (!langArg || !dirArg || !target) die('usage: remediate.mjs <lang> <dir> <target> [--deps none|patch|minor|latest] [--apply]', 2);
const flag = n => { const i = argv.indexOf('--' + n); return i >= 0 ? argv[i + 1] : null; };
const has = n => argv.includes('--' + n);
const A = byId[langArg] || die(`unsupported language: ${langArg}. known: ${Object.keys(byId).join(', ')}`, 2);
const DIR = resolve(dirArg);
if (!existsSync(DIR)) die(`no such directory: ${DIR}`);
const DEPS = ['none', 'patch', 'minor', 'latest'].includes(flag('deps')) ? flag('deps') : 'minor';
const APPLY = has('apply');
const LOCK = !has('no-lockfile');

/**
 * Dependency upgrade recipes.
 *   minor  — stay within the declared semver range (safe, no majors)
 *   latest — cross majors; always the riskier of the two, never the default
 * `check` is read-only and runs in dry-run to show what WOULD move.
 */
const DEP_RECIPES = {
  node: () => {
    const pm = existsSync(join(DIR, 'pnpm-lock.yaml')) ? 'pnpm'
             : existsSync(join(DIR, 'yarn.lock')) ? 'yarn'
             : existsSync(join(DIR, 'bun.lock')) || existsSync(join(DIR, 'bun.lockb')) ? 'bun' : 'npm';
    return {
      tool: pm,
      check: { npm: ['outdated', '--json'], pnpm: ['outdated', '--format', 'json'],
               yarn: ['outdated', '--json'], bun: ['outdated'] }[pm],
      checkOk: [0, 1],                                    // `outdated` exits 1 when anything is outdated
      patch:  { npm: ['update'],            pnpm: ['update'],            yarn: ['upgrade'],        bun: ['update'] }[pm],
      minor:  { npm: ['update'],            pnpm: ['update'],            yarn: ['upgrade'],        bun: ['update'] }[pm],
      latest: { npm: ['install'],           pnpm: ['update', '--latest'], yarn: ['upgrade', '--latest'], bun: ['update'] }[pm],
      latestPre: pm === 'npm' ? ['npx', '--yes', 'npm-check-updates', '-u'] : null,
      lockfile:  { npm: ['install', '--package-lock-only'], pnpm: ['install', '--lockfile-only'],
                   yarn: ['install'], bun: ['install'] }[pm],
    };
  },
  php: () => ({ tool: 'composer', check: ['outdated', '--format=json'], checkOk: [0],
                patch: ['update', '--prefer-lowest'], minor: ['update'],
                latest: ['update', '--with-all-dependencies'], lockfile: ['update', '--lock'] }),
  go: () => ({ tool: 'go', check: ['list', '-m', '-u', 'all'], checkOk: [0, 1],
               patch: ['get', '-u=patch', './...'], minor: ['get', '-u', './...'],
               latest: ['get', '-u', './...'], lockfile: ['mod', 'tidy'],
               // go.sum alone is not the whole lockfile when a tree vendors:
               // vendor/modules.txt must agree or nothing builds
               after: existsSync(join(DIR, 'vendor', 'modules.txt')) ? ['mod', 'vendor'] : null }),
  python: () => {
    const poetry = existsSync(join(DIR, 'poetry.lock'));
    const uv = existsSync(join(DIR, 'uv.lock'));
    if (uv) return { tool: 'uv', check: ['pip', 'list', '--outdated'], checkOk: [0],
                     patch: ['lock'], minor: ['lock'], latest: ['lock', '--upgrade'], lockfile: ['lock'] };
    if (poetry) return { tool: 'poetry', check: ['show', '--outdated'], checkOk: [0],
                         patch: ['update'], minor: ['update'], latest: ['update'], lockfile: ['lock'] };
    return { tool: 'pip', check: ['list', '--outdated', '--format=json'], checkOk: [0],
             patch: null, minor: null, latest: null, lockfile: null,
             note: 'plain requirements.txt has no safe automated upgrade — use pip-compile or uv' };
  },
  ruby: () => ({ tool: 'bundle', check: ['outdated', '--parseable'], checkOk: [0, 1],
                 patch: ['update', '--patch'], minor: ['update', '--minor'],
                 latest: ['update'], lockfile: ['lock', '--update'] }),
  rust: () => ({ tool: 'cargo', check: ['update', '--dry-run'], checkOk: [0],
                 patch: ['update'], minor: ['update'], latest: ['update'], lockfile: ['generate-lockfile'] }),
  java: () => ({ tool: 'mvn', check: ['versions:display-dependency-updates'], checkOk: [0],
                 patch: ['versions:use-next-patches'], minor: ['versions:use-next-releases'],
                 latest: ['versions:use-latest-releases'], lockfile: null }),
  dotnet: () => ({ tool: 'dotnet', check: ['list', 'package', '--outdated'], checkOk: [0],
                   patch: null, minor: null, latest: null, lockfile: ['restore'],
                   note: 'dotnet has no built-in bulk upgrade — use `dotnet-outdated-tool` or edit PackageReference versions' }),
  deno:   () => ({ tool: 'deno', check: ['outdated'], checkOk: [0, 1], patch: ['outdated', '--update'],
                   minor: ['outdated', '--update'], latest: ['outdated', '--update', '--latest'], lockfile: ['cache', '--reload'] }),
  bun:    () => ({ tool: 'bun', check: ['outdated'], checkOk: [0, 1], patch: ['update'],
                   minor: ['update'], latest: ['update', '--latest'], lockfile: ['install'] }),
  elixir: () => ({ tool: 'mix', check: ['hex.outdated'], checkOk: [0, 1], patch: ['deps.update', '--all'],
                   minor: ['deps.update', '--all'], latest: ['deps.update', '--all'], lockfile: ['deps.get'] }),
  erlang: () => ({ tool: 'rebar3', check: ['deps'], checkOk: [0], patch: ['upgrade'],
                   minor: ['upgrade'], latest: ['upgrade'], lockfile: ['lock'] }),
  kotlin: () => ({ tool: 'gradle', check: ['dependencyUpdates'], checkOk: [0, 1], patch: null,
                   minor: null, latest: null, lockfile: ['dependencies', '--write-locks'],
                   note: 'Gradle has no built-in bulk upgrade — use the ben-manes versions plugin' }),
  scala:  () => ({ tool: 'sbt', check: ['dependencyUpdates'], checkOk: [0, 1], patch: null,
                   minor: null, latest: null, lockfile: null, note: 'use sbt-updates or Scala Steward' }),
  perl:   () => ({ tool: 'cpanm', check: null, checkOk: [0], patch: null, minor: null, latest: null,
                   lockfile: null, note: 'use `carton update` when a cpanfile.snapshot is present' }),
};

// ---------------- step 1: runtime pins ----------------
const RAISE_FLOOR = has('raise-floor');
const { edits, declinedFloors, compoundConstraints, unsupported } = planPinEdits(A.id, DIR, target, { raiseFloor: RAISE_FLOOR });
// A project that declares the runtime nowhere in its manifest has nothing to
// rewrite — and is precisely the project that needs a pin. Add one.
let addedPin = null;
let pinRefusal = null;
// "the repo root" is where the VCS says it is, not wherever we were pointed
function isRepoRoot(d) {
  if (existsSync(join(d, '.git'))) return true;
  const top = run('git', ['-C', d, 'rev-parse', '--show-toplevel'], { timeout: 5000 });
  if (top.status === 0 && top.stdout.trim()) return resolve(top.stdout.trim()) === resolve(d);
  // no VCS to ask: a Cargo/npm workspace manifest above us means we are not it
  for (const up of ['..', '../..', '../../..'])
    for (const mf of ['Cargo.toml', 'go.work', 'pnpm-workspace.yaml'])
      if (existsSync(join(d, up, mf))) return false;
  return true;
}
let alreadyCurrent = false;
// A workspace root often declares nothing while its members all do. Creating a
// toolchain pin there overrides every member and claims "the project declared
// no runtime" — false, and for tokio it would have forced current stable on
// every contributor.
let declaredElsewhere = null;
{
  const det = runJson(process.execPath, [join(HERE, 'detect.mjs'), DIR]);
  const others = (det.data?.targets || []).filter(t => t.lang === A.id && t.declaredMajors);
  if (others.length) declaredElsewhere = others.map(t => `${t.dir} [${t.declaredMajors}]`);
}
if (!edits.length && !argv.includes('--no-add-pin')) {
  if (declaredElsewhere) {
    // nothing to add: the repo DOES declare this runtime, just not here
    alreadyCurrent = false;
  } else addedPin = planAddPin(A.id, DIR, target, { isRoot: isRepoRoot(DIR) });
  // "no edit was possible" is not "nothing is declared". A workspace-inherited
  // MSRV, a computed gemspec constraint and a property-indirected pom all
  // DECLARE a version this rewriter cannot read. Creating a pin beside one adds
  // a contradictory source of truth — and a rust-toolchain.toml in a directory
  // is a rustup override that changes the toolchain for every contributor.
  if (addedPin?.blocked) { pinRefusal = addedPin; addedPin = null; }
  // creating engines.node / require.php is creating a floor, not a pin
  if (addedPin && ruleKind(addedPin.rule) === 'floor' && !RAISE_FLOOR) {
    declinedFloors.push({ file: addedPin.file, rule: addedPin.rule, kind: 'floor',
      why: 'adding this would declare a consumer-facing minimum this project never claimed. '
         + 'Pass --raise-floor if that is intended.' });
    addedPin = null;
  }
  if (addedPin) edits.push(addedPin);
  else {
    // no rewrite AND no pin to add: either the project is already on the target,
    // or an edit was deliberately declined (a Scala cross-build val, say).
    // Saying "0 pins" for both is how a refusal reads as a no-op.
    const probe = planPinEdits(A.id, DIR, target + '.0-probe');
    alreadyCurrent = probe.edits.length === 0;
  }
}
const pinDiffs = edits.map(e => ({ file: e.file, rule: e.rule, diff: unified(e.file, e.before, e.after) }));

// ---------------- step 1b: CI and build config ----------------
// These were computed only by the read-only plan.mjs, so SKILL.md's promise
// that "CI and build config move too" was never kept by any write path. An
// upgrade that leaves .github/workflows on the old version is the exact failure
// the skill warns about: it passes locally and builds on the old runtime forever.
const CI = argv.includes('--no-ci') ? [] : planCiEdits(A.id, DIR, target);
const CONFIG = argv.includes('--no-ci') ? [] : planConfigEdits(A.id, DIR, target);
const sideEdits = [...CI, ...CONFIG];
const ciKept = CI.skipped || [];

// ---------------- step 2: dependency packages ----------------
/**
 * Some repos own their dependency resolution through their OWN tooling, and a
 * generic bulk upgrade corrupts them. Measured on kubernetes:
 *   `go get -u ./...` rewrote the deliberate `k8s.io/api v0.0.0` placeholders
 *   (maintained by hack/update-vendor.sh and replace-pinned to ./staging/...)
 *   to real tags, never regenerated vendor/, and left the tree unable to build
 *   at all — while remediate reported deps.ok: true and guard committed it.
 *
 * So check first, and refuse rather than wreck. `--force-deps` is the opt-out.
 */
function dependencySafety(lang, dir) {
  const blocks = [];
  const read = f => { try { return readFileSync(join(dir, f), 'utf8'); } catch { return ''; } };
  if (lang === 'go') {
    const gomod = read('go.mod');
    if (existsSync(join(dir, 'vendor', 'modules.txt')))
      blocks.push({ why: 'this module vendors its dependencies',
        risk: 'a bulk `go get -u` updates go.mod but not vendor/, and `go build` then fails with "inconsistent vendoring" on every package',
        instead: 'run `go get -u ./... && go mod tidy && go mod vendor` as one unit, or let the repo\'s own vendor script do it' });
    // replace directives come in two spellings: a bare `replace x => ./y` line
    // and a `replace ( ... )` block whose lines carry no keyword at all. k8s and
    // grafana both use the block form, so keying on the keyword saw none of them.
    const localReplace = [...gomod.matchAll(/^\s*(?:replace\s+)?(\S+)\s+=>\s+\.{1,2}\//gm)].map(m => m[1]);
    if (localReplace.length)
      blocks.push({ why: `${localReplace.length} module(s) are replace-pinned to a local path`,
        risk: 'their `require` lines are placeholders the repo maintains itself; a bulk upgrade rewrites them to published tags and breaks the local wiring',
        instead: 'upgrade the published dependencies only, and leave replace-pinned requires alone',
        examples: localReplace.slice(0, 3) });
    if (existsSync(join(dir, 'go.work')) || existsSync(join(dir, '..', 'go.work')))
      blocks.push({ why: 'a go.work workspace governs this module',
        risk: 'the workspace carries its own `go` directive; raising a module floor past it fails with "module ... requires go >= X, but go.work lists go Y"',
        instead: 'move the go.work directive first (`go work edit -go=<version>`), then the members' });
  }
  if (lang === 'node') {
    // yarn berry removed `upgrade` in favour of `up`; the v1 recipe just errors
    const pmField = (() => { try { return JSON.parse(read('package.json')).packageManager || ''; } catch { return ''; } })();
    const berry = /^yarn@([2-9]|\d{2})/.test(pmField);
    if (berry) blocks.push({ why: `package.json declares ${pmField}`,
      risk: 'Yarn Berry removed `yarn upgrade`; the command this tool would run fails with "Couldn\'t find the node_modules state file"',
      instead: 'use `yarn up` (Berry) — this tool\'s recipe targets Yarn 1' });
  }
  return blocks;
}

const recipe = (DEP_RECIPES[A.id] || (() => null))();
const deps = { mode: DEPS, tool: recipe?.tool ?? null, note: recipe?.note ?? null };

const depBlocks = DEPS !== 'none' ? dependencySafety(A.id, DIR) : [];
const FORCE_DEPS = argv.includes('--force-deps');
if (DEPS !== 'none' && depBlocks.length && !FORCE_DEPS) {
  deps.refused = true;
  deps.blockers = depBlocks;
  deps.error = `dependency upgrade REFUSED — ${depBlocks.length} condition(s) make a bulk upgrade unsafe here. ` +
               `Nothing was run. Pass --force-deps only if you have read each one.`;
} else if (DEPS !== 'none' && recipe) {
  if (depBlocks.length) deps.forcedPast = depBlocks;
  if (!have(recipe.tool)) {
    deps.error = `${recipe.tool} is not installed — dependency packages were NOT upgraded`;
  } else if (!recipe[DEPS]) {
    deps.error = `${recipe.tool} has no safe bulk "${DEPS}" upgrade. ${recipe.note || ''}`.trim();
  } else {
    if (recipe.check) {
      const c = run(recipe.tool, recipe.check, { cwd: DIR, timeout: 180000 });
      deps.outdatedRaw = (c.stdout || c.stderr).slice(0, 6000);
      deps.outdatedExit = c.status;
    }
    deps.command = [recipe.tool, ...recipe[DEPS]].join(' ');
    if (recipe.latestPre && DEPS === 'latest') deps.preCommand = recipe.latestPre.join(' ');
  }
}

// ---------------- apply ----------------
const applied = { pins: [], ci: null, deps: null, lockfile: null };
if (APPLY) {
  // never write anywhere guard would refuse to commit
  const pre = runJson(process.execPath, [join(HERE, 'guard.mjs'), 'preflight', DIR]);
  if (!pre.data || pre.data.verdict !== 'safe-to-write') {
    emit({ lang: A.id, dir: DIR, target, mode: 'apply', refused: true,
           reason: 'guard preflight failed — fix these before writing',
           guard: pre.data?.checks?.filter(c => !c.ok) ?? pre.stderr });
    process.exit(1);
  }
  for (const e of edits) { writeFileSync(e.path, e.after); applied.pins.push({ file: e.file, rule: e.rule }); }
  applied.ci = [];
  for (const e of sideEdits) { writeFileSync(e.path, e.after); applied.ci.push({ file: e.file, rule: e.rule }); }

  if (deps.command) {
    if (deps.preCommand) {
      const [c, ...a] = deps.preCommand.split(' ');
      const r = run(c, a, { cwd: DIR, timeout: 600000 });
      applied.preCommand = { command: deps.preCommand, ok: r.ok, output: (r.stdout || r.stderr).slice(0, 3000) };
    }
    const [c, ...a] = deps.command.split(' ');
    const r = run(c, a, { cwd: DIR, timeout: 900000 });
    applied.deps = { command: deps.command, ok: r.ok, exit: r.status, output: (r.stdout || r.stderr).slice(0, 6000) };
  }
  // regenerating a lockfile is right; CREATING one the project never had is not
  const LOCK_FILES = ['package-lock.json', 'pnpm-lock.yaml', 'yarn.lock', 'bun.lock', 'bun.lockb',
                      'composer.lock', 'go.sum', 'Cargo.lock', 'Gemfile.lock', 'poetry.lock',
                      'uv.lock', 'pdm.lock', 'Pipfile.lock', 'mix.lock', 'rebar.lock',
                      'packages.lock.json', 'deno.lock', 'cpanfile.snapshot'];
  const hadLock = LOCK_FILES.some(f => existsSync(join(DIR, f)));
  // A lockfile regen is a DEPENDENCY operation. This block ignored both the
  // refusal and `--deps none`, so a run that reported "Nothing was run" still
  // executed `go mod tidy` on the vendored kubernetes tree (mutating go.sum and
  // then attempting `go mod vendor`), and `bundle lock --update` on rails under
  // `--deps none`. Regenerating a lockfile nobody asked to change is exactly
  // the unrequested mutation the refusal exists to prevent.
  const lockAllowed = DEPS !== 'none' && !deps.refused;
  if (LOCK && hadLock && !lockAllowed) {
    applied.lockfile = { skipped: deps.refused
      ? 'the dependency upgrade was REFUSED — regenerating the lockfile would mutate resolution anyway'
      : 'no dependency upgrade was requested (--deps none) — the lockfile is left exactly as it is' };
  } else if (LOCK && hadLock && recipe?.lockfile && have(recipe.tool)) {
    const r = run(recipe.tool, recipe.lockfile, { cwd: DIR, timeout: 900000 });
    applied.lockfile = { command: [recipe.tool, ...recipe.lockfile].join(' '), ok: r.ok,
                         output: (r.stdout || r.stderr).slice(0, 3000) };
    if (recipe.after) {
      const v = run(recipe.tool, recipe.after, { cwd: DIR, timeout: 900000 });
      applied.vendor = { command: [recipe.tool, ...recipe.after].join(' '), ok: v.ok,
                         why: 'go.sum and vendor/modules.txt must agree or the tree does not build',
                         output: (v.stdout || v.stderr).slice(0, 3000) };
    }
  } else if (LOCK && !hadLock) {
    applied.lockfile = { skipped: 'the project has no lockfile — creating one is not this tool\'s call' };
  }
}

emit({
  lang: A.id, dir: DIR, target,
  mode: APPLY ? 'apply' : 'dry-run',
  unsupportedLanguage: unsupported || undefined,
  runtimePins: { count: edits.length, files: edits.map(e => `${e.file} (${e.rule})`), diffs: pinDiffs,
                 declinedFloors: declinedFloors || [],
                 // a cap, exclusion or disjunction that no mechanical rewrite
                 // preserves — left alone and named rather than flattened
                 compoundConstraints: compoundConstraints || [],
                 raiseFloor: RAISE_FLOOR,
                 addedPin: addedPin ? { file: addedPin.file, created: addedPin.created,
                   why: 'the project declared no runtime in its manifest — nothing enforced the version' } : null,
                 declaredElsewhere,
                 // why no pin was created here, when one could have been
                 pinNotCreated: pinRefusal || undefined,
                 status: edits.length ? 'rewritten'
                       : pinRefusal?.declaredButUnreadable
                           ? 'declined — a version IS declared here, in a form this tool cannot rewrite'
                       : pinRefusal?.rootOnly
                           ? `declined — creating ${pinRefusal.rootOnly} here would override the toolchain for everyone building in this directory`
                       : declaredElsewhere ? (String(declaredElsewhere).split(',').some(x => x.trim().startsWith('.'))
                           ? 'declined — an edit was possible here but was judged unsafe; the version is declared in this directory'
                           : 'declined — this runtime is declared in sub-packages, not here')
                       : alreadyCurrent ? 'already-on-target'
                       : 'declined — an edit was possible but unsafe (see the language playbook)' },
  ciAndConfig: {
    count: sideEdits.length,
    files: sideEdits.map(e => `${e.file} (${e.rule})`),
    diffs: sideEdits.map(e => unified(e.file, e.before, e.after)),
    // jobs deliberately pinned BELOW the repo's newest are the compatibility
    // matrix; collapsing them deletes the only proof the declared floor works
    keptDeliberately: ciKept,
    note: sideEdits.length
      ? 'CI moves with the runtime — otherwise the upgrade passes locally and CI builds the old version forever'
      : 'no CI or build-config file names this runtime',
  },
  dependencies: deps,
  applied: APPLY ? applied : undefined,
  nextSteps: APPLY
    ? ['re-run assess.mjs — the dependency tree changed',
       'run the test suite with deprecations made fatal',
       `commit via: node ${join(HERE, 'guard.mjs')} commit ${DIR} -m "<msg>" --phase ${flag('phase') || 'remediate'}`]
    : ['review the diffs above',
       're-run with --apply to write (guard preflight must pass first)',
       `dependency mode is "${DEPS}" — use --deps latest only when you intend to cross majors`,
       ...(declinedFloors?.length
         ? [`${declinedFloors.length} consumer-facing FLOOR(s) left alone — pass --raise-floor only if you mean to change the support contract`]
         : [])],
});
