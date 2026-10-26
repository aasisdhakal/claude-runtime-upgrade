# Contributing

## Run the tests first

```bash
node skills/runtime-upgrade/tests/run.mjs
```
34 tests, no dependencies, no network required for most of them (live-data tests skip themselves when the feeds are unreachable).

## Adding a language adapter

1. Create `skills/runtime-upgrade/scripts/adapters/<lang>.mjs` exporting:

   | Export | Purpose |
   |---|---|
   | `id`, `label` | identity |
   | `manifests` | filenames that mark a target (`['go.mod']`) |
   | `eolProduct` | the endoflife.date key — check `https://endoflife.date/api/all.json` |
   | `osvEcosystem` | the OSV ecosystem string |
   | `gateCapable` | **be honest.** `true` only with a curated, version-ranged runtime CVE source |
   | `gateNote` | required when `gateCapable` is false — explain why |
   | `imageRe` | matches the runtime in a Dockerfile `FROM` |
   | `scan({dir, root, dockerImages, ciText})` | returns the target object |
   | `matchRuntimeCve(db, version)` | only if `gateCapable` |

2. Register it in `adapters/index.mjs`.
3. Add a fixture in `tests/fixtures.mjs` and assertions in `tests/run.mjs`.
4. Add a `references/<lang>.md` playbook covering: where the version is declared, the native/ABI model, the codemod tool, how to make deprecations loud.

### `scan()` must return

```js
{
  lang, name, dir, manifest,
  declared: { /* every place a version was found, by source name */ },
  lockfile, declaredMajors, drift,   // drift = more than one distinct major
  deps, devDeps,
}
```

**`drift` is the point.** A repo whose Dockerfile and version file disagree has a bug before any upgrade starts. Report it; don't silently pick a winner.

## Rules that are not negotiable

- **Zero runtime dependencies.** No `jq`, `python3`, `find`, `mapfile`, `paste`. It must run on macOS, Linux and WSL unchanged.
- **Never claim a gate you can't enforce.** If a language has no curated runtime CVE source, `gateCapable = false` and explain it.
- **Audit tools exit non-zero when they find things.** Use `lib/sh.mjs` — it captures output regardless of exit status. Never write `cmd || echo '{}'`; that concatenates real output with the fallback and yields two JSON documents.
- **ABI evidence beats declarations.** A package shipping ABI-numbered `.node` files is ABI-pinned even if it also declares `napi_versions`. There is a test for exactly this.
- **Every script prints JSON to stdout.** Diagnostics go to stderr.
- **Fail soft on network.** Degrade to cache, then to a clear error. Never crash a phase because a feed is down.

## Verifying your tests actually test something

Mutate the code and confirm the suite goes red:

```bash
# flip the classifier order in assess.mjs, then:
node skills/runtime-upgrade/tests/run.mjs --filter abi   # must FAIL
```
A test that never fails is documentation, not a test.
