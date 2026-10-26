---
name: runtime-upgrade
description: Upgrade a language runtime (Node.js or PHP) across any repo shape — single, monorepo, polyrepo, mixed-language, or container-only. Covers discovery, EOL/CVE research, blocker assessment, code upgrade, and the test/rollout workflow. Use when asked to upgrade, bump, or modernise a Node or PHP version, to check what runtime a project is on, to audit runtime EOL/CVE exposure, or to plan a version migration.
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

Also ask, when it is not obvious: **which target version** (otherwise `research.mjs` picks the newest non-EOL LTS), and **which targets** when discovery finds more than ~6.

## Phase 1 — DISCOVER

```bash
node $SK/scripts/detect.mjs <root> 
```
Emits `{root, shape, target_count, targets[]}`. `shape` is one of `single`, `monorepo`, `polyrepo`, `mixed-single`, `container-only`, `no-manifest` — handle all six:

| shape | what to do |
|---|---|
| `single` | one target, straightforward |
| `monorepo` | root + workspaces. Upgrade the **root** runtime pin once; each workspace gets its own compat pass. Don't file one ticket per package |
| `polyrepo` | a directory of independent repos. Each is its own unit of work with its own branch and rollback |
| `mixed-single` | Node **and** PHP in one repo (Laravel+Vite, Symfony+Encore). Run both adapters; **upgrade them in separate commits** |
| `container-only` | no manifest, runtime pinned only in a Dockerfile. Add a manifest pin as part of the work — otherwise nothing enforces the version |
| `no-manifest` | report it and stop. There is nothing to upgrade until someone declares a runtime |

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

## Phase 4 — REMEDIATE

**Bump the manifest floor first.** This is the lever that makes every other tool report against the target instead of the status quo:
- Node: set `engines.node` to the target → `eslint-plugin-n` then reports every forbidden API
- PHP: set `require.php` → Rector will not apply target-version rules until you do

Then follow the per-language playbook:
- `references/nodejs.md` — ABI ladder, N-API, AsyncContextFrame, eslint-plugin-n
- `references/php.md` — bootstrap, Zend ABI, Rector, `composer prohibits`
- `references/languages.md` — Go, Python, Ruby, Rust, Java, .NET: discovery paths, ABI model, codemod tool

Rules that hold for both:
- **One major at a time**, commit between each. Never stack two majors in one diff.
- Regenerate the lockfile with the **new** runtime's package manager.
- Under `MODE=plan`, emit diffs only.

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
