// Which EXISTING tool does the source rewriting for each language, and what it
// leaves behind.
//
// The rule catalogue in breaking.mjs deliberately does NOT duplicate these.
// Rector has 145 PHP rules maintained by people who do only that; a hand-rolled
// regex copy is strictly worse. So this registry's job is to answer, for one
// repo and one from->to:
//
//   is the engine here, what exactly should it run, what will it NOT do, and
//   which of its known traps apply to this project?
//
// Three rules this file exists to enforce:
//
//  1. DETECT, NEVER INSTALL. The skill is node+git+curl. Adding a JVM, Composer
//     and Maven as hard dependencies would end that. An absent engine degrades
//     to "here is the exact command and config, run it when you have the tool".
//  2. NEVER DELEGATE BLIND. Every entry records what the engine does not touch.
//     Pins, CI, lockfiles, dependency resolution and verification stay ours in
//     every single case — no engine here does any of them except OpenRewrite,
//     which does build config and is called out for it.
//  3. CARRY THE TRAPS. Each `hazards` entry is something that was observed
//     making a tool silently produce a wrong or empty result. A silent no-op
//     that reads as "nothing to migrate" is the worst outcome of the lot.
import { join, existsSync, readText } from './io.mjs';
import { have, run } from './sh.mjs';

const mm = v => (String(v).match(/^\d+(\.\d+)?/) || [v])[0];
const major = v => (String(v).match(/^\d+/) || [v])[0];

