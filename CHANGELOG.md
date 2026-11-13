# Changelog

Each release gets a new number in `.claude-plugin/plugin.json`; Claude Code only offers an
update when that number changes.

## Unreleased

- **Security: `guard commit <subdir>` ran no secret scan and no manifest/lockfile
  check.** Every git lookup used root-relative names from a subdirectory, so
  each one matched nothing — and a commit from `packages/api` went through with
  an AWS key in it. That is the normal monorepo path. All git calls now run from
  the repository root.
- **Security: the secret scan skipped files with non-ASCII names.** git C-quotes
  them, and the quoted string matched no file. Names are now read NUL-separated
  and passed as literal pathspecs.
- **Security: untracked files are no longer swept into the commit.** `git add -A`
  staged a developer's stray `.env` right after preflight had called the tree
  clean. Guard now stages tracked changes plus the files the tool itself creates;
  anything else is left alone, listed under `leftUntracked`, and committed only
  with `--include <path>`.
- **A sub-package manifest is paired with its own lockfile**, not the root one.
- **A lockfile moving alone is allowed**, with a note. It is what an in-range
  update produces, and refusing it made `remediate --deps minor` uncommittable.
  `requirements.txt` is no longer treated as `pyproject.toml`'s lockfile.
- The secret scan also catches credentials embedded in a URL.
- **A marketplace install could not find its own scripts.** `SKILL.md` and both
  workflows hard-coded `~/.claude/skills/runtime-upgrade`, a path that exists
  where the skill was developed and nowhere it was installed from a marketplace.
  `SKILL.md` now uses `${CLAUDE_SKILL_DIR}`; the workflows take `skillDir` in
  `args` and locate the skill themselves when it is not passed.
- **The multi-target workflow only handled Node and PHP.** Its language list
  was never widened when the skill grew to fifteen, so a Go or Python target was
  detected, filtered out, and the run reported nothing to upgrade. It now covers
  every language with an adapter.
- **That workflow is now `fleet`** (`/runtime-upgrade:fleet`). It was named
  `runtime-upgrade`, the same as the skill, and shadowed it in the listing.
- Removed a stale `workflow.js` nothing loaded, the redundant `skills` key in
  `plugin.json` (it registered the skill twice), and the second copy of
  `version` in `marketplace.json`.

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
