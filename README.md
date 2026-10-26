# runtime-upgrade

A Claude Code skill that takes a repo of unknown shape from *"what runtime are we even on?"* to a verified upgrade plan — with EOL dates, real CVE counts, and a blocker list that separates genuine problems from noise.

Supports **15 languages** with full adapters, and researches **any of the 485 products endoflife.date tracks**.

```bash
/plugin marketplace add OWNER/claude-runtime-upgrade
/plugin install runtime-upgrade@runtime-upgrade
```

## This is not another Dependabot

Renovate and Dependabot own **dependency bumps** and do it well. This owns the **decision above them** — the one they explicitly don't make:

| | Renovate / Dependabot | runtime-upgrade |
|---|---|---|
| Bump a dependency | ✅ | ✗ (not its job) |
| Open the PR | ✅ | ✗ |
| Split a combined Docker tag (`7.4-fpm-node14`) | ✗ documented limitation | ✅ |
| Read `docker-compose` | ✗ (Dependabot) | ✅ |
| Notice a digest-pinned base image stopped getting patches | ✗ | ✅ |
| Tell you *which runtime version to move to and why* | ✗ | ✅ |
| Count unpatched runtime CVEs at current vs target | ✗ | ✅ |
| Say which native addon actually blocks the upgrade | ✗ | ✅ |
| Answer "every version is vulnerable, now what" | ✗ | ✅ |

Use both. This one produces the plan; they execute the bumps.

## One command

```bash
node skills/runtime-upgrade/scripts/plan.mjs ./repo --target 24.22.1 --format md
```

Runs every read-only phase and emits the whole plan: EOL and CVE delta, dependency advisories, framework EOL, a source scan with `file:line` for removed APIs and **silent behaviour changes**, blockers separated from N-API noise, pre-existing debt, **ordered steps each with a why and an exit condition**, test strategy, rollback trigger and procedure, risk signals, an estimate — and across several repos, which one is the pilot and why.

Every command it prints is runnable verbatim.

## What it does

Six phases, each with a machine-checkable exit condition.

| Phase | Script | Output |
|---|---|---|
| **Discover** | `detect.mjs` | repo shape, every runtime target, **version drift as a defect** |
| **Research** | `research.mjs` | EOL/support windows, unpatched runtime CVEs at current *and* target |
| **Assess** | `assess.mjs` | dependency advisories, native/ABI blockers, dependency floors |
| **Remediate** | `remediate.mjs` | **rewrites every runtime pin AND upgrades all dependency packages** |
| **Scan** | `scan.mjs` | **68 rules, all 15 languages** — removed APIs, deprecations and **behaviour changes**, with file:line |
| **Verify** | `verify.mjs` | gates that exit non-zero on failure |

All synthesised by **`plan.mjs`**.

Plus `frameworks.mjs` (framework EOL), `guard.mjs` (enforced write mode) and `doctor.mjs`.

### Remediation actually upgrades things

```bash
node skills/runtime-upgrade/scripts/remediate.mjs node ./repo 24.22.1 --deps latest --apply
```
Rewrites `engines`, `.nvmrc`, `.tool-versions`, every Dockerfile `FROM` (preserving the variant suffix — `20.11.1-alpine3.19` becomes `24.22.1-alpine3.22`), then upgrades dependency packages with that ecosystem's own tool and regenerates the lockfile.

- **Dry-run by default** — emits unified diffs, writes nothing
- **`--deps minor`** stays inside declared ranges; it will *not* move an exact pin like `"ms": "2.1.2"`
- **`--deps latest`** crosses majors and rewrites the manifest ranges themselves
- **`--apply` runs guard preflight first and refuses if it fails** — changes cannot land on a protected branch

Plus `doctor.mjs` — tells you what's installed and **what degrades without each tool**.

### Two choices it always puts to you