export const ENGINES = {
  // ───────────────────────────── PHP ─────────────────────────────
  php: {
    name: 'Rector',
    bin: 'rector',
    localBin: 'vendor/bin/rector',
    url: 'https://getrector.com',
    licence: 'MIT',
    install: 'composer require --dev rector/rector',
    // Rector ships its own parser (PHP-Parser), so it reads syntax the host PHP
    // rejects — `$str{0}` is parseable to Rector on PHP 8.3, where `php -l` fails.
    requires: ['a composer.json in the working directory', 'PHP 7.4+ to run'],
    needsBuild: false,
    covers: [
      'removed and renamed functions', 'syntax dropped between releases',
      'signature changes with a mechanical rewrite', 'string interpolation forms',
    ],
    doesNotTouch: [
      'composer.json require.php / config.platform.php',
      '.php-version, Dockerfile, CI matrices, deploy manifests',
      'dependency resolution — it never runs composer update',
      'extension-level breakage (ext-* availability, ini changes)',
      'verification — it never runs your tests',
    ],
    hazards: [
      { id: 'two-version-knobs',
        what: 'withPhpSets() picks which rules LOAD; withPhpVersion() is a separate ceiling, '
            + 'computed as min(ceiling, composer.json require.php, PHP_VERSION_ID).',
        why: 'Observed: with require.php "^8.1" and withPhpSets(php84: true), only the <=8.1 '
           + 'rules fired. utf8_encode, ${} and implicit-nullable params were silently skipped. '
           + 'A tool that rewrites source BEFORE moving pins must set withPhpVersion() explicitly.' },
      { id: 'style-rules-ride-along',
        what: 'withPhpSets() pulls in CodingStyle rules, not only breaking-change rules.',
        why: 'The 8.1 set includes FunctionFirstClassCallableRector, which rewrote '
           + "session_set_save_handler('o','c','r',...) into first-class callables — inconsistently, "
           + 'and fatally if those functions are not defined. Prefer an explicit withRules([...]) allowlist.' },
      { id: 'unparseable-file-aborts',
        what: 'A file using syntax removed before the target (e.g. $str{0}) inside a class crashes '
            + 'the whole-set run with: System error: "Class ... should be known at this point".',
        why: 'PHPStan cannot build a scope for it, so the file is skipped entirely. Run those files '
           + 'through an isolated --only=Rector\\Php74\\Rector\\ArrayDimFetch\\CurlyToSquareBracketArrayStringRector '
           + 'pass FIRST. The curly-offset rule in breaking.mjs exists to trigger exactly that.' },
    ],
    // `--dry-run` exits 2 when changes are pending, 0 when clean — a usable gate.
    dryRun: (dir) => ['rector', ['process', '--dry-run', '--no-progress-bar', '--output-format=json'], { cwd: dir }],
    apply:  (dir) => ['rector', ['process', '--no-progress-bar'], { cwd: dir }],
    okExit: { dryRun: [0, 2], apply: [0] },
    configFile: 'rector.php',
    config: (_from, to) => `<?php

declare(strict_types=1);

use Rector\\Config\\RectorConfig;
use Rector\\ValueObject\\PhpVersion;

// BOTH knobs are required. withPhpSets() decides which rules load;
// withPhpVersion() is an independent ceiling taken as
// min(this, composer.json require.php, PHP_VERSION_ID). Omit it while the pins
// still read the OLD version and every rule above that version silently no-ops.
return RectorConfig::configure()
    ->withPaths([__DIR__ . '/src'])
    ->withPhpVersion(PhpVersion::PHP_${String(mm(to)).replace('.', '')})
    ->withPhpSets(php${String(mm(to)).replace('.', '')}: true);
`,
  },

  // ──────────────────────────── PYTHON ────────────────────────────
  python: {
    name: 'Ruff',
    bin: 'ruff',
    url: 'https://docs.astral.sh/ruff/',
    licence: 'MIT',
    install: 'pip install ruff   (single binary, no project changes)',
    requires: [],
    needsBuild: false,
    covers: ['outdated spellings of current idioms (the UP ruleset)'],
    doesNotTouch: [
      'requires-python — Ruff only READS it to infer target-version, never writes',
      'any config file at all: source only',
      'removed stdlib MODULES — see the hazard below, this is the big one',
    ],
    hazards: [
      { id: 'up035-whitelist',
        what: 'UP035 works off a hardcoded 8-module list: collections, pipes, mypy_extensions, '
            + 'typing_extensions, typing, typing.io, typing.re, backports.strenum.',
        why: 'imp, distutils, ast, asyncio and 18 of the 19 PEP 594 modules CANNOT be in scope. '
           + 'Ruff models "this spelling is outdated", not "this module no longer exists". '
           + 'Stdlib removals are outside its design — that is why breaking.mjs keeps those rules.' },
      { id: 'diff-hides-unfixable',
        what: '`ruff check --diff` implies --fix-only, so diagnostics with no fix are suppressed.',
        why: 'DTZ003/DTZ004 (datetime.utcnow) have no fix and vanish from --diff output entirely. '
           + 'Always run a plain `ruff check` alongside the diff, or you will report a clean result.' },
      { id: 'dtz-not-default',
        what: 'Ruff\'s defaults are F, E, B, UP, RUF. DTZ is opt-in.',
        why: 'datetime.utcnow() and utcfromtimestamp() are reported by DTZ003/DTZ004 and by nothing '
           + 'else, so a default Ruff run reports a clean file. Neither rule carries a fix either, so '
           + 'even once selected they are suppressed by --diff. Select DTZ and run a plain check.' },
    ],
    dryRun: (dir) => ['ruff', ['check', '--diff', '.'], { cwd: dir }],
    apply:  (dir) => ['ruff', ['check', '--fix', '.'], { cwd: dir }],
    alsoRun: (dir) => ['ruff', ['check', '.'], { cwd: dir }],   // catches the unfixable
    okExit: { dryRun: [0, 1], apply: [0, 1] },
    configFile: 'ruff.toml',
    config: (_from, to) => `# Generated for a Python ${mm(to)} target.
# target-version gates the UP rules. Ruff would otherwise infer it from
# [project] requires-python, which still reads the OLD version at this point.
target-version = "py${String(mm(to)).replace('.', '')}"

[lint]
# UP  — the pyupgrade set (idiom modernisation)
# DTZ — naive-datetime detection; NOT on by default, and none of it is fixable,
#       so it is invisible to \`--diff\`. Run a plain \`ruff check\` too.
select = ["UP", "DTZ"]
`,
  },

  // ───────────────────────────── JAVA ─────────────────────────────
  java: {
    name: 'OpenRewrite',
    bin: 'mvn',
    altBin: 'gradle',
    url: 'https://docs.openrewrite.org',
    licence: 'Apache-2.0',
    install: 'no install — invoked as a Maven/Gradle plugin goal',
    requires: ['Maven 3.6+ or Gradle 4.0+', 'every compile AND test dependency must resolve'],
    needsBuild: true,
    covers: [
      'removed and deprecated JDK APIs', 'javax -> jakarta',
      // This is the one engine that crosses into our pin territory.
      'BUILD CONFIG: maven.compiler.source/target/release, java.version, Gradle '
      + 'java.toolchain.languageVersion, Kotlin jvmTarget',
      'CI and tooling: setup-java, Jenkins, SDKMAN, CircleCI images, Dockerfile Java versions',
    ],
    doesNotTouch: ['dependency advisories', 'verification — it never runs your tests'],
    overlapsOurPins: true,   // see hazard below
    hazards: [
      { id: 'overlaps-our-pin-layer',
        what: 'UpgradeToJavaNN includes UpgradeJavaVersion, which rewrites the Maven/Gradle Java '
            + 'properties, setup-java, SDKMAN, CircleCI and Dockerfile Java versions.',
        why: 'For Java this is the SAME job as our planPinEdits/planCiEdits. Running both means two '
           + 'tools editing the same files. Prefer OpenRewrite for Java pins and skip ours, or skip '
           + 'UpgradeJavaVersion and keep ours — but do not run both unreviewed.' },
      { id: 'silent-noop-without-build',
        what: 'The parser classpath is built from the project\'s compile/test classpath elements, '
            + 'which in a multi-module reactor include each upstream module\'s target/classes.',
        why: 'If you never built, those directories are empty, type attribution degrades, and '
           + 'type-aware recipes silently match nothing. You get a clean empty patch and a false '
           + '"nothing to migrate". Run `mvn -DskipTests install` first.' },
      { id: 'resolution-is-a-hard-gate',
        what: 'The dryRun mojo is annotated requiresDependencyResolution = TEST.',
        why: 'One unresolvable dependency and the goal fails before a single file is parsed. '
           + 'javac success is NOT required — OpenRewrite never invokes javac — but resolution is.' },
      { id: 'no-java-24-recipe',
        what: 'There is no UpgradeToJava24 composite. The version files are 6,7,8,11,17,21,25.',
        why: 'A 21 -> 24 target has no recipe; the path jumps to 25. Anything 24-specific is ours.' },
    ],
    dryRun: (dir, to) => ['mvn', ['-U', 'org.openrewrite.maven:rewrite-maven-plugin:dryRun',
      '-Drewrite.recipeArtifactCoordinates=org.openrewrite.recipe:rewrite-migrate-java:RELEASE',
      `-Drewrite.activeRecipes=org.openrewrite.java.migrate.UpgradeToJava${major(to)}`], { cwd: dir }],
    apply: (dir, to) => ['mvn', ['-U', 'org.openrewrite.maven:rewrite-maven-plugin:run',
      '-Drewrite.recipeArtifactCoordinates=org.openrewrite.recipe:rewrite-migrate-java:RELEASE',
      `-Drewrite.activeRecipes=org.openrewrite.java.migrate.UpgradeToJava${major(to)}`], { cwd: dir }],
    okExit: { dryRun: [0], apply: [0] },
    patchAt: 'target/site/rewrite/rewrite.patch',
    recipeFor: (to) => {
      const m = Number(major(to));
      const have = [8, 11, 17, 21, 25].filter(v => v <= m);
      const pick = have[have.length - 1];
      return { recipe: `org.openrewrite.java.migrate.UpgradeToJava${pick}`,
               exact: pick === m,
               note: pick === m ? null
                 : `there is no UpgradeToJava${m} recipe — the nearest below it is ${pick}. `
                   + `Everything between ${pick} and ${m} is not covered by OpenRewrite.` };
    },
  },

  // ────────────────────────────── GO ──────────────────────────────
  go: {
    name: 'go fix',
    bin: 'go',
    url: 'https://pkg.go.dev/cmd/fix',
    licence: 'BSD (part of the toolchain)',
    install: 'built in — requires Go 1.26 or newer',
    minToolchain: '1.26',
    requires: ['Go >= 1.26 — it was dormant from ~2012 until its 1.26 revival'],
    needsBuild: false,
    covers: [
      'io/ioutil for the 6 of 8 symbols the stdlib annotates with //go:fix inline',
      'x/exp/slices entirely (29 functions)',
      'x/exp/maps for 6 of 8 symbols',
      '~26 modernizer passes (min/max builtins, any, range-over-int)',
    ],
    doesNotTouch: [
      'the go directive, the toolchain line, .go-version',
      'ioutil.ReadDir and ioutil.Discard — no //go:fix marker exists for either',
      'maps.Keys and maps.Values — the stdlib versions return an iter.Seq, so no inline is possible',
      'rand.Seed — there is no semantics-preserving replacement to annotate',
    ],
    hazards: [
      { id: 'idiom-churn',
        what: 'A bare `go fix ./...` runs the modernizer suite as well as the inline migrations.',
        why: 'That rewrites working idiomatic code alongside the actual migration, inflating the '
           + 'diff. Use `go fix -inline ./...` to get the migrations only.' },
      { id: 'gopls-modernize-has-no-ioutil',
        what: 'gopls modernize ships no ioutil pass at all, and the package moved out of internal.',
        why: 'If you reach for gopls expecting ioutil rewriting you will get a silent nothing.' },
    ],
    dryRun: (dir) => ['go', ['fix', '-diff', '-inline', './...'], { cwd: dir }],
    apply:  (dir) => ['go', ['fix', '-inline', './...'], { cwd: dir }],
    okExit: { dryRun: [0], apply: [0] },
  },

  // ───────────────────────────── NODE ─────────────────────────────
  node: {
    name: 'nodejs/userland-migrations',
    bin: 'npx',
    url: 'https://github.com/nodejs/userland-migrations',
    licence: 'MIT',
    install: 'npx codemod @nodejs/<recipe>   (nothing to install)',
    requires: ['npx'],
    needsBuild: false,
    maturity: 'v0.0.1 — the project itself says to be careful before pushing to production',
    covers: [
      'url.parse() -> WHATWG URL, including the .auth/.path/.hostname divergences',
      'crypto.createCipher -> createCipheriv, deriving key and IV',
    ],
    doesNotTouch: [
      'everything else Node removed — process.binding, punycode, _stream_*, writeHeader',
      'AsyncLocalStorage behaviour changes',
      '.nvmrc, engines, Dockerfile, CI',
    ],
    hazards: [
      { id: 'no-recipe-past-24',
        what: 'Recipes exist up to v22-to-v24. There is no v24-to-v26 recipe.',
        why: 'A 24 -> 26 upgrade gets nothing from this engine; it is entirely our catalogue.' },
      { id: 'eslint-is-not-an-alternative',
        what: 'Every relevant eslint-plugin-n / es-x rule is report-only (fixable: undefined), and '
            + "n/no-deprecated-api has exactly ONE `removed:` entry in its whole dataset.",
        why: 'ESLint cannot tell you Node 24 or 26 deleted anything. Do not route users there.' },
    ],
    recipeFor: (from, to) => {
      const f = Number(major(from)), t = Number(major(to));
      const known = [[22, 24]];
      const hit = known.find(([a, b]) => a >= f && b <= t);
      return hit ? { recipe: `@nodejs/v${hit[0]}-to-v${hit[1]}`, exact: true }
                 : { recipe: null, exact: false,
                     note: `no published codemod covers Node ${f} -> ${t}; the catalogue is the only coverage` };
    },
    dryRun: (dir, recipe) => ['npx', ['codemod', recipe, '--dry-run'], { cwd: dir }],
    apply:  (dir, recipe) => ['npx', ['codemod', recipe], { cwd: dir }],
    okExit: { dryRun: [0], apply: [0] },
  },

  // ───────────────────────────── SCALA ─────────────────────────────
  scala: {
    name: 'scalac -rewrite',
    bin: 'scalac',
    url: 'https://docs.scala-lang.org/scala3/guides/migration/',
    licence: 'Apache-2.0',
    install: 'part of the Scala 3 compiler',
    requires: ['the project must COMPILE under -source:3.0-migration'],
    needsBuild: true,
    // The honest ceiling, from the official incompatibility table.
    coverage: '9 of 31 incompatibilities are compiler-rewritable, 5 more via scalafix, 20 manual (~35%)',
    covers: ['syntax dropped in Scala 3 that has a mechanical equivalent'],
    doesNotTouch: [
      'type inference and type checking changes — zero automation exists',
      'macros, which must be rewritten from scratch',
      'build.sbt scalaVersion, CI, or any pin',
    ],
    hazards: [
      { id: 'all-or-nothing',
        what: 'Rewrites are written back only if the whole run is error-free '
            + '(`if (!ctx.reporter.hasErrors) Rewrites.writeBack()`).',
        why: 'One error in one file blocks EVERY rewrite in the run. Fix errors first, iteratively.' },
      { id: 'cheaper-2.13-path',
        what: 'Scala 2.13 has -quickfix:cat=scala3-migration, which needs no SemanticDB.',
        why: 'Cheaper to wire up than scalafix and under-advertised. Prefer it for the 2.13 stage.' },
    ],
    dryRun: () => null,   // no dry-run: the compiler rewrites in place
    apply: (dir) => ['scalac', ['-source:3.0-migration', '-rewrite'], { cwd: dir }],
    okExit: { apply: [0] },
  },

  // ──────────────────────────── ELIXIR ────────────────────────────
  elixir: {
    name: 'mix format --migrate',
    bin: 'mix',
    url: 'https://hexdocs.pm/mix/Mix.Tasks.Format.html',
    licence: 'Apache-2.0',
    install: 'built in — requires Elixir 1.18 or newer',
    minToolchain: '1.18',
    requires: ['Elixir >= 1.18'],
    needsBuild: false,
    covers: ['charlists -> sigils', 'unless -> if !', 'bitstring modifiers'],
    doesNotTouch: ['mix.exs elixir requirement', 'CI, Dockerfile, .tool-versions'],
    hazards: [
      { id: 'keys-off-running-version',
        what: 'It migrates according to the Elixir that is RUNNING, not a target version.',
        why: 'You cannot ask it for a 1.15 -> 1.17 hop. Whatever Elixir is installed decides the '
           + 'result, which makes it non-reproducible across machines unless the toolchain is pinned.' },
    ],
    companion: { name: 'adobe/elixir-styler', licence: 'Apache-2.0',
                 covers: '1.15 -> 1.19 deprecations beyond what mix format handles' },
    dryRun: (dir) => ['mix', ['format', '--migrate', '--check-formatted'], { cwd: dir }],
    apply:  (dir) => ['mix', ['format', '--migrate'], { cwd: dir }],
    okExit: { dryRun: [0, 1], apply: [0] },
  },

  // ───────────────────────────── DENO ─────────────────────────────
  deno: {
    name: 'deno lint --fix',
    bin: 'deno',
    url: 'https://docs.deno.com/runtime/reference/cli/lint/',
    licence: 'MIT',
    install: 'built into Deno',
    requires: [],
    needsBuild: false,
    covers: ['the window global (no-window / no-window-prefix)'],
    doesNotTouch: [
      'Deno.run, Deno.Buffer/Reader/Writer, resource-id APIs, Deno.customInspect',
      'deno.json, CI, Dockerfile',
    ],
    hazards: [
      { id: 'mostly-report-only',
        what: 'Only 9 of 121 lint rules implement a fix, and no-deprecated-deno-api has NO fix code.',
        why: 'Every Deno 1 -> 2 API removal except the window global is report-only. '
           + 'The catalogue is the real coverage here.' },
    ],
    dryRun: (dir) => ['deno', ['lint'], { cwd: dir }],
    apply:  (dir) => ['deno', ['lint', '--fix'], { cwd: dir }],
    okExit: { dryRun: [0, 1], apply: [0, 1] },
  },
};

