# Security

## Reporting

Open a private security advisory on this repository. Please don't file a public issue for a vulnerability.

## What this tool does and does not do

**It reads.** Manifests, lockfiles, Dockerfiles, CI config, and `node_modules`/`vendor` metadata.

**It writes only when you say so.** The skill always asks for an action mode. Under `plan` it emits diffs and changes nothing. Under `write` it works on a branch (`runtime/<lang>-<target>`), commits per phase, and never commits a lockfile without its manifest.

**It executes these, and only these:** `npm`/`pnpm`/`yarn audit`, `npm view`, `composer audit|prohibits|check-platform-reqs`, `php -m|-i|-r`, `docker run --rm <your image>`. All through `spawnSync` with argument arrays — never a shell string, so repo contents cannot be interpolated into a command.

**Network:** four hosts, listed in the README. Only version strings and package names leave the machine. No source, no paths, no repo names, no telemetry. `RU_OFFLINE=1` disables all network access.

## Trust boundaries worth knowing

- **Advisory data is third-party.** endoflife.date, nodejs/security-wg, OSV and NVD are reputable but not infallible. A clean report is evidence, not a guarantee.
- **`npm audit` reaches your configured registry.** On a private registry, that's where the query goes.
- **Cached responses live in `$TMPDIR`** for 24h and are world-readable by default on shared machines. Set `RU_CACHE` to a private directory if that matters.
- **This tool does not sandbox the commands it runs.** It runs your package manager against your project, exactly as you would.
