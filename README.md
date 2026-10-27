# runtime-upgrade

Takes a repo of unknown shape from *"what runtime are we even on?"* to a verified upgrade —
with real EOL dates, real CVE counts, a blocker list that separates genuine problems from
noise, and a way to prove the dependencies still behave afterwards.

**15 languages** with full adapters. Any of the **485 products endoflife.date tracks** for research.

## Install

```bash
/plugin marketplace add aasisdhakal/claude-runtime-upgrade
/plugin install runtime-upgrade@runtime-upgrade
```

Needs **node, git and curl**. Nothing else is mandatory — `doctor.mjs` tells you what each
missing tool would add. No npm install, no dependencies.

## Start here

Just say what you want:

> upgrade this repo to the current Node LTS
>
> what runtime is this project on, and how exposed are we?
>
> plan a PHP 8.1 → 8.4 upgrade across these five repos

Or drive the scripts yourself — every one prints JSON on stdout:

```bash
node skills/runtime-upgrade/scripts/doctor.mjs
node skills/runtime-upgrade/scripts/detect.mjs  /path/to/repo
node skills/runtime-upgrade/scripts/plan.mjs    /path/to/repo --json
```

## What it actually does

Upgrading a runtime is three jobs that most tools roll into one. **Deciding** what to move
to — which needs EOL dates and CVE counts, not a version somebody picked. **Doing** it —
pins, source, dependencies. **Proving** it — showing the code still behaves the same.

This owns the decision and the proof. It delegates the mechanical source rewriting to
engines that already do it better. And it never reports a thing as verified when it isn't.

## This is not another Dependabot

Renovate and Dependabot own **dependency bumps** and do them well. This owns the decision
above them:

| | Renovate / Dependabot | runtime-upgrade |
|---|---|---|
| Bump a dependency, open the PR | ✅ | not its job |
| Tell you *which runtime version to move to, and why* | ✗ | ✅ |
| Count unpatched runtime CVEs at current **and** target | ✗ | ✅ |
| Say which native addon actually blocks the upgrade | ✗ | ✅ |
| Know a floor is a support contract, not a pin | ✗ | ✅ |
| Prove a dependency still behaves after the bump | ✗ | ✅ |

Use both. This produces the plan; they execute the bumps.

## The path

```
detect → research → assess → scan → plan → remediate → fix → verify → prove
```

| Stage | Script | What you get |
|---|---|---|
| **Discover** | `detect.mjs` | repo shape, every runtime target, version drift as a defect |
| **Research** | `research.mjs` | EOL and support windows, CVE counts at current *and* target |
| **Assess** | `assess.mjs` | dependency advisories, native/ABI blockers, dependency floors |
| **Scan** | `scan.mjs` | 60 rules across 14 languages, matched on code only, with file:line |
| **Plan** | `plan.mjs` | ordered steps, each with a machine-checkable exit condition |
| **Remediate** | `remediate.mjs` | rewrites pins, CI and build config; upgrades dependency packages |
| **Fix** | `fix.mjs` | source changes — delegating to Rector, Ruff, OpenRewrite, `go fix` |
| **Verify** | `verify.mjs` | gates that exit non-zero |
| **Prove** | `depverify.mjs` + `probe.mjs` | runs each changed dependency **both ways** and diffs the behaviour |

Two fields worth reading before you trust any count:

- **`discoveryGaps`** — what the walk could *not* see: a file cap hit, directories below the
  depth limit, directories skipped by an ambiguous name (`build`, `out`, `target`). Absent
  means complete. Present means your target list is a floor, not a total.
- **`nativeEnumerated`** — an empty blocker list means *nothing found* or *nothing checked*.
  This tells you which. With `node_modules` absent, nothing was checked.

## It asks you two things first

It will not guess on either.

**CVE policy — gate or report?** `gate` stops when unpatched high/critical CVEs remain at the
target. `report` surfaces them and lets you decide.

**Plan or write?** `plan` produces the report and diffs, touching nothing. `write` edits
files — only on a `runtime/*` branch, through a guard that refuses secrets and never pushes.

## How it proves the result

> A type checker only ever rejects a **shape** change. It cannot reject the same call
> returning a **different answer** — an unstable sort, a timezone rule, a changed default.
> In Python, Ruby, PHP or plain JS, nothing checks even the shape.

So after the lockfile moves, `probe.mjs` runs the dependency at the **old** and the **new**
version and diffs the output. Take the snapshot *before* remediating, or it's gone:

```bash
cp package-lock.json /tmp/lock.before
node skills/runtime-upgrade/scripts/remediate.mjs node ./repo 24.22.1 --deps latest --apply
node skills/runtime-upgrade/scripts/depverify.mjs node ./repo --before /tmp/lock.before
node skills/runtime-upgrade/scripts/probe.mjs node path-to-regexp 3.3.0 8.4.2 --probe ./probe.mjs
```

