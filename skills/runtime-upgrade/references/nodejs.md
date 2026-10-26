# Node.js adapter

## Version is declared in up to 8 places
`package.json#engines.node` · `#devEngines.runtime` · `#volta.node` · `.nvmrc` · `.node-version` · `.tool-versions` · every `FROM node:*` stage (multi-stage repos routinely miss one) · CI (`actions/setup-node`, `image:`, CodeBuild `runtime-versions`). Plus `packageManager` for Corepack.

## ABI ladder — verified against `node-abi`
| Node | NODE_MODULE_VERSION |
|---|---|
| 20 | 115 |
| 22 | 127 |
| 24 | **137** |
| 26 | **147** |

Check with `node -p "process.versions.modules"`, inside the built image.

**N-API is the escape hatch.** A package declaring `binary.napi_versions` or shipping a `napi-vN/` directory is ABI-stable across majors — no rebuild. A package shipping `name-<abi>.node` files is ABI-pinned and blocks until a build exists for the target. `assess.mjs` makes this call; explicit ABI-numbered files win over a napi directory.

Also varies independently: **libc** (glibc vs musl/Alpine). Node 24+ needs glibc ≥2.28; musl builds need Alpine ≥3.20.

## Breaking changes
- `https://nodejs.org/en/blog/release/v<MAJOR>.0.0` — the "Semver-Major Commits" section
- `https://github.com/nodejs/node/blob/main/doc/api/deprecations.md` — every `DEP####` and its status

Grep the codebase for the usual suspects:
```bash
grep -rn "url\.parse\|new Buffer(\|writeHeader(\|require('punycode')\|createCipher(" src/
```

## No Rector equivalent
Node has no first-party codemod for version migrations. Compensate:
1. Set `engines.node` to the target **first**.
2. `eslint-plugin-n` → `n/no-unsupported-features/{node-builtins,es-syntax,es-builtins}`. It reads `engines.node` automatically, so step 1 turns the upgrade into a lint report.
3. `knip` / `depcheck` to delete dead dependencies **before** upgrading them — every removed package is one you don't have to make compatible.
4. `npm-check-updates` / `pnpm up --latest` for the sweep.
5. `tsc` with a matching `@types/node` major (`^24` for Node 24 — match the runtime, not `latest`).

## Dependency compatibility
```bash
npm view <pkg> engines.node peerDependencies
```
Walk the **installed tree**, not the manifest ranges — `package.json` says `^10`, `node_modules` may hold `10.4.17`, and the registry's current major may be 12. All three matter.

`engines` is advisory in npm unless `engine-strict=true` in `.npmrc`. Set it to get parity with Composer's enforced platform check.

## AsyncLocalStorage (Node 24+)
Node 24 switched `AsyncLocalStorage` to `AsyncContextFrame` by default. **It fails silently** — the store returns `undefined` rather than throwing. Any request-context, tracing, or per-request-store code is exposed. Write an explicit test asserting context identity across an `await` boundary and across any message/command bus. Confirm a regression with `--no-async-context-frame` before changing application code.

## Verification
```bash
docker run --rm IMG node -v
docker run --rm IMG node -p "process.versions.modules"   # expect the target ABI
docker run --rm IMG node -p "process.versions.openssl"
NODE_OPTIONS="--throw-deprecation --pending-deprecation" npm test
```
`--pending-deprecation` reports what the **next** major removes — one upgrade cycle de-risks the following one.
