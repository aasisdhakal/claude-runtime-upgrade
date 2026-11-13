// What differs between languages once the shared layers (EOL, OSV, pin
// rewriting) are taken away: how a dependency audit is run, what a NATIVE
// blocker looks like, and where to check that a package supports the target.
//
// This is the only place those facts live. assess.mjs runs the auditor from
// here, brief.mjs prints all of it, and the fleet workflow's prompts name no
// language at all — they run brief.mjs and follow it. The workflow used to
// carry its own language list; it said ['node', 'php'] long after the skill
// covered fifteen, so thirteen languages were detected and then dropped.
//
// Every adapter must have an entry. A test asserts it, so adding a language
// without saying how it is audited fails loudly instead of degrading quietly.

export const LANG_FACTS = {
  node: {
    runtimeBin: 'node', versionArgs: ['--version'],
    // chosen by lockfile inside assess.mjs — three package managers, three CLIs
    auditor: null,
    auditorNote: 'npm audit, pnpm audit or yarn npm audit, chosen by the lockfile present',
    installedTree: 'node_modules/',
    registry: { name: 'npm', supportsTarget: 'npm view <pkg>@<version> engines.node' },
    native: {
      enumerated: true,
      axis: 'NODE_MODULE_VERSION — a compiled addon is built for one Node ABI unless it uses N-API',
      blocker: 'nativeAddons entries with kind "abi-pinned" (they are repeated in nativeBlockers)',
      noise: 'kind "napi" is ABI-stable across Node majors — never a blocker, never a ticket',
      unknown: 'kind "prebuilt-platform" could be either; verify a build exists for the target and libc',
    },
    reference: 'references/nodejs.md',
  },
  php: {
    runtimeBin: 'php', versionArgs: ['-r', 'echo PHP_VERSION;'],
    auditor: null,
    auditorNote: 'composer audit, plus composer prohibits and check-platform-reqs for the target',
    installedTree: 'vendor/',
    registry: { name: 'Packagist', supportsTarget: 'composer prohibits php:<target>  (or read require.php on packagist.org)' },
    native: {
      enumerated: false,
      axis: 'the Zend module API — every compiled extension must be rebuilt for a new PHP MINOR; there is no N-API equivalent',
      blocker: 'an extension in loadedExtensions with no build for the target minor, or one present on the old image and missing on the new',
      noise: 'pure-PHP packages in vendor/ have no native axis',
      unknown: 'extensions installed by the base image rather than by this repo — diff `php -m` between the two images',
    },
    reference: 'references/php.md',
  },
  go: {
    runtimeBin: 'go', versionArgs: ['version'],
    auditor: { cmd: 'govulncheck', args: ['-format', 'json', './...'], install: 'go install golang.org/x/vuln/cmd/govulncheck@latest' },
    installedTree: 'the module cache (go env GOMODCACHE), or vendor/ when the module is vendored',
    registry: { name: 'Go module proxy', supportsTarget: 'the `go` directive in the dependency\'s own go.mod: go list -m -json <module>@<version>' },
    native: {
      enumerated: false,
      axis: 'none for pure Go (statically linked). cgo is the only native axis — see `cgo` and `cgoEvidence`',
      blocker: 'cgo in use AND the target image lacks a matching libc/toolchain',
      noise: 'a pure-Go module: CGO_ENABLED=0 builds move between images freely',
      unknown: 'a dependency that itself uses cgo — `go list -deps -f \'{{if .CgoFiles}}{{.ImportPath}}{{end}}\' ./...`',
    },
    reference: 'references/languages.md',
  },
  python: {
    runtimeBin: 'python3', versionArgs: ['--version'],
    auditor: { cmd: 'pip-audit', args: ['-f', 'json'], install: 'pipx install pip-audit' },
    installedTree: 'the active virtualenv\'s site-packages',
    registry: { name: 'PyPI', supportsTarget: 'requires_python and the cp3XX wheel tags at https://pypi.org/pypi/<pkg>/<version>/json' },
    native: {
      enumerated: false,
      axis: 'binary wheels are tagged cp3XX-<abi>-<platform>; a new MINOR needs a wheel published for that tag, or a source build with a compiler',
      blocker: 'a compiled dependency with no cp<target> wheel and no usable sdist',
      noise: 'pure-Python wheels (py3-none-any) and abi3 wheels, which are stable across minors',
      unknown: 'anything installed from an sdist — it builds at install time and needs the toolchain in the image',
    },
    reference: 'references/languages.md',
  },
  ruby: {
    runtimeBin: 'ruby', versionArgs: ['--version'],
    auditor: { cmd: 'bundle', args: ['audit', 'check', '--quiet'], install: 'gem install bundler-audit && bundle audit update' },
    installedTree: 'bundle show --paths (the gem home, or vendor/bundle)',
    registry: { name: 'RubyGems', supportsTarget: '`ruby_version` (the gem\'s required_ruby_version) at https://rubygems.org/api/v2/rubygems/<gem>/versions/<version>.json' },
    native: {
      enumerated: false,
      axis: 'C extensions relink against the interpreter and must be rebuilt for a new MINOR',
      blocker: 'a precompiled platform gem (see Gemfile.lock PLATFORMS) with no build for the target minor',
      noise: 'pure-Ruby gems',
      unknown: 'gems that compile at install — they need the toolchain and headers in the image',
    },
    reference: 'references/languages.md',
  },
  rust: {
    runtimeBin: 'rustc', versionArgs: ['--version'],
    auditor: { cmd: 'cargo', args: ['audit', '--json'], install: 'cargo install cargo-audit' },
    installedTree: '~/.cargo/registry (sources only — everything compiles)',
    registry: { name: 'crates.io', supportsTarget: 'rust_version (MSRV) at https://crates.io/api/v1/crates/<crate>/<version>' },
    native: {
      enumerated: false,
      axis: 'none — crates always compile from source. `edition` is independent of the toolchain version',
      blocker: 'a dependency whose MSRV is ABOVE the target toolchain (the direction is reversed: newer crates need newer rustc)',
      noise: 'the edition: it does not have to move with the toolchain',
      unknown: '-sys crates that link a system library — the image must still provide it',
    },
    reference: 'references/languages.md',
  },
  java: {
    runtimeBin: 'java', versionArgs: ['-version'],
    auditor: null,
    auditorNote: 'no standard CLI auditor — OWASP dependency-check, or osv-scanner over the build files',
    installedTree: '~/.m2/repository or ~/.gradle/caches',
    registry: { name: 'Maven Central', supportsTarget: 'the class-file major version of the published jar, or the library\'s documented baseline' },
    native: {
      enumerated: false,
      axis: 'bytecode major version, not a binary ABI. `--release N` lets a newer JDK emit older bytecode, so the JDK and the target level move independently',
      blocker: 'a library compiled for a NEWER class-file version than the target JDK reads, or one using an API removed at the target',
      noise: 'jars compiled for an older release — a newer JVM runs them',
      unknown: 'JNI libraries and agents (bytecode instrumentation breaks on a new class-file version before anything else does)',
    },
    reference: 'references/languages.md',
  },
  dotnet: {
    runtimeBin: 'dotnet', versionArgs: ['--version'],
    auditor: { cmd: 'dotnet', args: ['list', 'package', '--vulnerable', '--include-transitive'], install: 'ships with the .NET SDK' },
    installedTree: '~/.nuget/packages',
    registry: { name: 'NuGet', supportsTarget: 'the target frameworks listed for the package version on nuget.org' },
    native: {
      enumerated: false,
      axis: 'the TFM (net8.0) is the compatibility axis; global.json `rollForward` decides which installed SDK a build accepts',
      blocker: 'a package with no asset for the target TFM or a compatible lower one',
      noise: 'netstandard2.x packages — every modern TFM consumes them',
      unknown: 'packages carrying runtimes/<rid>/native assets — check the RID exists for the target image',
    },
    reference: 'references/languages.md',
  },
  deno: {
    runtimeBin: 'deno', versionArgs: ['--version'],
    auditor: { cmd: 'deno', args: ['audit'], install: 'ships with Deno' },
    installedTree: 'the global cache (deno info), or node_modules/ when nodeModulesDir is set',
    registry: { name: 'JSR and npm', supportsTarget: 'jsr.io/<scope>/<pkg> for jsr: specifiers; npm view <pkg> engines for npm: specifiers' },
    reference: 'references/languages.md',
  },
  bun: {
    runtimeBin: 'bun', versionArgs: ['--version'],
    auditor: { cmd: 'bun', args: ['audit', '--json'], install: 'ships with Bun' },
    installedTree: 'node_modules/',
    registry: { name: 'npm', supportsTarget: 'npm view <pkg>@<version> engines' },
    reference: 'references/languages.md',
  },
  elixir: {
    runtimeBin: 'elixir', versionArgs: ['--version'],
    auditor: { cmd: 'mix', args: ['deps.audit'], install: 'add {:mix_audit, "~> 2.1", only: [:dev, :test], runtime: false} to deps' },
    installedTree: 'deps/ and _build/',
    registry: { name: 'Hex', supportsTarget: 'the `elixir` requirement at https://hex.pm/api/packages/<pkg>/releases/<version>' },
    reference: 'references/languages.md',
  },
  erlang: {
    runtimeBin: 'erl', versionArgs: ['-noshell', '-eval', 'io:format("~s", [erlang:system_info(otp_release)]), halt().'],
    auditor: null,
    auditorNote: 'no standard auditor for rebar3 projects — osv-scanner, or OSV by package from rebar.lock',
    installedTree: '_build/default/lib',
    registry: { name: 'Hex', supportsTarget: 'the package\'s documented minimum OTP (Hex carries no machine-readable OTP floor)' },
    reference: 'references/languages.md',
  },
  kotlin: {
    runtimeBin: 'kotlinc', versionArgs: ['-version'],
    auditor: null,
    auditorNote: 'no standard CLI auditor — OWASP dependency-check, or osv-scanner over the Gradle files',
    installedTree: '~/.gradle/caches',
    registry: { name: 'Maven Central', supportsTarget: 'the Kotlin metadata version the library was compiled with — a compiler reads at most one version ahead' },
    reference: 'references/languages.md',
  },
  scala: {
    runtimeBin: 'scala', versionArgs: ['-version'],
    auditor: null,
    auditorNote: 'no standard CLI auditor — sbt-dependency-check, or osv-scanner over the build files',
    installedTree: '~/.ivy2 or the Coursier cache',
    registry: { name: 'Maven Central', supportsTarget: 'whether an artifact exists with the target binary suffix (_2.13, _3)' },
    reference: 'references/languages.md',
  },
  perl: {
    runtimeBin: 'perl', versionArgs: ['-e', 'print $^V'],
    auditor: { cmd: 'cpan-audit', args: ['deps', '.'], install: 'cpanm CPAN::Audit' },
    installedTree: 'local/ (Carton) or the site_perl of the interpreter',
    registry: { name: 'CPAN', supportsTarget: 'MIN_PERL_VERSION / `use 5.xxx` in the distribution, and its CPAN Testers matrix for the target' },
    reference: 'references/languages.md',
  },
};

/**
 * A second opinion that works for every ecosystem: osv-scanner reads the
 * lockfile and build files directly. assess.mjs falls back to it when the
 * language's own auditor is absent or does not exist.
 */
export const OSV_SCANNER = {
  cmd: 'osv-scanner',
  args: dir => ['scan', 'source', '--format', 'json', '--allow-no-lockfiles', dir],
  install: 'https://google.github.io/osv-scanner/installation/',
};