`depverify` reads 10 lockfile formats, finds where your code touches what moved, and ranks
what to probe by blast radius × static blindness. `probe.mjs` installs each version into its
own scratch directory and diffs. **Exit 1 means the behaviour changed.** Node, Python, PHP, Ruby.

A real finding — `path-to-regexp` 3.3.0 → 8.4.2 in NestJS, probed from its own call sites:

```
route /users/:id?     3.3.0: matches [/users, /users/7]
                      8.4.2: THREW TypeError: Unexpected ?

route /users/{*path}  3.3.0: matches []
                      8.4.2: matches [/users/7, /users/a/b]
```

The first is a hard failure, and routes are strings so no type checker sees it. The second is
worse — no error, no type change, just different URLs matching. NestJS calls `pathToRegexp`
in `cross-origin-protection.ts`, so that is a security check silently widening.

**Writing a probe worth running:** print one labelled line per call; print the **result**, not
"it didn't throw"; catch exceptions and print them as results; keep it deterministic.

Four outcomes, and they are not interchangeable:

| | meaning |
|---|---|
| `changed` | the same calls answer differently — exit 1 |
| `identical` | only for the calls the probe made. It says nothing about the rest |
| `inconclusive` | the probe printed nothing. It proves nothing — rewrite it |
| `could-not-run` | install or execution failed. Nothing was proven either way |

## Source fixes: it delegates, then fills the gaps

**It does not reimplement Rector.** For six languages a maintained engine rewrites source
far better than a regex catalogue could, so the built-in rules deliberately exclude
everything they already cover:

| Language | Engine | What it leaves you |
|---|---|---|
| PHP | **Rector** | pins, CI, composer resolution, 5 deprecations it has no rule for |
| Python | **Ruff `UP`** | every stdlib **removal** — Ruff's import whitelist is 8 modules |
| Java | **OpenRewrite** | `sun.misc.Unsafe`, Java 24 — and it rewrites pins too, so pick one |
| Go | **`go fix`** (≥1.26) | `ioutil.ReadDir`/`Discard`, `maps.Keys`/`Values`, `rand.Seed` |
| Node | **nodejs/userland-migrations** | everything past Node 24 |
| Scala, Elixir, Deno | compiler / formatter / linter | see `doctor.mjs` |

Ruby, Rust, .NET, Erlang, Kotlin and Perl have **no credible rewriter** — `doctor.mjs` carries
the evidence for each. There the built-in rules are the only coverage.

**Nothing is ever installed for you.** An absent engine still yields the exact config and
command. Run the engine first, then re-run `fix.mjs` for what it leaves behind.

**Autofix is opt-in per rule, never inferred.** `new Buffer(x)` could be `Buffer.from` or
`Buffer.alloc` depending on the argument's *type*. Those are listed as **needs-a-human, with
the reason**. A `behaviour`-class rule never gets an autofix — it needs a test, not an edit.

## Repo shapes

All seven are detected and handled differently:

`single` · `monorepo` (sibling packages in **any** ecosystem, not just JS workspaces) ·
`multi-package` (packages under a root that pins nothing) · `polyrepo` (a directory of repos) ·
`mixed-single` (Node **and** PHP in one repo) · `container-only` (pinned only in a Dockerfile) ·
`no-manifest` (reported, then it stops)

On a monorepo it emits **one plan per distinct upgrade**, not one per package. 214 symfony
packages making the same move is one decision, not 214.

## Language support

| Language | Dependency auditor | Runtime CVE source | Hard gate | Metric |
|---|---|---|---|---|
| **Node.js** | npm/pnpm/yarn audit | `nodejs/security-wg` — curated, severity-rated | ✅ | high/critical |
| **Go** | `govulncheck` | OSV `stdlib` — version-ranged, **no severity** | ✅ | **total** |
| **PHP** | `composer audit` | NVD CPE only | ✗ | — |
| **Python** | `pip-audit` | none unified | ✗ | — |
| **Ruby** | `bundler-audit` | none unified | ✗ | — |
| **Rust** | `cargo audit` | none (RustSec covers crates) | ✗ | — |
| **Java** | OWASP dep-check | per-JDK-distribution | ✗ | — |
| **.NET** | `dotnet list package --vulnerable` | Microsoft SUG | ✗ | — |
| **Deno** · **Bun** | `deno outdated` · `bun outdated` | none unified | ✗ | — |
| **Elixir** · **Erlang** | `mix hex.outdated` · `rebar3` | none unified | ✗ | — |
| **Kotlin** · **Scala** | Gradle/sbt update plugins | none unified | ✗ | — |
| **Perl** | `carton` | none unified | ✗ | — |