1. **CVE policy** — `gate` (high/critical CVEs block) or `report` (surface, don't block)
2. **Action mode** — `plan` (read-only, emits diffs) or `write` (branch and commit)

Neither is assumed. Both thread into every agent prompt.

## Repo shapes

All six are detected and handled differently:

`single` · `monorepo` (workspaces) · `polyrepo` (a directory of repos) · `mixed-single` (Node **and** PHP in one repo, e.g. Laravel + Vite) · `container-only` (runtime pinned only in a Dockerfile) · `no-manifest` (reported, then it stops)

## Language support

| Language | Dependency auditor | Runtime CVE source | Hard gate | Metric |
|---|---|---|---|---|
| **Node.js** | npm/pnpm/yarn audit | `nodejs/security-wg` — curated, severity-rated | ✅ | high/critical |
| **Go** | `govulncheck` | OSV `stdlib` — version-ranged, **no severity** | ✅ | **total** |
| **PHP** | `composer audit` | NVD CPE only | ❌ | — |
| **Python** | `pip-audit` | none unified | ❌ | — |
| **Ruby** | `bundler-audit` | none unified | ❌ | — |
| **Rust** | `cargo audit` | none (RustSec covers crates) | ❌ | — |
| **Java** | OWASP dep-check | per-JDK-distribution | ❌ | — |
| **.NET** | `dotnet list package --vulnerable` | Microsoft SUG | ❌ | — |
| **Deno** · **Bun** | `deno outdated` · `bun outdated` | none unified | ❌ | — |
| **Elixir** · **Erlang** | `mix hex.outdated` · `rebar3` | none unified | ❌ | — |
| **Kotlin** · **Scala** | Gradle/sbt update plugins | none unified | ❌ | — |
| **Perl** | `carton` | none unified | ❌ | — |

**Beyond these 15:** `research.mjs <product> <version>` works for any endoflife.date product — PostgreSQL, Redis, nginx, Kubernetes, Terraform, Ubuntu. You get EOL windows and a target; not discovery, gating or remediation. Output sets `generic: true` and says so.

All eight share the EOL layer (endoflife.date, 485 products) and the dependency-CVE layer (OSV.dev, 10+ ecosystems).

**The asymmetry is surfaced, never hidden.** Only Node and Go have a curated, version-ranged runtime CVE database. Go's carries **no severity at all** — 0 of 82 records at go1.22 — so Go gates on *total* unpatched stdlib advisories while Node gates on high/critical. `research.mjs` returns `gateCapable` and `gateMetric` per language, every non-gating adapter must explain why in `gateNote`, and there is a test enforcing it.

**Java note:** endoflife.date has no `java` product — the JDK is tracked per distribution. Set `RU_JAVA_DISTRO` (`amazon-corretto`, `oracle-jdk`, `graalvm-ce`, …) or the EOL dates will be wrong.

## Framework EOL

```bash
node skills/runtime-upgrade/scripts/frameworks.mjs <dir>
```
The runtime is often the smaller half. endoflife.date tracks 41 frameworks; anything it doesn't (NestJS, FastAPI, Flask, Quarkus, Ember, Tailwind) is reported as `untracked` rather than guessed at.

## It writes the code fixes too

```bash
node skills/runtime-upgrade/scripts/fix.mjs elixir ./repo 1.12 1.20 --list
node skills/runtime-upgrade/scripts/fix.mjs elixir ./repo 1.12 1.20 --apply
```

`remediate.mjs` moves version pins; **`fix.mjs` rewrites the source** — only where the rewrite is correct for every match. 11 hand-written autofixes across 9 languages: `Logger.warn`->`Logger.warning`, `File.exists?`->`File.exist?`, `window.`->`globalThis.`, `'sym`->`Symbol("sym")`, `golang.org/x/exp/slices`->`slices`, and more.

**Autofix is opt-in per rule, never inferred.** `new Buffer(x)` could be `Buffer.from` or `Buffer.alloc` depending on the argument's *type*; `createCipher`->`createCipheriv` needs an IV that isn't in the source. Those are listed as **needs-a-human, with the reason**. A `behaviour`-class rule never gets an autofix — it needs a test, not an edit.

`--list` is your decision point. `--only a,b` applies a subset. Dry run by default; `--apply` goes through the same guard as everything else.

## Pull requests — your forge, your call

```bash
node skills/runtime-upgrade/scripts/pr.mjs detect ./repo
node skills/runtime-upgrade/scripts/pr.mjs open ./repo --tool az --push
```

**GitHub** (`gh`) · **GitLab** (`glab`) · **Azure DevOps** (`az`, with `--work-items`) · **Bitbucket** (`bb`) · **Gitea/Forgejo** (`tea`) · **`push`** (compare URL, any host) · **`patch`** (no remote contacted).

The remote is classified from its URL, and a self-hosted forge is reported verbatim rather than guessed at. `detect` says what is installed, what suits the host, and how to authenticate each — then suggests, **never decides**.

Without `--tool` it refuses. Without `--push` it is a dry run — and that dry run works even when the CLI is *not installed*, printing the command, the install step, and a web-UI fallback URL. There is no force-push path in the file.

## Tickets — a separate choice

```bash
node skills/runtime-upgrade/scripts/issue.mjs create --plan plan.json --tool jira --apply
```

**Jira** (`jira-cli` or the Atlassian MCP connector) · **Azure Boards** · **GitHub Issues** · **GitLab Issues** · **Linear** · **Gitea** · **CSV** (Jira, Azure Boards, Linear and GitHub all import it) · **Markdown**.

Code review and issue tracking are independent — teams review on GitHub and track in Jira, or ship from Azure Repos into Azure Boards. An epic plus one task per target is generated from the plan, carrying EOL status, CVE delta, blockers, steps, rollback and risk. An uninstalled CLI still prints what it would run plus the routes that need nothing, and a failure **stops rather than half-filing**.

## Write mode is enforced, not requested

`guard.mjs` is what makes `SECURITY.md` true:

```bash
node skills/runtime-upgrade/scripts/guard.mjs preflight <dir>
node skills/runtime-upgrade/scripts/guard.mjs branch    <dir> node 24.22.1
node skills/runtime-upgrade/scripts/guard.mjs commit    <dir> -m "msg" --phase runtime
```
Refuses to commit on a protected branch, refuses any branch outside `runtime/*`, refuses to branch from a dirty tree, refuses a manifest change without its lockfile, and scans the staged diff for private keys and AWS/GitHub/Slack tokens. **There is no push, force, or remote code path in the file** — a test asserts it.

## Install

Requires **Node 18+** (older falls back to the `https` module). No npm install, no dependencies.

```bash
/plugin marketplace add OWNER/claude-runtime-upgrade
/plugin install runtime-upgrade@runtime-upgrade
```

Or use the scripts directly:

```bash
node skills/runtime-upgrade/scripts/doctor.mjs
node skills/runtime-upgrade/scripts/detect.mjs   /path/to/repo
node skills/runtime-upgrade/scripts/research.mjs node 20.11.1
node skills/runtime-upgrade/scripts/assess.mjs   node /path/to/repo 24.22.1
node skills/runtime-upgrade/scripts/verify.mjs   node /path/to/repo 24.22.1 --policy gate
```

Every script prints JSON on stdout and exits non-zero only where documented.

## Environment

| Var | Effect |
|---|---|
| `RU_OFFLINE=1` | cache only, **no network calls at all** |
| `RU_CACHE=<dir>` | cache location (default: `$TMPDIR/runtime-upgrade-cache`) |
| `RU_ENGINES=1` | enable the direct-dependency floor pre-flight (network-bound, slow) |
| `RU_NVD=1` | enable the PHP NVD CPE lookup (advisory only) |
| `NVD_API_KEY` | raises NVD from 5 to 50 requests per 30s ([free key](https://nvd.nist.gov/developers/request-an-api-key)) |

## What leaves your machine

Be able to answer this before running it on work code. The skill contacts exactly four hosts:

| Host | Sent | Why |
|---|---|---|
| `endoflife.date` | product name only (`nodejs`, `php`) | EOL dates |
| `raw.githubusercontent.com` | nothing — a static file fetch | Node CVE database |
| `registry.npmjs.org` (via `npm view`) | package **names** only, when `RU_ENGINES=1` | dependency floors |
| `services.nvd.nist.gov` | a PHP version string, only when `RU_NVD=1` | PHP CVE counts |

**Never sent:** source code, file contents, lockfiles, repo names, paths, credentials. **No telemetry.** `npm audit` / `composer audit` talk to your own configured registry, not to us. `RU_OFFLINE=1` disables all of it.

Responses are cached 24h on disk so repeated runs are local.

## Workflow (many repos at once)

```js
Workflow({ name: 'runtime-upgrade', args: {
  root: '/path/to/repos', cvePolicy: 'gate', mode: 'plan',
  target: '24.22.1', lang: 'node', only: ['api', 'web'],
}})
```
Six phases, `3n + 2` agents, pipelined per target with an adversarial **Challenge** stage that tries to *refute* each blocker before it reaches the report.

## Validated against real repositories

Every language is exercised end to end — detect → plan → write → commit — against a real
open-source project, not a fixture:

| | | | |
|---|---|---|---|
| chalk · slugify (Node) | Carbon (PHP) | gorilla/mux (Go) | click (Python) |
| sinatra (Ruby) | ripgrep (Rust) | gson (Java) | serilog (.NET) |
| oak (Deno) | elysia (Bun) | plug (Elixir) | cowboy (Erlang) |
| okio (Kotlin) | cats (Scala) | mojo (Perl) | |

**16/16 produce a correct, committed runtime-pin change.** That sweep found bugs no fixture
had: Scala cross-build vals being destroyed, caret constraints over-narrowed to a patch,
Perl's zero-padded version form, `go.mod` directives taking a patch, erlang.mk Makefiles,
Gradle version catalogs, and a lockfile-pairing rule that refused correct commits. Each is
now a named regression test.

## Tests

```bash
node skills/runtime-upgrade/tests/run.mjs
node skills/runtime-upgrade/tests/run.mjs --filter abi
```
165 tests. Fixtures are generated into a temp dir — the polyrepo case needs real `.git` directories, which git itself won't track, and generated fixtures can't drift from their assertions.

CI runs the suite on **ubuntu + macOS × Node 18/20/22/24**, plus an offline job, plus a weekly cron to catch upstream feed changes.

The semver matcher is **differential-tested against npm `semver`** on 143 real `engines` ranges harvested from 1162 `package.json` files, plus 40,000 generated fuzz comparisons — 100% agreement on both. Those tests skip cleanly when `semver` is unavailable, so the zero-dependency guarantee holds.

## Contributing a language

The expensive layers are already shared: **endoflife.date covers 485 products** and **OSV.dev covers 10+ ecosystems** (npm, Packagist, PyPI, RubyGems, Go, Maven, NuGet, crates.io, Pub, Hex) through one endpoint. So a new adapter is one file in `scripts/adapters/`:

```js
export const id = 'go';
export const label = 'Go';
export const manifests = ['go.mod'];
export const eolProduct = 'go';          // endoflife.date key
export const osvEcosystem = 'Go';        // OSV ecosystem
export const gateCapable = false;        // no curated runtime CVE DB? say so
export const gateNote = 'why not...';
export const imageRe = /\b(golang|go)[:@]([^\s"']+)/gi;
export function scan({ dir, root, dockerImages, ciText }) { /* ... */ }
```

Register it in `adapters/index.mjs`, add a fixture, add assertions. See `CONTRIBUTING.md`.

**Next targets:** Deno, Bun, Elixir, Kotlin, Scala, Perl — all already tracked by endoflife.date and OSV, so each is one adapter file.

## License

MIT. Data from [endoflife.date](https://endoflife.date) (MIT), [nodejs/security-wg](https://github.com/nodejs/security-wg), [OSV.dev](https://osv.dev), and [NVD](https://nvd.nist.gov).