/** Languages with no credible rewriter — our catalogue is the only coverage. */
export const NO_ENGINE = {
  ruby:   'RuboCop TargetRubyVersion gates STYLE and runs the wrong way for this: 45 cops are '
        + 'minimum_target_ruby_version (modernisation), only 4 are maximum_ (breakage). Setting '
        + 'TargetRubyVersion: 3.4 silently DISABLES Lint/ItWithoutArgumentsInBlock, the one cop '
        + 'catching a real 3.4 break. ruby-next transpiles downward. Nothing rewrites upward.',
  rust:   'cargo fix --edition passes --cap-lints=allow and force-warns only the edition lint group, '
        + 'so it fixes edition lints and nothing else. mem::uninitialized, mem::zeroed and try! have '
        + 'no machine-applicable fix anywhere. On an already-2024 crate it is a literal no-op.',
  dotnet: '0 of 66 SYSLIB obsoletions ship a CodeFixProvider — they are compiler diagnostics from '
        + '[Obsolete(DiagnosticId=…)], not analyzers, so a fixer is architecturally impossible. '
        + 'The .NET Upgrade Assistant is deprecated; its replacement is an LLM behind a paid Copilot '
        + 'subscription. Only SYSLIB1045 (Regex) and SYSLIB1054 (DllImport) have real fixers.',
  erlang: 'rebar3 upgrade is dependencies-only. xref DeprecatedFunctions is report-only (useful as a '
        + 'detector input). erlfmt explicitly guarantees AST equivalence. Wrangler last released 2015.',
  kotlin: 'There is no -Xrewrite flag and JetBrains shipped no K2 source migrator. ktlint --format '
        + 'and detekt --auto-correct are style-only. rewrite-kotlin has no language-version recipes.',
  perl:   'perlcritic has no --fix. And the breakage list is smaller than it looks: smartmatch removal '
        + 'was indefinitely postponed, and the apostrophe separator was removed then reinstated.',
  bun:    'No migration rewriter exists for Bun itself, and none is likely soon: Bun has shipped no '
        + 'removals of its own on the scale that needs one. What DOES break Bun code is the Node API '
        + 'surface it implements, so the Node catalogue is applied to Bun sources via INHERITS in '
        + 'breaking.mjs, and the nodejs/userland-migrations codemods are usable on it directly.',
};

