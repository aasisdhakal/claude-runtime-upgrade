---
name: runtime-upgrade
description: Upgrade a language runtime — Node.js, PHP, Go, Python, Ruby, Rust, Java, .NET, Deno, Bun, Elixir, Erlang, Kotlin, Scala or Perl — across any repo shape (single, monorepo, polyrepo, mixed-language, container-only). Covers discovery, EOL and CVE research, framework EOL, blocker assessment, rewriting runtime pins, upgrading all dependency packages, guarded commits, and verification gates. Also researches any of the 485 products endoflife.date tracks. Use when asked to upgrade, bump or modernise a language/runtime version, to check what runtime a project is on, to audit runtime or framework EOL/CVE exposure, or to plan a version migration.
---

# Runtime upgrade (Node.js · PHP · Go · Python · Ruby · Rust · Java · .NET)

Takes any repo from "what are we on?" to a verified upgrade. Five gated phases. The deterministic work runs in zero-dependency Node; you supply judgement.

## Gate capability — read this before promising anything

Only **two** runtimes have a curated, version-ranged CVE database. The rest cannot be hard-gated on runtime CVEs, and `research.mjs` says so per language:

| Runtime | Gate | Metric | Why |
|---|---|---|---|
| **Node.js** | ✅ | high/critical | `nodejs/security-wg`, severity-rated |
| **Go** | ✅ | **total** | OSV `stdlib` is version-ranged but carries **no severity** |
| PHP · Python · Ruby · Rust · Java · .NET | ❌ | — | no unified runtime CVE feed; gate on EOL + the ecosystem auditor |

Under `CVE_POLICY=gate` for a non-gating language, gate on **EOL/support status and dependency advisories**, and present runtime CVEs as advisory. Check `gateCapable` and `gateMetric` in the research output and say which you are enforcing. Never imply a gate you cannot enforce.

`SK=~/.claude/skills/runtime-upgrade` in the examples below.

## Ask the user two things first — always

Before running any phase, use **AskUserQuestion** to settle these. Do not assume defaults.

**1. CVE policy**
- **Hard gate** — the upgrade FAILS if the target still carries high/critical runtime CVEs, or if dependency advisories remain above zero. Use for production, regulated, or internet-facing services.
- **Report and decide** — surface everything, let the user choose what blocks. Use for internal tools, spikes, or when a blocker has no fix yet.

Carry the answer as `CVE_POLICY=gate|report` through every later phase.

⚠️ Tell the user this when they pick: **a hard gate is only fully enforceable for Node.** `research.mjs` returns `gate_capable: true` for Node (curated, semver-ranged CVE DB) and `false` for PHP (NVD CPE only — noisy, historical, not "unpatched at this version"). For PHP under `gate`, gate on **EOL/support status and dependency advisories**, and present runtime CVEs as advisory. Say so rather than implying a gate you cannot enforce.

**2. Action mode**
- **Plan only** — read-only. Produce the upgrade plan, the diffs, and the ticket text. Change nothing.
- **Plan and write** — apply changes. Then: work on a branch (`git switch -c runtime/<lang>-<target>`), commit per phase, never commit a lockfile without its manifest.

Carry as `MODE=plan|write`. Under `plan`, every phase is read-only — emit diffs with `diff -u`, never apply them.

**Under `write`, route every change through `guard.mjs`. Do not run `git` yourself.**
```bash
node $SK/scripts/guard.mjs preflight <dir>                   # safe to write? exits 1 if not
node $SK/scripts/guard.mjs branch    <dir> node 24.22.1      # creates runtime/node-24.22.1
node $SK/scripts/guard.mjs commit    <dir> -m "msg" --phase runtime
```
Guard **enforces** what this skill promises, rather than trusting the model to remember it:
- refuses to commit on `main`/`master`/`develop`/`prod`/`release`, or on any branch not matching `runtime/*`
- refuses to branch from a dirty tree
- refuses a manifest change without its lockfile (and vice versa), resetting the index so nothing is left staged
- scans the staged diff for private keys, AWS/GitHub/Slack tokens and hardcoded credentials, and refuses
- **contains no push, force, or remote code path at all** — publishing a branch is always a human action

