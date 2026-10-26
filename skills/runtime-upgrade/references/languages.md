# Language adapters — discovery, ABI model, codemod

`nodejs.md` and `php.md` cover those two in depth. This file covers the rest.

## Gate capability at a glance

Only two runtimes have a curated, version-ranged CVE database. Everything else is advisory.

| Runtime | Runtime CVE source | Gate | Metric |
|---|---|---|---|
| **Node.js** | `nodejs/security-wg` — severity-rated | ✅ | high/critical |
| **Go** | OSV `stdlib` (Go ecosystem) — version-ranged, **no severity** | ✅ | **total** |
| PHP, Python, Ruby, Rust, Java, .NET | none unified | ❌ | gate on EOL + the ecosystem auditor |

Go's database assigns no severity at all (0 of 82 records at go1.22 carry one), but every record has a CVE alias and the Go security team only publishes reviewed issues — so a non-zero count is actionable and the gate counts totals.

---

## Go

**Declared in:** `go.mod` (`go 1.22`, `toolchain go1.22.5`) · `.tool-versions` (`golang`) · `FROM golang:1.22`

**The `go` directive is a language-version floor, not a toolchain pin.** Since Go 1.21 a newer toolchain will honour it; `toolchain` pins what actually builds. They can legitimately differ — only flag drift when the *images* and the directive disagree.

**ABI:** none. Go links statically; `CGO_ENABLED=1` is the only axis that reintroduces a libc dependency. `assess.mjs` reports whether `import "C"` appears.

**Upgrade:** `go mod edit -go=1.24 && go mod tidy` · `go fix ./...` · `govulncheck ./...` (reachability-aware — it reports only vulnerabilities your code can actually reach, which is far less noisy than a plain dependency scan).

**Deprecations loud:** `go vet ./...` and `go test -race ./...`. Go has no `--throw-deprecation` equivalent; the compiler is the gate.

---

## Python

**Declared in:** `pyproject.toml` (`requires-python`, `[tool.poetry.dependencies] python`) · `setup.cfg` (`python_requires`) · `Pipfile` · `.python-version` · `runtime.txt` · `.tool-versions` · `tox.ini` envlist · `FROM python:3.12`

**ABI — the hardest of any language here.** Binary wheels are tagged `cp3XX-<abi>-<platform>` (e.g. `cp312-cp312-manylinux_2_17_x86_64`). A new **minor** needs wheels published for that tag, or a source build with a compiler present. Check what the target accepts with `pip debug --verbose`.

Two extra axes most guides miss:
- **manylinux vs musllinux** — Alpine images need `musllinux` wheels, which many projects don't publish. This is the usual cause of "it builds on my Mac, not in the container".
- **free-threaded builds** (`3.13t`, `3.14t`) have a *separate* ABI tag (`cp313t`). A free-threaded interpreter will not load standard wheels.

**Upgrade:** `pyupgrade --py312-plus` · `ruff check --fix --target-version py312` · `pip-audit` for advisories.

**Deprecations loud:** `python -W error::DeprecationWarning -m pytest`, or `PYTHONWARNINGS=error::DeprecationWarning`.

---

## Ruby

**Declared in:** `Gemfile` (`ruby "3.3.0"`) · `.ruby-version` · `*.gemspec` (`required_ruby_version`) · `Gemfile.lock` (`RUBY VERSION`) · `.tool-versions` · `FROM ruby:3.3`

**ABI:** native gems (C extensions) relink against the interpreter and must be rebuilt for a new **minor**. `Gemfile.lock` `PLATFORMS` records which precompiled platforms were resolved — an entry like `x86_64-linux` means precompiled gems were used, and those need equivalents for the target.

**Upgrade:** bump `.ruby-version` and the `Gemfile` together, `bundle install` (not `update`) first to isolate runtime breakage from dependency drift, then `bundle update`. `rubocop -a` with `TargetRubyVersion` set.

**Deprecations loud:** `RUBYOPT=-W:deprecated` and `Warning[:deprecated] = true`.

---

## Rust

**Declared in:** `Cargo.toml` (`rust-version` = MSRV, `edition`) · `rust-toolchain.toml` (`channel`) · `.tool-versions` · `FROM rust:1.80`

**`edition` and toolchain version are independent.** Edition 2021 code compiles fine on Rust 1.85; moving edition is a separate decision from moving the toolchain. Don't bundle them.

**ABI:** none that matters — crates always compile from source. Rust has no LTS; endoflife.date reports no EOL date, so **EOL cannot drive the decision here**. Use MSRV of your dependencies instead.

**Upgrade:** `cargo update` · `cargo +nightly fix --edition` for edition moves · `cargo audit` (RustSec) for dependency advisories. RustSec covers crates, **not** the toolchain.

---

## Java

**Declared in:** `pom.xml` (`maven.compiler.release`, `java.version`) · `build.gradle[.kts]` (`JavaLanguageVersion.of`, `sourceCompatibility`) · `.sdkmanrc` · `.java-version` · `.tool-versions` · `FROM eclipse-temurin:21`

**endoflife.date has no `java` product.** The JDK is tracked per distribution: `amazon-corretto`, `oracle-jdk`, `openjdk-builds-from-oracle`, `graalvm-ce`, `microsoft-build-of-openjdk`, `redhat-build-of-openjdk`. The adapter defaults to Corretto — **set `RU_JAVA_DISTRO` to match the JDK you actually ship**, or the EOL dates will be wrong.

**ABI:** bytecode major version, not a binary ABI. `--release N` lets a newer JDK emit older bytecode, so **the JDK and the target level move independently** — you can upgrade the build JDK without changing what you emit, which makes this the safest two-step upgrade of any language here.

**Upgrade:** OpenRewrite (`rewrite-migrate-java`) is the Rector equivalent and is genuinely good. `mvn versions:display-dependency-updates`.

**Deprecations loud:** `-Xlint:deprecation,removal -Werror`.

---

## .NET

**Declared in:** `*.csproj`/`*.fsproj` (`TargetFramework`, `TargetFrameworks`) · `global.json` (`sdk.version`, `sdk.rollForward`) · `FROM mcr.microsoft.com/dotnet/sdk:8.0`

**`global.json` `rollForward` is the sharp edge.** It decides which installed SDK a build will accept — `disable` pins exactly, `latestFeature` allows drift. A build can fail on a machine with a *newer* SDK purely because of this.

**Multi-targeting is normal.** `<TargetFrameworks>net6.0;net8.0</TargetFrameworks>` means the project ships for both; the adapter reports `multiTargeted` and all majors found. Don't treat multiple TFMs as drift.

**ABI:** TFM is the compatibility axis. The runtime also rolls forward at execution time independently of the TFM it was built against.

**Upgrade:** `dotnet-upgrade-assistant` · `dotnet list package --vulnerable --include-transitive` for advisories (ships with the SDK, no install needed) · `dotnet list package --outdated`.

---

## Adding another language

See `CONTRIBUTING.md`. The EOL layer (endoflife.date, 485 products) and dependency-CVE layer (OSV.dev, 10+ ecosystems) are already shared, so the work is: discovery paths, the native/ABI model, the codemod tool, and an honest `gateCapable`.
