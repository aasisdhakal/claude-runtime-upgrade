# Changelog

Each release gets a new number in `.claude-plugin/plugin.json`; Claude Code only offers an
update when that number changes.

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