Also ask, when it is not obvious: **which target version** (otherwise `research.mjs` picks the newest non-EOL LTS), and **which targets** when discovery finds more than ~6.

## Start here — the plan

```bash
node $SK/scripts/plan.mjs <dir> [--target V] [--policy gate|report] [--format md] [--only a,b]
```

**One command runs every read-only phase and synthesises the whole plan.** Prefer it over driving the phases by hand; reach for the individual scripts when you need to dig into one.

It produces, per target:

| Section | What it answers |
|---|---|
| current → target, EOL | are we on something dead, and what is supported until when |
| CVE delta | how many unpatched runtime CVEs the upgrade closes |
| dependency advisories | what the ecosystem auditor says |
| frameworks | framework EOL — **often the real blocker**, plus any with no upstream feed |
| source scan | removed APIs, runtime deprecations and **silent behaviour changes**, with file:line |
| blockers vs noise | ABI-pinned addons separated from N-API no-ops |
| **ordered steps** | each with *why*, concrete actions, and a machine-checkable **exit condition** |
| pre-existing debt | deprecations that predate this upgrade — not blocking, but what the next major breaks |
| test strategy | the ladder, and how to make deprecations fatal for this language |
| rollback | trigger, procedure, and what reverting re-exposes |
| risk | level plus the specific signals behind it |
| estimate | story points scaled to blockers, dependency surface and dead frameworks |

Across several targets it also emits **sequencing** — which repo is the pilot and why, which goes last, and which blockers are shared so they get fixed once.

`--format md` renders a document you can paste into a ticket. Every command it prints is runnable verbatim.

**The step order is not cosmetic.** Hard blockers are cleared *before* the runtime moves, and behaviour changes are characterized with tests *while still on the old version* — capture the current answer first, or there is nothing to compare against. Dependencies move in their own commit after the runtime, so a broken build has one cause.

## Phase 1 — DISCOVER

```bash
node $SK/scripts/detect.mjs <root> 
```
Emits `{root, shape, targetCount, targets[], siblingPackages, discoveryGaps, platformPublishStubs}`.
`shape` is one of `single`, `monorepo`, `multi-package`, `polyrepo`, `mixed-single`, `container-only`,
`no-manifest` — handle all seven:

| shape | what to do |
|---|---|
| `single` | one target, straightforward |
| `monorepo` | root + sibling packages, in **any** ecosystem — not just a declared JS workspace. Upgrade the **root** runtime pin once; each package gets its own compat pass. **One ticket for the repo**, never one per package |
| `multi-package` | packages below a root that pins **nothing** (a bare `[workspace]` Cargo.toml). Each package is its own target; do not try to edit a root package that is not there |
| `polyrepo` | a directory of independent repos. Each is its own unit of work with its own branch and rollback |
| `mixed-single` | Node **and** PHP in one repo (Laravel+Vite, Symfony+Encore). Run both adapters; **upgrade them in separate commits** |
| `container-only` | no manifest, runtime pinned only in a Dockerfile. Add a manifest pin as part of the work — otherwise nothing enforces the version |
| `no-manifest` | report it and stop. There is nothing to upgrade until someone declares a runtime |

Two fields worth reading before you trust a count:

- **`discoveryGaps`** — what the walk could NOT see: a file cap reached, directories below the depth
  limit, and directories skipped by an ambiguous name (`build`, `out`, `target`, `bin`, `dist`).
  Absent means the walk was complete. Present means the target list is a floor, not a total — grafana
  keeps a real Go module at `pkg/build/wire`, and `build` is in that skip set.
- **`platformPublishStubs`** — packages that ship one prebuilt binary for one platform and nothing
  else (`os`/`cpu` fields, no dependencies, a `.node` main). They are reported and never planned:
  there is no source in them to upgrade, and their `engines` floor is published metadata.

**Report `drift: true` as a finding, not a lookup result.** A repo whose `.nvmrc` and Dockerfile disagree has a bug before the upgrade starts. Check `declared_majors` — more than one value means the version differs across files.

## Phase 2 — RESEARCH

