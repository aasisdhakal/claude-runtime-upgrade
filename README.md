# runtime-upgrade

A Claude Code skill that takes a repo of unknown shape from *"what runtime are we even on?"* to a verified upgrade plan — with EOL dates, real CVE counts, and a blocker list that separates genuine problems from noise.

Supports **Node.js** and **PHP** today. The architecture makes adding a language one file.

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

## What it does

Five gated phases, each with a machine-checkable exit condition.

| Phase | Script | Output |
|---|---|---|
| **Discover** | `detect.mjs` | repo shape, every runtime target, **version drift as a defect** |
| **Research** | `research.mjs` | EOL/support windows, unpatched runtime CVEs at current *and* target |
| **Assess** | `assess.mjs` | dependency advisories, native/ABI blockers, dependency floors |
| **Remediate** | *(guided)* | per-language playbook in `references/` |
| **Verify** | `verify.mjs` | gates that exit non-zero on failure |

Plus `doctor.mjs` — tells you what's installed and **what degrades without each tool**.

### Two choices it always puts to you

1. **CVE policy** — `gate` (high/critical CVEs block) or `report` (surface, don't block)
2. **Action mode** — `plan` (read-only, emits diffs) or `write` (branch and commit)

Neither is assumed. Both thread into every agent prompt.

## Repo shapes

All six are detected and handled differently:

`single` · `monorepo` (workspaces) · `polyrepo` (a directory of repos) · `mixed-single` (Node **and** PHP in one repo, e.g. Laravel + Vite) · `container-only` (runtime pinned only in a Dockerfile) · `no-manifest` (reported, then it stops)

## Language support

| Language | EOL data | Dependency CVEs | Runtime CVEs | Hard gate? |
|---|---|---|---|---|
| **Node.js** | endoflife.date | npm/pnpm/yarn audit + OSV | `nodejs/security-wg` — curated, semver-ranged | ✅ **yes** |
| **PHP** | endoflife.date | `composer audit` + OSV | NVD CPE only — historical, noisy | ❌ **no** |

**The asymmetry is deliberate and surfaced, not hidden.** Node is the only major runtime with a curated, semver-ranged CVE database. PHP's NVD data answers "CVEs ever filed against this product", not "unpatched at this version" — so it cannot support a numeric gate. `research.mjs` returns `gateCapable: false` for PHP and the skill is instructed never to imply a gate it can't enforce. Under `gate` policy, PHP falls back to gating on EOL status and `composer audit`.

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

## Tests

```bash
node skills/runtime-upgrade/tests/run.mjs
node skills/runtime-upgrade/tests/run.mjs --filter abi
```
34 tests. Fixtures are generated into a temp dir — the polyrepo case needs real `.git` directories, which git itself won't track, and generated fixtures can't drift from their assertions.

CI runs the suite on **ubuntu + macOS × Node 18/20/22/24**, plus an offline job, plus a weekly cron to catch upstream feed changes.

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

**Known-good next targets:** Go (near-zero ABI work), then Ruby, .NET, Java, Python (highest demand, hardest ABI story — manylinux wheels, `cp3XX` tags, free-threaded builds).

## License

MIT. Data from [endoflife.date](https://endoflife.date) (MIT), [nodejs/security-wg](https://github.com/nodejs/security-wg), [OSV.dev](https://osv.dev), and [NVD](https://nvd.nist.gov).
