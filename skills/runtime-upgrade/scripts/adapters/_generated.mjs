// Spec-driven adapters. Each shares the EOL layer (endoflife.date) and the
// dependency-CVE layer (OSV.dev). None has a curated runtime CVE database,
// so all report gateCapable:false with a reason — same honesty contract as
// the hand-written adapters.
import { makeAdapter } from './_factory.mjs';

const no = what => `No curated, version-ranged CVE database exists for ${what}. Gate on EOL/support `
  + `status and the ecosystem auditor instead; treat runtime CVEs as advisory.`;

export const deno = makeAdapter({
  id: 'deno', label: 'Deno',
  manifests: ['deno.json', 'deno.jsonc'],
  eolProduct: 'deno', osvEcosystem: 'npm',
  imageNames: ['denoland/deno', 'deno'], ciKeyWords: ['deno'],
  lockfiles: ['deno.lock'],
  sources: { denoJson: { file: 'deno.json', re: /"deno"\s*:\s*"([^"]+)"/ },
             denoVersionFile: { file: '.deno-version' } },
  abiNote: 'single static binary; no native ABI axis. FFI and npm: specifiers are the only native surface.',
  gateNote: no('Deno'),
  countDeps: t => { try { return Object.keys(JSON.parse(t).imports || {}).length; } catch { return 0; } },
});

export const bun = makeAdapter({
  id: 'bun', label: 'Bun',
  manifests: ['bunfig.toml'],
  eolProduct: 'bun', osvEcosystem: 'npm',
  imageNames: ['oven/bun', 'bun'], ciKeyWords: ['bun'],
  lockfiles: ['bun.lock', 'bun.lockb'],
  sources: { bunVersionFile: { file: '.bun-version' } },
  versionShape: 'major',
  abiNote: 'single static binary; native addons use N-API, which is ABI-stable.',
  gateNote: no('Bun'),
});

export const elixir = makeAdapter({
  id: 'elixir', label: 'Elixir',
  manifests: ['mix.exs'],
  eolProduct: 'elixir', osvEcosystem: 'Hex',
  imageNames: ['elixir', 'hexpm/elixir'], ciKeyWords: ['elixir'],
  lockfiles: ['mix.lock'],
  sources: { mixElixir: { file: 'mix.exs', re: /elixir:\s*"([^"]+)"/ },
             mixOtp:    { file: 'mix.exs', re: /otp_app:\s*:(\w+)/ } },
  driftExclude: ['mixOtp'],   // otp_app is an application name, not a version
  abiNote: 'NIFs are compiled per OTP release; the Elixir and Erlang/OTP versions move together and both must be pinned.',
  gateNote: no('Elixir'),
  countDeps: t => ((t.split(/defp?\s+deps\s+do/)[1] || '').match(/\{:\w+/g) || []).length,
});

export const erlang = makeAdapter({
  id: 'erlang', label: 'Erlang/OTP',
  manifests: ['rebar.config'],
  eolProduct: 'erlang', osvEcosystem: 'Hex',
  imageNames: ['erlang'], ciKeyWords: ['otp', 'erlang'],
  lockfiles: ['rebar.lock'],
  sources: { minimumOtp: { file: 'rebar.config', re: /minimum_otp_vsn\s*,\s*"([^"]+)"/ },
             toolVersionsOtp: { file: '.tool-versions', re: /^erlang\s+(\S+)/m } },
  versionShape: 'major',
  abiNote: 'NIFs and ports are compiled against the OTP release; a new OTP MAJOR needs a rebuild.',
  gateNote: no('Erlang/OTP'),
  countDeps: t => ((t.match(/\{deps\s*,\s*\[/) ? t.split(/\{deps\s*,\s*\[/)[1] : '').match(/\{\w+/g) || []).length,
});

export const kotlin = makeAdapter({
  id: 'kotlin', label: 'Kotlin',
  manifests: ['build.gradle.kts', 'gradle.properties'],
  eolProduct: 'kotlin', osvEcosystem: 'Maven',
  imageNames: ['kotlin'], ciKeyWords: ['kotlin'],
  lockfiles: ['gradle.lockfile'],
  sources: { kotlinPlugin:  { file: 'build.gradle.kts', re: /kotlin\(["']jvm["']\)\s*version\s*["']([^"']+)/ },
             gradleProps:   { file: 'gradle.properties', re: /kotlin\.version\s*=\s*(\S+)/ },
             jvmToolchain:  { file: 'build.gradle.kts', re: /jvmToolchain\((\d+)\)/ } },
  driftExclude: ['jvmToolchain'],   // the JVM target is a separate axis from the Kotlin version
  abiNote: 'Kotlin targets a JVM bytecode level; the Kotlin compiler version and the JVM target move independently.',
  gateNote: no('Kotlin'),
  countDeps: t => (t.match(/^\s*(implementation|api|testImplementation)\s*\(/gm) || []).length,
});

export const scala = makeAdapter({
  id: 'scala', label: 'Scala',
  manifests: ['build.sbt'],
  eolProduct: 'scala', osvEcosystem: 'Maven',
  imageNames: ['sbtscala/scala-sbt', 'hseeberger/scala-sbt'], ciKeyWords: ['scala'],
  lockfiles: [],
  sources: { scalaVersion:      { file: 'build.sbt', re: /scalaVersion\s*:=\s*"([^"]+)"/ },
             crossScalaVersions:{ file: 'build.sbt', re: /crossScalaVersions\s*:=\s*Seq\(([^)]+)\)/ },
             scalaVersionFile:  { file: '.scala-version' } },
  driftExclude: ['crossScalaVersions'],   // a cross-build matrix is deliberate breadth
  abiNote: 'Scala 2 binaries are NOT compatible across minors (2.12 vs 2.13); Scala 3 keeps TASTy compatibility forward only.',
  gateNote: no('Scala'),
  countDeps: t => (t.match(/libraryDependencies\s*\+?\+?=/g) || []).length,
});

export const perl = makeAdapter({
  id: 'perl', label: 'Perl',
  manifests: ['cpanfile', 'Makefile.PL', 'Build.PL'],
  eolProduct: 'perl', osvEcosystem: 'CPAN',
  imageNames: ['perl'], ciKeyWords: ['perl'],
  lockfiles: ['cpanfile.snapshot'],
  sources: { cpanfilePerl:  { file: 'cpanfile', re: /requires\s+["']perl["']\s*,\s*["']?([\d.v]+)/ },
             makefilePerl:  { file: 'Makefile.PL', re: /MIN_PERL_VERSION\s*=>\s*["']?([\d._]+)/ },
             perlVersion:   { file: '.perl-version' } },
  abiNote: 'XS modules are compiled against the interpreter and must be rebuilt for a new MAJOR.MINOR.',
  gateNote: no('Perl'),
  countDeps: t => (t.match(/^\s*requires\s+/gm) || []).length,
});