```bash
node $SK/scripts/research.mjs node   20.11.1        # target auto-selected
node $SK/scripts/research.mjs php    8.1  8.4       # explicit target
node $SK/scripts/research.mjs go     1.21           # gates on TOTAL stdlib advisories
node $SK/scripts/research.mjs python 3.9            # advisory only — gateCapable false
RU_NVD=1 node $SK/scripts/research.mjs php 8.1      # opt into the NVD CPE lookup (slow, advisory)
```
Returns EOL dates, support/maintenance windows, and — for Node — exact unpatched runtime CVE counts at both current and target, plus `cve_delta`.

Present `cve_delta.blocking_removed` as the headline. It converts "should we upgrade?" into arithmetic.

Under `CVE_POLICY=gate`, stop here if `target.cve.blocking > 0` — the chosen target is itself vulnerable; pick a newer patch.

## Phase 3 — ASSESS

```bash
node $SK/scripts/assess.mjs node <dir> 24.22.1
RU_ENGINES=1 node $SK/scripts/assess.mjs node <dir> 24.22.1   # + each direct dep's own engines floor (slow, network)
node $SK/scripts/assess.mjs php  <dir> 8.4
```

**The native-addon classification is the highest-value output.** `native_blockers` lists only `abi-pinned` packages — the ones that genuinely stop the upgrade. `napi` entries are no-ops; do not put them in a ticket as blockers. Getting this backwards turns a 2-point ticket into a 13-point one, or hides a real blocker.

Then apply judgement the scripts cannot:
- Walk `direct_dep_engines` against the target floor. A dep whose floor exceeds the target blocks it; a dep whose *newest compatible* release requires a different major of something else is a **coupling** — find those before estimating.
- Separate **runtime** work from **framework** work. Split framework majors into their own ticket unless a dependency's peer/engines range genuinely couples them — and prove the coupling by reading the peer ranges, don't assume it.
- For PHP, read `blocking_packages` (`composer prohibits`) and the extension list. Every compiled extension needs recompiling for a new **minor**; PHP has no N-API.

## Framework EOL — often the real blocker

```bash
node $SK/scripts/frameworks.mjs <dir>
```
The runtime is frequently the smaller half of the work. endoflife.date tracks **41 frameworks** (Laravel, Symfony, Django, Rails, Spring Boot, Next.js, Angular, React, Vue, Drupal, WordPress…). Anything it does not track — **NestJS, FastAPI, Flask, Quarkus, Ember, Tailwind** — is reported under `untracked`. Say it has no upstream feed; never imply a date exists.

Run this during Phase 3. A framework that is years EOL changes the plan more than the runtime does.

## Phase 3b — SCAN THE SOURCE

```bash
node $SK/scripts/scan.mjs <lang> <dir> <from> <to> [--include-existing]
```
Finds code the upgrade will break, with `file:line`. Three severity classes, and the third is the one that hurts:

- **`removed`** — will throw or fail to build. Must be fixed.
- **`runtime`** — deprecated, warns loudly, still works. Fix before the *next* major.
- **`behaviour`** — **still runs, different answer.** No exception, no warning. A grep cannot verify this; only a test can.

Rules fire only inside the upgrade window — scanning for Node 26 removals while going 20 → 22 is noise. `--include-existing` additionally reports deprecations that predate the current version: not caused by this upgrade, but exactly what the next one turns into failures.

**68 rules across all 15 languages.** Bun has no separate catalogue — it executes Node APIs, so it inherits Node's, and `inheritedFrom` says so in the output.

**Matching is code-only.** Comments, docstrings and string literals are blanked before matching (byte-for-byte, so line numbers stay exact). Without that, Scala's symbol-literal rule matched the apostrophe in `` `Const`'s `` and Java's `sun.misc.Unsafe` rule matched a Javadoc paragraph — 35 of 35 findings across four real repos were prose.

**If no rule falls inside the window, the output says "not catalogued here", not "nothing breaks".** Read the upstream release notes.

## Phase 4 — REMEDIATE

**Bump the manifest floor first.** This is the lever that makes every other tool report against the target instead of the status quo:
- Node: set `engines.node` to the target → `eslint-plugin-n` then reports every forbidden API
- PHP: set `require.php` → Rector will not apply target-version rules until you do