/**
 * Is this language's engine usable here, and what exactly would run?
 * Never installs anything — an absent engine still returns the full plan.
 */
export function engineStatus(lang, dir, from, to) {
  const e = ENGINES[lang];
  if (!e) return { lang, engine: null, whyNone: NO_ENGINE[lang] || 'no engine is registered for this language' };

  const localPath = e.localBin ? join(dir, e.localBin) : null;
  const local = localPath && existsSync(localPath);
  const global = have(e.bin) || (e.altBin ? have(e.altBin) : false);
  const present = !!(local || global);

  const out = {
    lang, engine: e.name, url: e.url, licence: e.licence, present,
    foundAt: local ? e.localBin : global ? `${e.bin} (on PATH)` : null,
    installWith: present ? null : e.install,
    covers: e.covers,
    doesNotTouch: e.doesNotTouch,
    hazards: e.hazards || [],
    needsBuild: !!e.needsBuild,
    maturity: e.maturity,
    coverage: e.coverage,
    companion: e.companion,
  };

  // version-gated engines: being on PATH is not the same as being usable
  if (e.minToolchain && present) {
    const v = run(e.bin, ['version'], { cwd: dir, timeout: 10000 });
    const found = (String(v.stdout || '').match(/(\d+\.\d+(\.\d+)?)/) || [])[1];
    if (found && cmpVer(found, e.minToolchain) < 0) {
      out.present = false;
      out.tooOld = `${e.bin} ${found} is installed, but this needs >= ${e.minToolchain}`;
    }
  }

  // which recipe, and is it an exact match for the target?
  if (e.recipeFor) Object.assign(out, e.recipeFor(from, to) || {});

  if (e.configFile) {
    out.configFile = e.configFile;
    out.config = e.config(from, to);
    out.configExists = existsSync(join(dir, e.configFile));
  }
  if (e.patchAt) out.patchAt = e.patchAt;
  if (e.overlapsOurPins) out.overlapsOurPins = true;
  return out;
}

const cmpVer = (a, b) => {
  const A = String(a).split('.').map(Number), B = String(b).split('.').map(Number);
  for (let i = 0; i < Math.max(A.length, B.length); i++) {
    const x = A[i] || 0, y = B[i] || 0;
    if (x !== y) return x - y;
  }
  return 0;
};

/** Every language's engine story at once — for doctor.mjs and the report. */
export function engineOverview() {
  const rows = [];
  for (const [lang, e] of Object.entries(ENGINES))
    rows.push({ lang, engine: e.name, present: have(e.bin), url: e.url, licence: e.licence });
  for (const [lang, why] of Object.entries(NO_ENGINE))
    rows.push({ lang, engine: null, why });
  return rows;
}