All 15 share the EOL layer (endoflife.date) and the dependency-CVE layer (OSV.dev, 10+ ecosystems).

**The asymmetry is surfaced, never hidden.** Only Node and Go have a curated, version-ranged
runtime CVE database, and Go's carries **no severity at all** — 0 of 82 records at go1.22 — so
Go gates on *total* while Node gates on high/critical. Every non-gating adapter must explain
why in `gateNote`, and a test enforces it.

**Beyond these 15:** `research.mjs <product> <version>` works for any endoflife.date product —
PostgreSQL, Redis, nginx, Kubernetes, Terraform, Ubuntu. You get EOL windows and a target, not
discovery or remediation. Output sets `generic: true` and says so.

**Java note:** endoflife.date has no `java` product — the JDK is tracked per distribution. Set
`RU_JAVA_DISTRO` (`amazon-corretto`, `oracle-jdk`, `graalvm-ce`, …) or the dates will be wrong.

## Framework EOL

```bash
node skills/runtime-upgrade/scripts/frameworks.mjs <dir>
```

The runtime is often the smaller half. endoflife.date tracks 41 frameworks; anything it
doesn't (NestJS, FastAPI, Flask, Quarkus, Ember, Tailwind) is reported as `untracked` rather
than guessed at.

## Pull requests and tickets — your tools, your call

PRs through **gh, glab, az, tea, bb**, or a plain branch push, or a patch file.
Tickets into **Jira (REST or MCP), Azure Boards, GitHub Issues, GitLab, Linear, Gitea**, or
CSV / Markdown. It detects what you have, suggests one, and never picks for you.

## Safety

`guard.mjs` is what makes the write mode trustworthy:

```bash
node skills/runtime-upgrade/scripts/guard.mjs preflight <dir>
node skills/runtime-upgrade/scripts/guard.mjs commit    <dir> -m "msg" --phase runtime
```

Refuses to commit on a protected branch, refuses any branch outside `runtime/*`, refuses a
dirty tree, refuses a manifest change whose lockfile didn't move with it, and scans the staged
diff for private keys and AWS/GitHub/Slack tokens. **There is no push, force, or remote code
path in the file** — a test asserts it.

It also refuses rather than wrecking: before any bulk dependency upgrade it checks for
conditions that make one unsafe — a vendored Go tree, replace-pinned modules, a `go.work`
workspace, Yarn Berry driven with Yarn 1 commands — and names each. `--force-deps` is the
opt-out. Read every blocker first.

## Words you will see

**Pin** — what *this checkout* runs: `.nvmrc`, a Dockerfile tag, `.tool-versions`, `toolchain`.
Moving it affects only this repo.

**Floor** — the *minimum a consumer needs*: `engines.node`, `require.php`, `requires-python`,
`rust-version`, the `go` directive. For a published library this is a support contract, and
raising it is a semver-breaking change. It is declined by default; `--raise-floor` is explicit.

**Drift** — two *pins* disagreeing. Floors differing across packages is not drift.

The three severities, and why they differ:

| | meaning | what to do |
|---|---|---|
| `removed` | it will fail | fix before you ship |
| `runtime` | it will warn | fix soon; make deprecations loud in tests |
| `behaviour` | **it silently answers differently** | write a test. Never autofix |

## Set it up so it runs smoothly

```bash
node skills/runtime-upgrade/scripts/doctor.mjs
```

Reports what this machine can do, what each missing tool would add, which rewrite engines are
usable — and whether one is present but **too old to work** (`go fix` before Go 1.26 exits 0
having done nothing).