```bash
node $SK/scripts/remediate.mjs <lang> <dir> <target> [--deps minor|latest|patch|none] [--apply]
```
`remediate.mjs` does both halves of the job — it rewrites every runtime pin (manifest, version file, Dockerfile `FROM`, `.tool-versions`) **and** upgrades the dependency packages with that ecosystem's own tool.

**CI and build config move too**, and `remediate --apply` writes them: `setup-*` action inputs,
container images, `tsconfig` target, `.npmrc engine-strict`, `composer config.platform.php`. A runtime
that CI does not also move is how an upgrade passes locally and then builds on the old version forever.
Pass `--no-ci` to touch only the runtime pins.

Three rules the rewriter follows, each of which it previously broke:
- **Only the repo's newest CI version moves.** A job pinned below it is a lowest-supported job, and
  symfony keeps those in separate files (`phpunit-bridge.yml` at 8.1, `json-schema.yml` at 8.2). They
  are returned in `ciAndConfig.keptDeliberately` — add the target as another job rather than
  collapsing them.
- **A templated tag is not a version.** `cimg/node:<< pipeline.parameters.node-version >>` and
  `${{ matrix.node }}` are left alone.
- **An image name is matched whole.** `dunglas/frankenphp:1.12.1-php8.4` is not a PHP image.

**A CI version matrix is never collapsed, and nothing here extends one for you.** `ciMatrixAdvice`
reports the matrix it found and leaves it exactly as written; adding the target as a new entry is a
hand edit. Keep the old version alongside the new one for the whole migration window — testing only
the new one is how a compatibility fix silently breaks what production still runs.

- **Dry-run is the default.** It emits unified diffs and writes nothing.
- **`--deps minor`** (default) stays inside declared semver ranges — it will NOT move an exact pin like `"ms": "2.1.2"`.
- **`--deps latest`** crosses majors and rewrites the manifest ranges themselves. This is what "upgrade all the dependency packages" actually needs, and it is the riskier mode — never the default.
- **`--apply` runs `guard.mjs preflight` first and refuses to write if it fails**, so changes cannot land on a protected branch.

After applying: re-run `assess.mjs` (the dependency tree changed), run the suite with deprecations made fatal, then commit through `guard.mjs commit`.

Then follow the per-language playbook:
- `references/nodejs.md` — ABI ladder, N-API, AsyncContextFrame, eslint-plugin-n
- `references/php.md` — bootstrap, Zend ABI, Rector, `composer prohibits`
- `references/languages.md` — Go, Python, Ruby, Rust, Java, .NET: discovery paths, ABI model, codemod tool

Rules that hold for both:
- **One major at a time**, commit between each. Never stack two majors in one diff.
- Regenerate the lockfile with the **new** runtime's package manager.
- Under `MODE=plan`, emit diffs only.

### A bulk dependency upgrade can wreck a repo — it is checked first

Some repos own their dependency resolution through their own tooling, and a generic bulk upgrade
corrupts them. `remediate` refuses rather than wrecking, and names each condition in
`dependencies.blockers`:

| condition | what the generic command does |
|---|---|
| a `vendor/modules.txt` exists | `go get -u ./...` updates `go.mod` but not `vendor/`, and then **no package builds** ("inconsistent vendoring") |
| `replace … => ./local` directives | those `require` lines are placeholders the repo maintains itself; a bulk upgrade rewrites them to published tags |
| a `go.work` governs the module | the workspace carries its own `go` directive; raising a module floor past it fails outright |
| `packageManager: yarn@2+` | Berry removed `yarn upgrade`; the Yarn 1 command fails |

Measured on kubernetes: the unchecked path rewrote 126 `require` lines including the dead
`client-go v1.5.2` tag, never regenerated `vendor/`, left the tree unbuildable — and reported
`deps.ok: true`, after which the guard happily committed it.

`--force-deps` runs anyway. Read every blocker first; there is no safe default that ignores them.

### Raising a floor preserves everything except the lower bound

