# How it works, and how to use it

A practical walkthrough. For the pitch and the comparison tables, see the [README](../README.md).

---

## The idea in one paragraph

Upgrading a runtime is three separate jobs that most tools conflate. **Deciding** what to
move to — which needs EOL dates and CVE counts, not a version number someone picked.
**Doing** it — moving pins, rewriting source, upgrading dependencies. **Proving** it —
showing the code still behaves the same. This skill owns the decision and the proof,
delegates the mechanical source rewriting to engines that already do it better, and never
pretends a thing is verified when it isn't.

---

## Install

```bash
/plugin marketplace add aasisdhakal/claude-runtime-upgrade
/plugin install runtime-upgrade@runtime-upgrade
```

Then just say what you want:

> upgrade this repo to the current Node LTS
> what runtime is this project on and how exposed are we?
> plan a PHP 8.1 → 8.4 upgrade across these five repos

Requires **node, git and curl**. Nothing else is mandatory — run `doctor.mjs` to see what
each missing tool would add.

---

## Two questions it asks before doing anything

It will not guess on either.

**1. CVE policy — gate or report?**
`gate` stops the upgrade when unpatched high/critical CVEs remain at the target.
`report` surfaces them and lets you decide. Only **Node and Go** can gate honestly; the
others have no version-ranged CVE database for the runtime itself, and the skill says so
rather than inventing a number.

**2. Plan or write?**
`plan` produces the report and the diffs, touching nothing.
`write` actually edits files — and only ever on a `runtime/*` branch, through a guard that
refuses to commit secrets, refuses protected branches, and never pushes.

---

## The flow

```
detect → research → assess → scan → plan → remediate → fix → verify → depverify → probe
  │         │         │       │       │        │        │       │          │
shape     EOL/CVE   blockers  code   the     pins +   source  gates   what moved,
drift     target    native    rules  plan    deps     fixes            and does it
                     ABI                                               still behave
```

### 1. Discover — `detect.mjs`

```bash
node skills/runtime-upgrade/scripts/detect.mjs ./repo --json
```

Finds every runtime target and classifies the repo: `single`, `monorepo`, `multi-package`,
`polyrepo`, `mixed-single`, `container-only`, `no-manifest`.

Two fields worth reading before you trust any count:

- **`discoveryGaps`** — what the walk could *not* see: a file cap hit, directories below the
  depth limit, directories skipped by an ambiguous name (`build`, `out`, `target`). Absent
  means the walk was complete. Present means your target list is a floor, not a total.
- **`platformPublishStubs`** — packages shipping one prebuilt binary and nothing else. They
  are reported and never planned; there is no source in them to upgrade.

### 2. Research — `research.mjs`

```bash
node skills/runtime-upgrade/scripts/research.mjs node 20.11.1
node skills/runtime-upgrade/scripts/research.mjs php 8.1 8.4
```

EOL and support windows from endoflife.date, plus real CVE counts at current *and* target.
It **refuses a version that does not exist** rather than reporting it as healthy, and it
prefers **LTS over newest** wherever a product has an LTS concept.

### 3. Assess — `assess.mjs`

Dependency advisories, native-addon classification, dependency floors.

The important field is **`nativeEnumerated`**. An empty `nativeBlockers` list means one of
two very different things, and this tells you which: *nothing was found*, or *nothing was
checked*. With `node_modules` absent, nothing was checked.

### 4. Scan — `scan.mjs`

```bash
node skills/runtime-upgrade/scripts/scan.mjs node ./repo 20 24
```

60 rules across 14 languages, matched against **code only** — comments and strings are
blanked first, so prose mentioning a removed API is not a finding.

Three severities, and the distinction matters:

| | meaning | what to do |
|---|---|---|
| `removed` | it will fail | fix before you ship |
| `runtime` | it will warn | fix soon, make deprecations loud in tests |
| `behaviour` | **it will silently answer differently** | write a test; never autofix |

### 5. Plan — `plan.mjs`

```bash
node skills/runtime-upgrade/scripts/plan.mjs ./repo --json
```

Synthesises everything into ordered steps with machine-checkable exit conditions, a pilot
target, risk signals and an estimate. On a monorepo it emits **one plan per distinct
upgrade**, not one per package — 214 symfony packages making the same move is one decision.

### 6. Remediate — `remediate.mjs`

```bash
node skills/runtime-upgrade/scripts/remediate.mjs node ./repo 24.22.1 --deps minor
node skills/runtime-upgrade/scripts/remediate.mjs node ./repo 24.22.1 --deps minor --apply
```

Moves pins, CI and build config, and upgrades dependency packages. Dry run by default.

**It refuses rather than wrecking.** Before any bulk dependency upgrade it checks for
conditions that make one unsafe — a vendored Go tree, replace-pinned modules, a `go.work`
workspace, Yarn Berry driven with Yarn 1 commands — and names each one. `--force-deps` is
the opt-out; read every blocker first.

### 7. Fix the source — delegate first

```bash
node skills/runtime-upgrade/scripts/fix.mjs php ./repo 8.1 8.4 --list
```

Every run includes a **`delegate`** block naming the engine that already does this job:

| Language | Engine | What it leaves you |
|---|---|---|
| PHP | Rector | pins, CI, composer resolution, 5 deprecations it has no rule for |
| Python | Ruff `UP` | every stdlib **removal** — Ruff's whitelist is 8 modules |
| Java | OpenRewrite | `sun.misc.Unsafe`, Java 24 — and **it also rewrites pins** |
| Go | `go fix` (≥1.26) | `ioutil.ReadDir`/`Discard`, `maps.Keys`/`Values`, `rand.Seed` |
| Node | nodejs/userland-migrations | everything past Node 24 |
| Scala, Elixir, Deno | compiler / formatter / linter | see `doctor.mjs` |

Ruby, Rust, .NET, Erlang, Kotlin and Perl have **no credible rewriter** — `doctor.mjs`
carries the evidence. There the built-in rules are the only coverage.

**Run the engine first, then re-run `fix.mjs`** — the rules here are what it leaves behind.
Nothing is ever installed for you; an absent engine still yields the exact config and command.

### 8. Verify — `verify.mjs`

```bash
node skills/runtime-upgrade/scripts/verify.mjs node ./repo 24.22.1
```

Gates that exit non-zero. It judges **pins and floors differently**: a floor *below* the
target is satisfied, not a gap. Raising a consumer-facing floor is semver-breaking, so
leaving it alone is correct — and the gate says so instead of failing the library forever.

### 9. Prove the dependencies still behave — `depverify.mjs` + `probe.mjs`

This is the part nothing else does.

> A type checker only ever rejects a **shape** change. It cannot reject the same call
> returning a **different answer** — an unstable sort, a timezone rule, a changed default.
> In Python, Ruby, PHP or plain JS nothing checks even the shape.

**Take the before-snapshot BEFORE remediating**, or it's gone:

```bash
cp package-lock.json /tmp/lock.before
node skills/runtime-upgrade/scripts/remediate.mjs node ./repo 24.22.1 --deps latest --apply
node skills/runtime-upgrade/scripts/depverify.mjs node ./repo --before /tmp/lock.before
```

`depverify` reads 10 lockfile formats, finds where your code touches what moved, and ranks
what to probe by blast radius × static blindness.

Then write a probe **from your real call sites** and run it both ways:

```bash
node skills/runtime-upgrade/scripts/probe.mjs node path-to-regexp 3.3.0 8.4.2 --probe ./probe.mjs
```

It installs each version into its own scratch directory, runs the same probe against both,
and diffs. **Exit 1 means the behaviour changed.** Node, Python, PHP and Ruby.

**Writing a probe that is worth running:**

- Print **one labelled line per call** — the diff is line-level.
- Print the **result**, not "it didn't throw". A probe proving only the absence of a crash
  creates false confidence.
- Catch exceptions and print them as a result, so a throw-vs-return change shows as a diff.
- Keep it deterministic. Normalise clocks, randomness and unpromised ordering *in the probe*.

Four outcomes, and they are not interchangeable:

| | meaning |
|---|---|
| `changed` | the same calls answer differently — exit 1 |
| `identical` | only for the calls the probe made; it says nothing about the rest |
| `inconclusive` | the probe printed nothing. It proves nothing — rewrite it |
| `could-not-run` | install or execution failed. Nothing was proven either way |

---

## A real example

`path-to-regexp` 3.3.0 → 8.4.2 in the NestJS repo, probe written from its actual call sites:

```
route /users/:id?    3.3.0: matches [/users, /users/7]
                     8.4.2: THREW TypeError: Unexpected ?

route /users/{*path} 3.3.0: matches []
                     8.4.2: matches [/users/7, /users/a/b]
```

The first is a hard failure — but routes are strings, so **no type checker sees it**. The
second is worse: no error, no type change, just different URLs matching. NestJS calls
`pathToRegexp` in `cross-origin-protection.ts`, so that is a security check silently
widening.

---

## Write mode is enforced, not requested

`--apply` anywhere goes through `guard.mjs`:

- refuses protected branches; work happens on `runtime/*`
- scans the staged diff for secrets and refuses the commit
- refuses a manifest change whose lockfile did not move with it
- **never pushes.** Publishing a branch is a human action

---

## Many repos at once

```
/runtime-upgrade root=~/code cvePolicy=gate mode=plan
```

Runs the full chain per repo in parallel, with an adversarial verification pass.

---

## When something looks wrong

```bash
node skills/runtime-upgrade/scripts/doctor.mjs
```

Reports what this machine can do, what each missing tool would add, which rewrite engines
are usable here — and whether one is present but **too old to work** (`go fix` before Go
1.26 exits 0 having done nothing).

Set `RU_OFFLINE=1` to work from cache only. Cache lives in `$TMPDIR/runtime-upgrade-cache`,
24h TTL, override with `RU_CACHE`.

---

## What leaves your machine

Public version metadata only: endoflife.date, the Node security working group's CVE
database, OSV.dev, and your package manager's own audit endpoint.

**Your source code is never uploaded.** Scanning, matching and rewriting all happen locally.
The one exception is `probe.mjs`, which downloads the *dependency* from its registry to run
it — never your code.