| Var | Effect |
|---|---|
| `RU_OFFLINE=1` | cache only, **no network calls at all** |
| `RU_CACHE=<dir>` | cache location (default: `$TMPDIR/runtime-upgrade-cache`, 24h TTL) |
| `RU_ENGINES=1` | direct-dependency floor pre-flight (network-bound, slow) |
| `RU_NVD=1` | PHP NVD CPE lookup (advisory only) |
| `NVD_API_KEY` | raises NVD from 5 to 50 requests/30s ([free key](https://nvd.nist.gov/developers/request-an-api-key)) |
| `RU_JAVA_DISTRO` | which JDK distribution to read EOL dates from |

## What leaves your machine

Public version metadata only: endoflife.date, the Node security working group's CVE database,
OSV.dev, and your own package manager's audit endpoint.

**Your source code is never uploaded.** Scanning, matching and rewriting all happen locally.
The one exception is `probe.mjs`, which downloads the *dependency* from its registry in order
to run it — never your code.

## What it has been tried on

Every language is exercised end to end — detect → plan → write → commit — against a real
open-source project, not a fixture:

| | | | |
|---|---|---|---|
| chalk · slugify (Node) | Carbon (PHP) | gorilla/mux (Go) | click (Python) |
| sinatra (Ruby) | ripgrep (Rust) | gson (Java) | serilog (.NET) |
| oak (Deno) | elysia (Bun) | plug (Elixir) | cowboy (Erlang) |
| okio (Kotlin) | cats (Scala) | mojo (Perl) | |

**16/16 produce a correct, committed runtime-pin change.**

Separately, the full chain has been run against twelve large repositories — next.js,
kubernetes, grafana, symfony, laravel, roslyn, spring-boot, rails, django, home-assistant,
tokio, nest (203k files) — with adversarial judges reviewing the output. That sweep found
roughly sixty defects, each now a named regression test: floors rewritten as pins, an autofix
that corrupted five Laravel files while still passing `php -l`, a Go `--apply` that left
kubernetes unbuildable while reporting success, and a CVE gate that had never once executed.

## Good to know

- **A clean build is not a behaviour check.** For compiled languages the build catches shape
  changes only. The probe exists because nothing catches the rest.
- **`identical` means only what the probe covered.** It is not a clean bill of health for a
  dependency, just for the calls you exercised.
- **Raising a floor is a breaking change for your consumers.** The tool declines by default
  and makes you ask twice. That is deliberate, not an oversight.
- **Only Node and Go can gate on CVEs honestly.** Everything else reports. Treating a missing
  database as "zero vulnerabilities" would be the worst possible failure mode.
- **Walk caps are real.** On the largest repos `discoveryGaps` will be populated. Read it.

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| "nothing to migrate", suspiciously clean | the engine silently no-opped | Rector needs **both** `withPhpSets()` and `withPhpVersion()`; OpenRewrite needs the project built first (`mvn -DskipTests install`) |
| `go fix` reports success, changes nothing | Go older than 1.26 | `doctor.mjs` flags this. Before 1.26 `go fix` is the dormant 2012 version |
| A Ruff run looks clean but you expected findings | `--diff` implies `--fix-only` | run a plain `ruff check` too — `DTZ003` has no fix and is hidden by `--diff` |
| Fewer targets than you expected on a big repo | a walk cap was hit | read `discoveryGaps` — it names the depth-capped and ambiguously-named directories |
| `nativeBlockers: []` on a Node repo | `node_modules` absent | check `nativeEnumerated`. `false` means nothing was inspected, not that nothing was found |
| verify fails forever on a library | you are reading a floor as a pin | a floor *below* the target is satisfied. Raising it is semver-breaking — that refusal is deliberate |
| A dependency upgrade is refused | vendored tree, replace-pins, `go.work`, Yarn Berry | read `dependencies.blockers`; `--force-deps` overrides, once you have |
| EOL dates look wrong for Java | no `java` product on endoflife.date | set `RU_JAVA_DISTRO` to your JDK distribution |
| Network calls you did not want | — | `RU_OFFLINE=1` uses cache only, with no network calls at all |

## Tests

```bash
node skills/runtime-upgrade/tests/run.mjs
node skills/runtime-upgrade/tests/run.mjs --filter abi
```

339 tests. Fixtures are generated into a temp dir — the polyrepo case needs real `.git`
directories, which git itself won't track, and generated fixtures can't drift from their
assertions.

CI runs on **ubuntu + macOS × Node 18/20/22/24**, plus an offline job and a weekly cron to
catch upstream feed changes.

The semver matcher is **differential-tested against npm `semver`** on 143 real `engines` ranges
harvested from 1162 `package.json` files, plus 40,000 generated fuzz comparisons — 100%
agreement on both. Those tests skip cleanly when `semver` is absent, so the zero-dependency
guarantee holds.

## Contributing a language

The expensive layers are shared, so a new adapter is one file in `scripts/adapters/`:

```js
export const id = 'go';
export const label = 'Go';
export const manifests = ['go.mod'];
export const eolProduct = 'go';          // endoflife.date key
export const osvEcosystem = 'Go';        // OSV ecosystem
export const gateCapable = false;        // no curated runtime CVE DB? say so
export const gateNote = 'why not…';
export function scan({ dir, root, dockerImages, ciText }) { /* … */ }
```

Register it in `adapters/index.mjs`, add a fixture, add assertions. See
[CONTRIBUTING.md](CONTRIBUTING.md).

## License

MIT. Data from [endoflife.date](https://endoflife.date) (MIT),
[nodejs/security-wg](https://github.com/nodejs/security-wg), [OSV.dev](https://osv.dev) and
[NVD](https://nvd.nist.gov).
