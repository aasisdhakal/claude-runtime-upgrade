# Changelog

Each release gets a new number in `.claude-plugin/plugin.json`; Claude Code only offers an
update when that number changes.

## 0.2.0

- **A CI test matrix now counts as version evidence.** fastify, axios and
  socket.io declare no pin and no floor — their only runtime signal is the CI
  matrix, and `plan.mjs` was dropping those targets before it ever looked.
  They produced no plan, no finding and no explanation at all. The lowest matrix
  entry is now treated as the effective floor, marked `currentInferredFrom` so
  an inference can never be read as a declaration. Found by running the plugin
  across 49 random open-source repositories; it affected 4 of 680 targets.
- **Fixed an offline CI failure that predated the workflows running.** A test
  asserted Go resolves its own target, which needs endoflife.date — so with
  `RU_OFFLINE=1` and a cold cache it failed. The property it exists to protect
  still holds unconditionally; only the network-bound half is now gated.
- **Pinned every GitHub Action to a commit SHA** and took Dependabot's bumps:
  codeql-action v4.39.1, scorecard-action v2.5.0, setup-node v7.0.0,
  checkout v7.0.1. A tag is a mutable pointer; that matters once outside pull
  requests can trigger a workflow.
- **CodeQL and Scorecard are gated on repository visibility**, so they skip
  cleanly rather than failing where they cannot run.
- **SECURITY.md names a contact**, with private vulnerability reporting as the
  preferred route and an email fallback.

## 0.1.0

- **15 language adapters** — Node, PHP, Go, Python, Ruby, Rust, Java, .NET, Deno, Bun,
  Elixir, Erlang, Kotlin, Scala, Perl. Plus EOL research for any of the 485 products
  endoflife.date tracks.
- **Floors are not pins.** A consumer-facing minimum (`engines.node`, `requires-python`,
  `rust-version`, the `go` directive) is a support contract, declined by default and raised
  only behind `--raise-floor`.
- **Source rewriting is delegated**, not reimplemented — Rector, Ruff, OpenRewrite, `go fix`
  and the Node userland codemods, with every engine's traps carried in `doctor.mjs`.
- **Dependency behaviour probes.** `depverify.mjs` ranks what moved by blast radius and
  static blindness; `probe.mjs` runs each dependency at the old and new version and diffs
  the output. Exit 1 means the behaviour changed.
- **Write mode is enforced** — `runtime/*` branches only, secret scanning on the staged diff,
  manifest/lockfile pairing, and no push or force code path anywhere in the file.
- **Gate honesty.** Only Node and Go have a curated version-ranged runtime CVE database, and
  Go's carries no severity, so it gates on total. Every other adapter explains why it cannot.