A floor is often more than a minimum. `>=3.9,<4.0` has a chosen cap; `>=8.1.0 <8.3 || ~8.4.2` is a
disjunction; `>=3.8,!=3.9.*,<3.14` excludes a release *and* caps above it. Replacing the whole value
silently changes what the project claims to support — in the last case it reverses it.

So: only the `>=` term moves, every other term is preserved verbatim, and a constraint that cannot be
rewritten safely is **left exactly as written** and reported in `runtimePins.compoundConstraints`.
A cap that would sit below the new floor is a refusal, not a flatten.

### A pin is never invented over a declaration that already exists

"No edit was possible" and "nothing is declared" are different findings. A `rust-version.workspace =
true`, a `required_ruby_version = Gem::Requirement.new(...)`, a `<java.version>${jdk.version}</java.version>`
and an `engines` block in a JSONC `package.json` all DECLARE a version this rewriter cannot read.
Creating a pin beside one adds a second, contradictory source of truth — see
`runtimePins.pinNotCreated`.

And a `rust-toolchain.toml` is only ever created at the repo **root**: in a subdirectory it is a
rustup override that silently changes the toolchain for everyone who builds there.

## Phase 4a — DELEGATE THE SOURCE REWRITE, THEN FIX WHAT IS LEFT

**Do not hand-write what Rector already does.** For six languages a maintained engine
rewrites source far better than any regex catalogue, and the rule catalogue here
deliberately excludes everything they cover. `fix.mjs` reports the boundary in its
`delegate` block; `doctor.mjs` reports which engines this machine can actually run.

| Language | Engine | What it leaves you |
|---|---|---|
| PHP | **Rector** (145 rules, MIT) | pins, CI, composer resolution, extension breakage, and 5 deprecations it has no rule for |
| Python | **Ruff** `UP` (MIT) | every stdlib REMOVAL — `UP035` runs off a hardcoded 8-module whitelist |
| Java | **OpenRewrite** `UpgradeToJavaNN` (Apache-2.0) | `sun.misc.Unsafe`, Java 24 (no recipe exists), and **beware: it also rewrites pins** |
| Go | **`go fix`** (Go ≥1.26 only) | `ioutil.ReadDir`/`Discard`, `maps.Keys`/`Values`, `rand.Seed` |
| Node | **nodejs/userland-migrations** | everything past Node 24 — no v24→v26 recipe exists |
| Scala | **`scalac -source:3.0-migration -rewrite`** | ~65% of it; type inference has zero automation |
| Elixir | **`mix format --migrate`** (≥1.18) | anything needing a target version — it keys off the RUNNING Elixir |
| Deno | **`deno lint --fix`** | all of Deno 1→2 except the `window` global (9 of 121 rules have fixes) |

Ruby, Rust, .NET, Erlang, Kotlin and Perl have **no credible rewriter** — `doctor.mjs`
carries the evidence for each. There the catalogue is the only coverage.

**Never install an engine.** This skill is node + git + curl. An absent engine still
yields the exact config and command to run elsewhere; the catalogue covers the rest.

**Run the engine FIRST, then re-run `fix.mjs`** — the rules here are what it leaves behind.

### Traps that make an engine silently do nothing

These are observed failures, not theory. Each one produces a clean, empty result that
reads as "nothing to migrate":

- **Rector needs BOTH version knobs.** `withPhpSets()` chooses which rules load;
  `withPhpVersion()` is a separate ceiling taken as `min(it, composer.json require.php,
  PHP_VERSION_ID)`. With `require.php "^8.1"` and `withPhpSets(php84: true)`, every rule
  above 8.1 was skipped without a word. A tool that rewrites source *before* moving pins
  must set `withPhpVersion()`. The generated `rector.php` does.
- **Rector's PHP sets include style rules.** The 8.1 set carries
  `FunctionFirstClassCallableRector`, which rewrote `session_set_save_handler('o','c',…)`
  into first-class callables — inconsistently, and fatally where those functions are not
  defined. Prefer an explicit `withRules([...])` allowlist for BC-break work.
- **A file using removed syntax aborts Rector's whole-set run** with `System error:
  "Class … should be known at this point"` — PHPStan cannot scope a file it cannot parse.
  The curly-offset rule in the catalogue exists to trigger an isolated `--only` pass first.
- **`ruff check --diff` implies `--fix-only`**, so anything unfixable disappears —
  `DTZ003`/`DTZ004` have no fix and vanish entirely. Always run a plain `ruff check` too.
- **OpenRewrite silently no-ops without a build.** Its parser classpath comes from the
  project's compile/test classpath; in a multi-module reactor those point at each module's
  `target/classes`. Never built means empty, type attribution degrades, type-aware recipes
  match nothing, and you get a clean patch and a false all-clear. `mvn -DskipTests install`
  first. Dependency *resolution* is a hard gate; javac success is not required.
- **`go fix` before Go 1.26 is the dormant 2012 version** — it exits 0 having done nothing.
- **OpenRewrite also rewrites your pins** (`maven.compiler.*`, `setup-java`, SDKMAN,
  CircleCI, Dockerfile Java versions). For Java that is the same job as Phase 4. Pick one;
  do not run both unreviewed.

## Phase 4a — WRITE THE SOURCE FIXES

```bash
node $SK/scripts/fix.mjs <lang> <dir> <from> <to> --list     # automatic vs needs-a-human
node $SK/scripts/fix.mjs <lang> <dir> <from> <to>            # dry run, prints diffs
node $SK/scripts/fix.mjs <lang> <dir> <from> <to> --apply    # guard preflight must pass
node $SK/scripts/fix.mjs <lang> <dir> <from> <to> --only a,b # the user's subset
```

`remediate.mjs` moves version pins; **`fix.mjs` rewrites the code itself** — but only where the rewrite is correct for *every* match.

**Autofix is opt-in per rule, hand-written, never inferred from the fix text.** Detecting with a regex does not imply being able to rewrite with one:

| | |
|---|---|
| `Logger.warn(` -> `Logger.warning(` | OK — a pure rename |
| `new Buffer(x)` | NOT safe — `Buffer.from` or `Buffer.alloc` depends on the argument's **type** |
| `crypto.createCipher(a,b)` | NOT safe — `createCipheriv` needs an IV that isn't in the source |
| `Deno.run({cmd:[a,b]})` | NOT safe — `new Deno.Command(a,{args:[b]})` reshapes the object |
| `enumValues<T>()` | NOT safe — `enumEntries` returns a List, not an Array |

**A `behaviour`-class rule never gets an autofix** — the code still runs, it just answers differently. That needs a test, not an edit. A test asserts this invariant.

**`--list` is the user's decision point.** It prints what is automatic, what needs a human, and *why* each one does. `--only` applies a subset.

Rules carry a `scope`: `code` (default — comments and strings blanked first), `strings` (PHP interpolation), or `any` (a Go import path **is** a string literal). Without it, those two rules silently never fired.

## Phase 4b — OPEN A PULL REQUEST (the user picks the tool)

```bash
node $SK/scripts/pr.mjs detect <dir>                      # what can this machine do?
node $SK/scripts/pr.mjs body   <dir> --plan plan.json     # render the description
node $SK/scripts/pr.mjs open   <dir> --tool <t> [--push]  # act
```

| `--tool` | |
|---|---|
| `gh` | GitHub pull request |
| `glab` | GitLab merge request |
| `az` | **Azure DevOps** pull request (`az repos pr create`, supports `--work-items`) |
| `bb` | Bitbucket pull request |
| `tea` | Gitea / Forgejo / Codeberg |
| `push` | push the branch, print the compare URL — **works on any host** |
| `patch` | a `.patch` plus the description; **contacts no remote** |

`detect` reports what is installed, what suits the remote, and how to authenticate each. The remote is classified from its URL — github, gitlab, bitbucket, azure (`dev.azure.com` and `*.visualstudio.com`), gitea — and a **self-hosted forge is reported verbatim rather than guessed at**.

Safety, enforced in code:
- **without `--tool` it refuses** and lists every route
- **without `--push` it is a dry run** — and the dry run works even when the CLI is *not installed*, printing the exact command, the install/auth step, and a web-UI compare URL
- **there is no force-push path**; a test asserts it
- a `suggestion` is always offered and **never null** — there is always some route

## Phase 4c — FILE THE TICKETS (a separate choice)

```bash
node $SK/scripts/issue.mjs detect [dir]
node $SK/scripts/issue.mjs render --plan plan.json --format md|csv|json
node $SK/scripts/issue.mjs create --plan plan.json --tool <t> [--apply]
```

| `--tool` | |
|---|---|
| `jira` | Jira via `jira-cli` |
| `jira-mcp` | Jira via the **Atlassian connector** — no CLI; the assistant calls `createJiraIssue` |
| `az-boards` | **Azure Boards** work items (`az boards work-item create`) |
| `gh-issue` · `glab-issue` · `tea-issue` | GitHub / GitLab / Gitea issues |
| `linear` | Linear CLI |
| `csv` | bulk import — Jira, Azure Boards, Linear and GitHub all accept it |
| `markdown` | one file per ticket; review before anything is filed |

**Code review and issue tracking are separate choices.** Plenty of teams review on GitHub and track in Jira, or ship from Azure Repos into Azure Boards — so the two registries are independent and share no ids.

An epic plus one task per target is generated from the plan, carrying the EOL status, CVE delta, blockers, steps, rollback and risk. Nothing is filed without `--tool` and `--apply`; an uninstalled CLI still prints the command it would run plus the routes that need nothing. On a failure it **stops rather than half-filing**.

## Phase 5 — VERIFY

```bash
node $SK/scripts/verify.mjs node <dir> 24.22.1 --image myimg:tag
```
Runs the gates and exits non-zero on failure. Under `CVE_POLICY=report`, run it the same way but present failures as findings instead of blocking.

Then the parts a script cannot do:
- **Matrix CI on old AND new runtime simultaneously** through the whole migration window. This is what catches a new-version fix breaking the version still in production.
- **Make deprecations loud**: `NODE_OPTIONS="--throw-deprecation --pending-deprecation" npm test` · PHP: `error_reporting(E_ALL)` plus a handler that throws on `E_DEPRECATED` (it is **not** in PHP's default `error_reporting`).
- **Golden/characterization tests** — capture outputs on the old runtime, replay on the new. Catches what no unit test asserts: date/number formatting, sort stability, serialization, hashing, locale.
- **Outbound TLS**: both runtimes periodically tighten hostname/cert validation. Check every connection string.

## Phase 5a — PROVE THE UPGRADED DEPENDENCIES STILL BEHAVE

A runtime bump moves the whole dependency tree with it. The gap nobody closes:

> **A type checker only ever rejects a SHAPE change** — a renamed export, a changed
> signature, a different return type. It cannot reject *the same call returning a different
> answer*: an unstable sort, a timezone rule, a rounding mode, a changed hash, a new default.
> Those compile clean and are wrong at runtime. In Python, Ruby, PHP or plain JS nothing
> checks even the shape.

So after the lockfile moves, the only honest proof is to **run the dependency both ways**.

**Take the before-snapshot BEFORE remediating** — once the lockfile is overwritten it is gone:

```bash
cp package-lock.json /tmp/lock.before          # or composer.lock, Gemfile.lock, poetry.lock…
node $SK/scripts/remediate.mjs node <dir> 24.22.1 --deps latest --apply
node $SK/scripts/depverify.mjs node <dir> --before /tmp/lock.before --top 8
```

`depverify` answers three questions and ranks what to probe:
1. **What actually moved**, across 10 lockfile formats, major-first — transitive moves included.
2. **Where this repo touches it** — real call sites, with comments stripped but *strings kept*
   (an import specifier **is** a string literal).
3. **What would have caught a regression** — the project's real type-checking story, and the
   standing answer that behaviour is caught by nothing, in any language.

A package that moved a major, is used in many files, and is statically unchecked ranks highest.
A transitive move with no direct import is still reported — it still reaches you.

Then probe the top entries. Write the probe from the **real call sites**, never from the
package's README — a probe of an API this repo never calls proves nothing:

```bash
node $SK/scripts/probe.mjs node ms 2.0.0 2.1.3 --probe ./probe.mjs
```

It installs each version into its own scratch dir, runs the same probe against both, and
diffs. Exit 1 means the behaviour changed. Node, Python, PHP and Ruby are supported — the
four where this matters most, because three of them have no type checking at all.

Rules that make a probe worth running:
- **Print one labelled line per call.** The diff is line-level; unlabelled output is unreadable.
- **Print the result, not just "it didn't throw."** A probe that only proves absence of a crash
  is near-worthless and creates false confidence.
- **Keep it deterministic.** Clocks, random seeds, temp paths and unpromised iteration order
  differ between runs and drown the signal. Normalise them *in the probe* — only its author
  knows which of those are the thing being tested.
- **Never report "identical" for a probe that did not run on both versions.** `could-not-run`
  and `inconclusive` are real answers; a silent probe matches itself exactly and is downgraded
  out of `identical` automatically.
- Identical output proves only that *the calls the probe made* still answer the same.

For compiled languages there is no runner: use the repo's own build and test suite — but say
plainly that a clean build checks shape only. A behaviour change passes it.

To do this across many packages with agents writing the probes, run the companion workflow
`dep-behaviour-check`, which probes each package and has a second agent adversarially judge
whether the probe would actually have caught a regression.

## Rollout

Canary 1–5% → soak 15–30 min → 5/10/25/100%, watching error rate, p95, **and memory** (a new V8/Zend generation changes the allocation profile — a top cause of post-upgrade OOMKills). Keep the previous image tag ≥14 days. Revert the lockfile **with** the runtime.

## Output

Default to a written report with: discovery table (incl. drift), EOL/CVE delta, blocker list split into real-vs-noise, the phased plan, and verification gates. If the user wants tickets, one per repo with an epic above — never one per workspace package.

## Before you start — check the machine

```bash
node $SK/scripts/doctor.mjs
```
Reports Node version, platform, which tools are present, **what degrades without each one**, whether the data sources are reachable, and whether `NVD_API_KEY` is set. Run it first when anything behaves oddly.

## Notes

- **All scripts are zero-dependency Node.** No `jq`, `python3`, `find`, `mapfile`, or `paste` — they run unchanged on macOS, Linux and WSL. Node 18+ preferred; older falls back to the `https` module.
- `composer`, `rector`, `phpstan`, `phpcs` may be absent. Bootstrap before the PHP path; see `references/php.md`.
- HTTP is cached 24h under `$TMPDIR/runtime-upgrade-cache`. `RU_OFFLINE=1` serves cache only and never calls out.
- `lib/semver.mjs` is verified against npm `semver` on the full CVE database — identical results.
- `npm audit` and `pnpm audit` **exit non-zero when advisories exist**. `lib/sh.mjs` captures output regardless of exit status; never wrap them in `cmd || echo '{}'`.
- **Adding a language** means adding one module under `scripts/adapters/`. The EOL layer (endoflife.date, 485 products) and dependency-CVE layer (OSV.dev, 10+ ecosystems) are already shared — the per-language cost is discovery paths, the native/ABI model, and the codemod tool.

## Environment

| Var | Effect |
|---|---|
| `RU_OFFLINE=1` | cache only, no network |
| `RU_CACHE=<dir>` | override the cache location |
| `RU_ENGINES=1` | enable the direct-dependency floor pre-flight (network-bound) |
| `RU_NVD=1` | enable the PHP NVD CPE lookup (advisory only) |
| `NVD_API_KEY` | raises NVD from 5 to 50 requests per 30s |
| `RU_JAVA_DISTRO` | which JDK distribution to resolve EOL against (default `amazon-corretto`) — **set this or Java EOL dates will be wrong** |

## Languages

Full adapters (discovery · EOL · dependency advisories · pin rewriting · dependency upgrade):
**Node.js · PHP · Go · Python · Ruby · Rust · Java · .NET · Deno · Bun · Elixir · Erlang/OTP · Kotlin · Scala · Perl**

Beyond those, `research.mjs <product> <version>` works for **any of the 485 products endoflife.date tracks** — PostgreSQL, Redis, nginx, Kubernetes, Terraform, Ubuntu and so on. You get EOL windows and a target recommendation; you do not get discovery, CVE gating or remediation. The output sets `generic: true` and says so. An unknown product fails cleanly rather than inventing a date.
