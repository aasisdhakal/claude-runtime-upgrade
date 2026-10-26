// Runtime-pin rewriting. Each rule finds a version declaration and produces the
// replacement. Rules are pure: they return {file, before, after, rule} and never
// touch disk, so dry-run and apply share exactly one code path.
import { join, existsSync, readText, readdirSync } from './io.mjs';

const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Every pin rule is either a PIN or a FLOOR.
 *
 *   PIN    what this checkout RUNS: .nvmrc, a Dockerfile tag, .tool-versions,
 *          config.platform.php. Moving it affects only this repo.
 *   FLOOR  the MINIMUM a consumer needs: engines.node, require.php,
 *          requires-python, required_ruby_version, rust-version (MSRV), the go
 *          directive. For a published library this is its SUPPORT CONTRACT.
 *
 * Raising a floor is a semver-breaking change to everyone downstream, and it
 * breaks the repo's own CI matrix the moment CI still tests an older version.
 * Against four real libraries this tool did exactly that: fastapi >=3.10 ->
 * >=3.15, jekyll >= 2.7 -> >= 4.0, laravel ^8.3 -> ^8.5, prettier >=22 ->
 * ">=26.12.1 <27". Every one broke that project's own test matrix.
 *
 * So floors are NOT written by default. `--raise-floor` opts in.
 */
export const RULE_KIND = {
  // floors — a consumer-facing minimum
  'engines.node': 'floor', 'add engines.node': 'floor',
  'require.php': 'floor', 'add require.php': 'floor',
  'requires-python': 'floor', 'python_requires': 'floor',
  'gemspec required_ruby_version': 'floor',
  'rust-version (MSRV)': 'floor',
  'go directive': 'floor',
  'go toolchain': 'pin', '.go-version': 'pin',
  'maven.compiler.release': 'floor', 'gradle compatibility': 'floor',
  'JavaLanguageVersion': 'floor', 'jvmToolchain': 'floor',
  'elixir requirement': 'floor', 'minimum_otp_vsn': 'floor',
  'Makefile.PL perl requirement': 'floor', 'requires perl': 'floor',
  'kotlin plugin version': 'floor', 'scalaVersion': 'floor',
  'deno.json deno field': 'floor', 'engines.bun': 'floor',
};
export function ruleKind(rule) { return RULE_KIND[rule] || 'pin'; }

/**
 * Old distro variants that cannot host a current runtime. Node 24+ musl builds
 * require Alpine >= 3.20; Debian buster/stretch are long EOL.
 */
const SUFFIX_MAP = {
  '-alpine3.17': '-alpine3.22', '-alpine3.18': '-alpine3.22',
  '-alpine3.19': '-alpine3.22', '-alpine3.20': '-alpine3.22',
  '-buster': '-bookworm', '-stretch': '-bookworm', '-bullseye': '-bookworm',
  '-buster-slim': '-bookworm-slim', '-bullseye-slim': '-bookworm-slim',
};
export const mapSuffix = sfx => SUFFIX_MAP[sfx] ?? sfx;

/** Replace the version inside a Docker FROM line, preserving registry + suffix. */
function dockerRewrite(text, imageNames, target, suffixMap = SUFFIX_MAP) {
  const re = new RegExp(`(^[ \\t]*FROM[ \\t]+(?:--\\S+[ \\t]+)*\\S*?(?:${imageNames.join('|')})[:@])([^\\s]+)`, 'gim');
  return text.replace(re, (m, head, tag) => {
    // keep the variant suffix: 20.11.1-alpine3.19 -> 24.22.1-alpine3.22
    const suffix = tag.replace(/^v?[\d.]+/, '');
    const mapped = suffixMap[suffix] ?? suffix;
    return head + target + mapped;
  });
}

/**
 * CI workflow files, and the keys inside them that name a runtime version.
 * A pinned runtime that CI does not also move is the single most common way an
 * upgrade "passes" locally and then builds on the old version forever.
 */
const CI_FILES = [
  '.github/workflows', '.gitlab-ci.yml', 'bitbucket-pipelines.yml', 'azure-pipelines.yml',
  '.circleci/config.yml', 'buildspec.yml', 'buildspec.yaml', 'Jenkinsfile',
];
const CI_KEY = {
  node: 'node', php: 'php', python: 'python', ruby: 'ruby', go: 'go',
  java: 'java', dotnet: 'dotnet', rust: 'rust', deno: 'deno', bun: 'bun',
  elixir: 'elixir', erlang: 'otp', kotlin: 'kotlin', scala: 'scala', perl: 'perl',
};
const CI_IMAGE = {
  node: ['node'], php: ['php'], python: ['python'], ruby: ['ruby'], go: ['golang'],
  java: ['eclipse-temurin', 'amazoncorretto', 'openjdk'], dotnet: ['dotnet/sdk'],
  rust: ['rust'], deno: ['denoland/deno'], bun: ['oven/bun'], elixir: ['elixir'],
  erlang: ['erlang'], kotlin: ['kotlin'], scala: [], perl: ['perl'],
};

/** Every CI file under a directory, flattened. */
export function ciFiles(dir) {
  const out = [];
  for (const g of CI_FILES) {
    const p = join(dir, g);
    if (!existsSync(p)) continue;
    let entries = [p];
    try { const kids = readdirSync(p); if (kids.length) entries = kids.map(n => join(p, n)); } catch {}
    for (const f of entries) if (/\.(ya?ml)$|Jenkinsfile$/.test(f)) out.push(f);
  }
  return out;
}

/**
 * Rewrite runtime versions inside CI config. Deliberately conservative:
 *   - templated values (${{ matrix.x }}) are left alone
 *   - a MATRIX of versions is EXTENDED with the target, never collapsed —
 *     dropping the old version is how you lose the only test that proves the
 *     migration window still works on what production runs today
 */
// What each setup-* action actually accepts in its version input.
// setup-php resolves only major.minor — a full patch like "8.5.12" is not a
// build it publishes, and the job fails to provision. setup-node, setup-go and
// setup-ruby take full semver, where pinning the patch is the better answer.
const CI_INPUT_PRECISION = {
  php: 'major.minor', python: 'major.minor', java: 'major', dotnet: 'major.minor',
};
const ciInputVersion = (lang, target) =>
  CI_INPUT_PRECISION[lang] === 'major'      ? (target.match(/^\d+/) || [target])[0]
: CI_INPUT_PRECISION[lang] === 'major.minor' ? mm(target)
: target;

const cmpLoose = (a, b) => {
  const A = String(a).split('.'), B = String(b).split('.');
  for (let i = 0; i < Math.max(A.length, B.length); i++) {
    const x = parseInt(A[i] ?? '0', 10) || 0, y = parseInt(B[i] ?? '0', 10) || 0;
    if (x !== y) return x - y;
  }
  return 0;
};

export function planCiEdits(lang, dir, target) {
  const key = CI_KEY[lang];
  if (!key) return [];
  const images = CI_IMAGE[lang] || [];
  const edits = [], skipped = [];

  // A value the CI system substitutes at run time is not a version. Writing
  // into one produced `cimg/node:26.12.1<< pipeline.parameters.node-version >>`
  // — an image reference that cannot resolve.
  const templated = v => /\$\{\{|\$\{|\$\(|<<|%\{|\{\{/.test(v);

  // The spread is REPO-WIDE, not per-file. symfony keeps its lowest-supported
  // jobs in separate workflow files (phpunit-bridge.yml pins 8.1,
  // json-schema.yml pins 8.2, static-analysis.yml pins 8.2) — each file looks
  // single-valued, so a per-file check rewrote all of them and deleted every
  // low-end job in the repo. Only the HIGHEST version is "the current job";
  // the ones below it are the compatibility matrix.
  const scalarReFor = () => new RegExp(
    `(^[ \\t]*(?:-[ \\t]*)?${key}[-_]?version[ \\t]*:[ \\t]*["']?)([0-9][0-9.xX]*)(["']?)`, 'gmi');
  const files = ciFiles(dir).map(f => ({ f, before: readText(f) })).filter(x => x.before != null);
  const everyScalar = files.flatMap(x => [...x.before.matchAll(scalarReFor())].map(m => m[2]));
  const distinctRepoWide = [...new Set(everyScalar)];
  const highest = distinctRepoWide.slice().sort(cmpLoose).pop();

  for (const { f, before } of files) {
    let after = before;

    // ── setup-* action inputs: `node-version: 20.11.1` ──
    const scalarRe = scalarReFor();
    const here = [...before.matchAll(scalarRe)].map(m => m[2]);
    const lowOnes = here.filter(v => v !== highest);
    if (distinctRepoWide.length > 1 && lowOnes.length) {
      skipped.push({ file: f.slice(dir.length + 1),
                     reason: 'a lower version than the repo\'s newest CI job — a deliberate lowest-supported job, not drift',
                     versions: [...new Set(lowOnes)],
                     advice: `add ${ciInputVersion(lang, target)} as another job; collapsing this one deletes the only proof the declared floor still works` });
    }
    // rewrite only the occurrences that name the repo's current newest version
    after = after.replace(scalarReFor(), (m, head, v, tail) =>
      (templated(v) || v !== highest) ? m : head + ciInputVersion(lang, target) + tail);

    // ── container images ──
    for (const img of images) {
      // Anchor the name: an unanchored `php` matched `dunglas/frankenphp:1.12.1-php8.4`
      // and replaced FrankenPHP's own version with a PHP one.
      const nameRe = img.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      after = after.replace(
        new RegExp(`((?:image|container)\\s*:\\s*["']?(?:[\\w.-]+\\/)*${nameRe}[:@])([^\\s"']+)`, 'gi'),
        (m, head, tag) => templated(tag) ? m : head + target + mapSuffix(tag.replace(/^v?[\d.]+/, '')));
    }
    if (after !== before)
      edits.push({ file: f.slice(dir.length + 1), path: f, rule: 'CI runtime version', before, after });
  }
  edits.skipped = skipped;
  return edits;
}


/** Matrix entries that still name the OLD version — keep them, and say why. */
export function ciMatrixAdvice(lang, dir, from, target) {
  const key = CI_KEY[lang];
  const hits = [];
  for (const f of ciFiles(dir)) {
    const t = readText(f) || '';
    const m = t.match(new RegExp(`${key}[-_]?version\\s*:\\s*\\[([^\\]]+)\\]`, 'i'));
    if (m) hits.push({ file: f.slice(dir.length + 1), matrix: m[1].replace(/["']/g, '').trim() });
  }
  return hits.length ? {
    matrices: hits,
    advice: `Keep ${from} in the matrix alongside ${target} for the whole migration window. `
          + 'Testing only the new version is how a compatibility fix silently breaks the version still in production.',
  } : null;
}

/** Build/runtime configuration that should move with the runtime. */
export function planConfigEdits(lang, dir, target) {
  const edits = [];
  const push = (file, rule, fn) => {
    const path = join(dir, file);
    if (!existsSync(path)) return;
    const before = readText(path); if (before == null) return;
    const after = fn(before);
    if (after !== before) edits.push({ file, path, rule, before, after });
  };
  if (lang === 'node') {
    const major = Number(target.split('.')[0]);
    // tsconfig target should not lag the runtime by generations
    const tsTarget = major >= 24 ? 'ES2023' : major >= 22 ? 'ES2023' : 'ES2022';
    push('tsconfig.json', `tsconfig target -> ${tsTarget}`,
      t => t.replace(/("target"\s*:\s*")(ES\d+|es\d+|ESNext)(")/i, `$1${tsTarget}$3`));
    // engines are advisory in npm unless engine-strict is set
    push('.npmrc', 'engine-strict=true',
      t => /engine-strict/.test(t) ? t.replace(/engine-strict\s*=.*/i, 'engine-strict=true') : t.trimEnd() + '\nengine-strict=true\n');
  }
  if (lang === 'php') {
    push('composer.json', 'config.platform.php',
      t => t.replace(/("platform"\s*:\s*\{[^}]*?"php"\s*:\s*")([^"]*)(")/s, `$1${target}$3`));
  }
  return edits;
}


/**
 * Version precision matters, and getting it wrong is destructive.
 *
 *  - `go 1.27` is the conventional directive; `go 1.27.3` over-specifies.
 *  - composer `"php": "^8.5.12"` constrains consumers to a PATCH; `^8.5` is meant.
 *  - elixir `"~> 1.20.4"` means >=1.20.4 <1.21, far tighter than `~> 1.20`.
 * Writing a full patch version into a CONSTRAINT silently narrows it.
 */
const mm = v => String(v).split('.').slice(0, 2).join('.');   // 1.27.3 -> 1.27
const maj = v => String(v).split('.')[0];                      // 27.0.1  -> 27

export const PIN_RULES = {
  node: (target) => [
    { file: 'package.json', rule: 'engines.node',
      // an upper cap makes the package refuse every FUTURE runtime; prettier
      // would have rejected Node 27 forever. A floor is a floor.
      // `>= 22 <25` must not become `>=26.12`: the cap was deliberate, and the
      // new floor would sit above it. A disjunction cannot be rewritten at all.
      edit: t => t.replace(/("engines"\s*:\s*\{[^}]*?"node"\s*:\s*")([^"]*)(")/s,
        (m, head, v, tail) => isCompoundConstraint(v) ? m : head + `>=${mm(target)}` + tail) },
    { file: '.nvmrc', rule: '.nvmrc', edit: () => `v${target}\n` },
    { file: '.node-version', rule: '.node-version', edit: () => `${target}\n` },
    { file: '.tool-versions', rule: '.tool-versions', edit: t => t.replace(/^nodejs\s+\S+/mi, `nodejs ${target}`) },
    { file: 'Dockerfile', rule: 'Dockerfile FROM',
      edit: t => dockerRewrite(t, ['node'], target, SUFFIX_MAP) },
  ],
  php: (target) => [
    { file: 'composer.json', rule: 'require.php',
      // `>=8.1.0 <8.3 || ~8.4.2` collapsed to `^8.5` destroys the disjunction
      // and silently changes which PHP versions the package claims to support.
      edit: t => t.replace(/("require"\s*:\s*\{[^}]*?"php"\s*:\s*")([^"]*)(")/s,
        (m, head, v, tail) => isCompoundConstraint(v) ? m : head + `^${mm(target)}` + tail) },
    { file: '.php-version', rule: '.php-version', edit: () => `${target}\n` },
    { file: '.tool-versions', rule: '.tool-versions', edit: t => t.replace(/^php\s+\S+/mi, `php ${target}`) },
    { file: 'Dockerfile', rule: 'Dockerfile FROM', edit: t => dockerRewrite(t, ['php'], target) },
  ],
  go: (target) => [
    // The `go` directive is a FLOOR (and since 1.21 it also drives toolchain
    // selection), so it is declined by default like every other floor. But Go's
    // actual PINS had no rules at all, which meant a default `remediate go`
    // rewrote NOTHING on a repo like kubernetes that pins `.go-version`.
    { file: 'go.mod', rule: 'go directive', edit: t => t.replace(/^go\s+[\d.]+/m, `go ${mm(target)}`) },
    { file: 'go.mod', rule: 'go toolchain',
      // `toolchain` is the pin. Left behind after a floor raise it contradicts
      // the directive: `go.mod requires go >= 1.22 (running go1.21.13)`.
      edit: t => t.replace(/^toolchain[ \t]+go[\d.]+[ \t]*$/m, `toolchain go${target}`) },
    // kubernetes' real pin, consumed by actions/setup-go via `go-version-file`
    { file: '.go-version', rule: '.go-version', edit: () => `${target}\n` },
    { file: '.tool-versions', rule: '.tool-versions', edit: t => t.replace(/^golang\s+\S+/mi, `golang ${target}`) },
    { file: 'Dockerfile', rule: 'Dockerfile FROM', edit: t => dockerRewrite(t, ['golang'], target) },
  ],
  python: (target) => [
    { file: 'setup.cfg', rule: 'python_requires',
      edit: t => t.replace(/^(\s*python_requires\s*=\s*)(.*)$/m,
        (m, head, v) => head + raiseLowerBound(v, mm(target))) },
    { file: 'Pipfile', rule: 'Pipfile python_version',
      edit: t => t.replace(/(python_version\s*=\s*")([^"]*)(")/, `$1${target}$3`) },
    { file: 'tox.ini', rule: 'tox basepython',
      // `basepython` names an EXECUTABLE, not a version. Writing the full patch
      // produced `basepython = python3.15.2` — no such binary exists on any
      // system, so every tox env died. It must be `python3.15`.
      // Also:
      //   `basepython = python3`   is deliberate "whatever python3 is" (the
      //                            lint/docs/format envs) — leave it alone
      //   `basepython = python3.14t` is the free-threaded build; keep the `t`
      edit: t => t.replace(/(^[ \t]*basepython[ \t]*=[ \t]*python)(\d+\.\d+(?:\.\d+)?)(t?)\b/gm,
                           (m, head, _v, free) => head + mm(target) + free) },

    { file: 'pyproject.toml', rule: 'requires-python',
      edit: t => t.replace(/^(\s*requires-python\s*=\s*")([^"]*)(")/m,
        (m, head, v, tail) => head + raiseLowerBound(v, mm(target)) + tail) },
    { file: '.python-version', rule: '.python-version', edit: () => `${target}\n` },
    { file: 'runtime.txt', rule: 'runtime.txt', edit: () => `python-${target}\n` },
    { file: '.tool-versions', rule: '.tool-versions', edit: t => t.replace(/^python\s+\S+/mi, `python ${target}`) },
    { file: 'Dockerfile', rule: 'Dockerfile FROM', edit: t => dockerRewrite(t, ['python'], target) },
  ],
  ruby: (target) => [
    { file: null, glob: /\.gemspec$/, rule: 'gemspec required_ruby_version',
      edit: t => t.replace(/(required_ruby_version\s*=\s*["'][^\d]*)([\d.]+)/, `$1${mm(target)}`) },

    { file: 'Gemfile', rule: 'Gemfile ruby', edit: t => t.replace(/^(\s*ruby\s+["'])([^"']+)(["'])/m, `$1${target}$3`) },
    { file: '.ruby-version', rule: '.ruby-version', edit: () => `${target}\n` },
    { file: '.tool-versions', rule: '.tool-versions', edit: t => t.replace(/^ruby\s+\S+/mi, `ruby ${target}`) },
    { file: 'Dockerfile', rule: 'Dockerfile FROM', edit: t => dockerRewrite(t, ['ruby'], target) },
  ],
  rust: (target) => [
    { file: 'rust-toolchain', rule: 'rust-toolchain', edit: () => `${target}\n` },

    { file: 'Cargo.toml', rule: 'rust-version (MSRV)',
      // MSRV is declared major.minor by convention; a patch MSRV helps nobody
      edit: t => t.replace(/^(\s*rust-version\s*=\s*")([^"]*)(")/m, `$1${mm(target)}$3`) },
    { file: 'rust-toolchain.toml', rule: 'toolchain channel',
      edit: t => t.replace(/(channel\s*=\s*")([^"]*)(")/, `$1${target}$3`) },
    { file: 'Dockerfile', rule: 'Dockerfile FROM', edit: t => dockerRewrite(t, ['rust'], target) },
  ],
  java: (target) => [
    { file: 'build.gradle', rule: 'gradle compatibility',
      edit: t => t.replace(/((?:source|target)Compatibility\s*=?\s*['"]?(?:JavaVersion\.VERSION_)?)([\d._]+)/g, `$1${target}`) },
    { file: 'build.gradle.kts', rule: 'JavaLanguageVersion',
      edit: t => t.replace(/(JavaLanguageVersion\.of\()(\d+)(\))/g,
        (m, a, _v, b) => a + (String(target).match(/^\d+/) || [target])[0] + b) },
    // .java-version (jenv) accepts a full version; keep the author's precision
    { file: '.java-version', rule: '.java-version',
      edit: t => { const had = (t.trim().match(/\./g) || []).length;
                   return (had >= 2 ? target : had === 1 ? mm(target) : (String(target).match(/^\d+/) || [target])[0]) + '\n'; } },

    { file: 'pom.xml', rule: 'maven.compiler.release',
      // Two bugs lived here.
      //  1. Only `release` and `java.version` moved, leaving
      //     `maven.compiler.source` and `.target` behind — a POM that
      //     disagrees with itself about which Java it compiles for.
      //  2. `${target}` is a full version (21.0.9), but every one of these
      //     properties takes a release NUMBER. `<maven.compiler.release>21.0.9`
      //     is not a value javac accepts.
      edit: t => {
        const major = (String(target).match(/^\d+/) || [target])[0];
        let out = t;
        for (const prop of ['maven.compiler.release', 'maven.compiler.source', 'maven.compiler.target'])
          out = out.replace(new RegExp(`(<${prop.replace(/\./g, '\\.')}>)\\s*[\\d.]+\\s*(</)`, 'g'),
                            `$1${major}$2`);
        // <java.version> is conventionally the release number too
        out = out.replace(/(<java\.version>)\s*[\d.]+\s*(<\/)/g, `$1${major}$2`);
        return out;
      } },
    { file: 'build.gradle.kts', rule: 'jvmToolchain',
      // jvmToolchain takes an Int; jvmToolchain(21.0.9) does not compile
      edit: t => t.replace(/jvmToolchain\((\d+)\)/g,
        () => `jvmToolchain(${(String(target).match(/^\d+/) || [target])[0]})`) },
    { file: '.sdkmanrc', rule: '.sdkmanrc',
      // SDKMAN identifiers are `<version>-<distro>`: 25.0.4-librca, 21.0.2-tem.
      // Writing a bare `java=21` leaves an identifier SDKMAN cannot resolve and
      // silently discards the distribution the project chose. Keep the distro,
      // and keep the author's precision: a 3-part version stays 3-part.
      edit: t => t.replace(/^(java=)(\d+(?:\.\d+){0,2})(-[A-Za-z0-9.]+)?\s*$/mi, (m, head, ver, distro) => {
        const parts = ver.split('.').length;
        const tgt = parts >= 3 ? target
                  : parts === 2 ? mm(target)
                  : (target.match(/^\d+/) || [target])[0];
        return `${head}${tgt}${distro || ''}`;
      }) },
    { file: 'Dockerfile', rule: 'Dockerfile FROM',
      edit: t => dockerRewrite(t, ['eclipse-temurin', 'amazoncorretto', 'openjdk'], target) },
  ],
  dotnet: (target) => {
    // global.json pins a full SDK build (9.0.100); container tags are MAJOR.MINOR (9.0)
    const tag = (target.match(/^\d+\.\d+/) || [target])[0];
    return [
      { file: 'global.json', rule: 'sdk.version',
        // global.json pins an SDK BUILD (10.0.100, 9.0.400); the EOL feed
        // reports a RUNTIME version (10.0.13). They are different number
        // spaces. Two rules follow from that:
        //
        //  1. NEVER move it backwards. roslyn pins SDK 11.0.100-rc and the
        //     current runtime release is 10.0.13, so a naive rewrite emitted
        //     `-"11.0.100-rc.1" +"10.0.100"` — a downgrade presented as an
        //     upgrade, and fatal under roslyn's `rollForward: patch`.
        //  2. NEVER fabricate a feature band. `.100` is the first band, but a
        //     project may legitimately require `.200` or `.400`; inventing one
        //     pins a build that may not exist. Carry the existing band over.
        edit: t => {
          const cur = (t.match(/"version"\s*:\s*"([^"]*)"/) || [])[1] || '';
          if (!cur) return t;
          if (mm(cur) === mm(target)) return t;                 // same band: leave it
          const curMM = mm(cur).split('.').map(Number), tgtMM = mm(target).split('.').map(Number);
          const forward = tgtMM[0] > curMM[0] || (tgtMM[0] === curMM[0] && tgtMM[1] > curMM[1]);
          if (!forward) return t;                               // the SDK is already ahead
          const band = (cur.match(/^\d+\.\d+\.(\d+)/) || [])[1] || '100';
          return t.replace(/("version"\s*:\s*")([^"]*)(")/, `$1${mm(target)}.${band}$3`);
        } },
      { file: 'Dockerfile', rule: 'Dockerfile FROM',
        edit: t => dockerRewrite(t, ['dotnet/sdk', 'dotnet/runtime', 'dotnet/aspnet'], tag) },
    ];
  },
  deno:   (t) => [
    { file: 'deno.json', rule: 'deno.json deno field', edit: x => x.replace(/("deno"\s*:\s*")([^"]*)(")/, `$1${t}$3`) },
    { file: '.deno-version', rule: '.deno-version', edit: () => `${t}\n` },
    { file: 'Dockerfile', rule: 'Dockerfile FROM', edit: x => dockerRewrite(x, ['denoland/deno'], t) }],
  bun:    (t) => [
    { file: '.bun-version', rule: '.bun-version', edit: () => `${t}\n` },
    { file: 'package.json', rule: 'engines.bun',
      edit: x => x.replace(/("engines"\s*:\s*\{[^}]*?"bun"\s*:\s*")([^"]*)(")/s, `$1>=${t}$3`) },
    { file: 'Dockerfile', rule: 'Dockerfile FROM', edit: x => dockerRewrite(x, ['oven/bun'], t) }],
  elixir: (t) => [{ file: 'mix.exs', rule: 'elixir requirement',
    edit: x => x.replace(/(elixir:\s*")[^"]*(")/, `$1~> ${mm(t)}$2`) }],
  erlang: (t) => [
    { file: 'rebar.config', rule: 'minimum_otp_vsn', edit: x => x.replace(/(minimum_otp_vsn\s*,\s*")[^"]*(")/, `$1${t}$2`) },
    // erlang.mk projects pin OTP in the Makefile, not rebar.config
    { file: 'Makefile', rule: 'AUTO_CI_OTP',
      edit: x => x.replace(/(AUTO_CI_OTP\s*\?*=\s*OTP-(?:LATEST-)?)(\d+)/, `$1${String(t).split('.')[0]}`) }],
  kotlin: (t) => [
    { file: 'build.gradle.kts', rule: 'kotlin plugin version',
      edit: x => x.replace(/(kotlin\(["']jvm["']\)\s*version\s*["'])[^"']*(["'])/, `$1${t}$2`) },
    { file: 'gradle/libs.versions.toml', rule: 'version catalog kotlin',
      edit: x => x.replace(/^(\s*kotlin\s*=\s*")([^"]*)(")/m, `$1${t}$3`) },
    { file: 'gradle.properties', rule: 'kotlin.version',
      edit: x => x.replace(/^(kotlin\.version\s*=\s*)(\S+)/m, `$1${t}`) }],
  scala:  (t) => [
    { file: 'build.sbt', rule: 'scalaVersion',
      // sbt files usually bind scalaVersion to a val, so rewrite the val too
      edit: x => {
        // `val Scala213 = "2.13.18"` is a CROSS-BUILD definition. Rewriting it to
        // a 3.x version silently destroys the 2.13 build; the name encodes the
        // series it holds. Only touch a val whose series matches the target.
        const series = String(t).split('.').slice(0, 2).join('.');
        let out = x.replace(/(scalaVersion\s*:=\s*")[^"]*(")/, `$1${t}$2`);
        const ident = (x.match(/scalaVersion\s*:=\s*([A-Za-z_]\w*)/) || [])[1];
        if (ident) {
          const def = x.match(new RegExp(`val\\s+${ident}\\s*=\\s*"([^"]*)"`));
          const holds = def ? def[1].split('.').slice(0, 2).join('.') : null;
          const sameSeries = holds && holds.split('.')[0] === series.split('.')[0];
          if (sameSeries) out = out.replace(new RegExp(`(val\\s+${ident}\\s*=\\s*")[^"]*(")`), `$1${t}$2`);
        }
        return out;
      } },
    { file: '.scala-version', rule: '.scala-version', edit: () => `${t}\n` }],
  perl:   (t) => [
    { file: 'cpanfile', rule: 'requires perl', edit: x => x.replace(/(requires\s+["']perl["']\s*,\s*["']?)[\d._v]+/, `$1${t}`) },
    { file: 'Makefile.PL', rule: 'Makefile.PL perl requirement',
      // Perl writes 5.44 as "5.044" in numeric form and "v5.44" as a v-string;
      // rewriting 5.016 to 5.44.0 produces a literal the toolchain mis-reads.
      edit: x => {
        const [a, b] = String(t).split('.');
        const padded = `${a}.${String(b).padStart(3, '0')}`;          // 5.44 -> 5.044
        return x
          .replace(/(MIN_PERL_VERSION\s*=>\s*["']?)[\d._]+/, `$1${padded}`)
          .replace(/(requires\s*=>\s*\{[^}]*?perl\s*=>\s*["'])[\d._]+(["'])/s, `$1${padded}$2`)
          .replace(/^(use\s+)5\.[\d._]+(\s*;)/m, `$1${padded}$2`);
      } },
    { file: 'Build.PL', rule: 'requires perl',
      edit: x => x.replace(/(["']perl["']\s*=>\s*["']?)[\d._v]+/, `$1${t}`) },
    { file: '.perl-version', rule: '.perl-version', edit: () => `${t}\n` }],
};

/**
 * Compute every pin edit for a target. Pure: reads files, writes nothing.
 * `raiseFloor` opts in to rewriting consumer-facing minimums; without it they
 * are returned under `declinedFloors` with the reason.
 */
export function planPinEdits(lang, dir, target, { raiseFloor = false } = {}) {
  const rules = PIN_RULES[lang];
  if (!rules) return { edits: [], declinedFloors: [], compoundConstraints: [], unsupported: true };
  const declinedFloors = [], compoundConstraints = [];
  // Several rules can target the SAME file — go.mod carries both the `go`
  // directive and the `toolchain` line. Each rule used to read the original
  // text independently, so the writes raced and the last one won: the directive
  // edit vanished and go.mod was left self-contradictory. Accumulate per file,
  // then emit one edit per file.
  const perFile = new Map();   // file -> { path, text, rules[], original }

  for (const r of rules(target)) {
    // A glob rule must match EVERY file, not the first one in the top
    // directory. rails ships 13 gemspecs; `readdirSync(dir).find(...)` edited
    // rails.gemspec and left the other 12 declaring a different minimum.
    const files = r.file ? [r.file] : r.glob ? globFiles(dir, r.glob) : [];
    for (const file of files) {
      const path = join(dir, file);
      if (!existsSync(path)) continue;
      if (!perFile.has(file)) {
        const original = readText(path);
        if (original == null) continue;
        perFile.set(file, { path, text: original, original, rules: [], kinds: new Set() });
      }
      const st = perFile.get(file);
      const after = r.edit(st.text);
      const kind = ruleKind(r.rule);

      if (after === st.text) {
        // A compound constraint is deliberately left alone by the edit — but
        // silence reads as "nothing to do here". Say what is there.
        if (kind === 'floor' && raiseFloor) {
          const cur = currentConstraint(st.original, r.rule);
          if (cur && isCompoundConstraint(cur))
            compoundConstraints.push({ file, rule: r.rule, constraint: cur,
              why: 'this constraint has more than one term — a cap, an exclusion or a disjunction. '
                 + 'No mechanical rewrite preserves what it means, so nothing was changed.',
              decide: `edit it by hand if ${target} really belongs in that range` });
        }
        continue;
      }
      if (kind === 'floor' && !raiseFloor) {
        declinedFloors.push({ file, rule: r.rule, kind,
          would: previewLine(st.text, after),
          why: 'this is a consumer-facing MINIMUM, not what this checkout runs. Raising it is a '
             + 'semver-breaking change to the support contract and usually breaks the repo\'s own '
             + 'CI matrix. Pass --raise-floor if that is genuinely intended.' });
        continue;
      }
      st.text = after;                       // chain: the next rule sees this
      st.rules.push(r.rule);
      st.kinds.add(kind);
    }
  }

  const edits = [];
  for (const [file, st] of perFile) {
    if (st.text === st.original) continue;
    edits.push({ file, path: st.path, rule: st.rules.join(' + '),
                 rules: st.rules, kind: st.kinds.has('floor') ? 'floor' : 'pin',
                 before: st.original, after: st.text });
  }
  return { edits, declinedFloors, compoundConstraints, unsupported: false };
}

/** Every file under `dir` whose name matches, recursively, shallow-first. */
function globFiles(dir, re, depth = 3, base = '') {
  const out = [];
  let entries;
  try { entries = readdirSync(join(dir, base), { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const relPath = base ? `${base}/${e.name}` : e.name;
    if (e.isDirectory()) {
      if (depth <= 0 || /^(\.|node_modules|vendor|target|dist|build|tmp)$/.test(e.name)) continue;
      out.push(...globFiles(dir, re, depth - 1, relPath));
    } else if (re.test(e.name)) out.push(relPath);
  }
  return out;
}

/** The constraint a floor rule is about, read back out of the file. */
function currentConstraint(text, rule) {
  const pats = {
    'engines.node': /"engines"\s*:\s*\{[^}]*?"node"\s*:\s*"([^"]*)"/s,
    'require.php': /"require"\s*:\s*\{[^}]*?"php"\s*:\s*"([^"]*)"/s,
    'requires-python': /^\s*requires-python\s*=\s*"([^"]*)"/m,
    'python_requires': /^\s*python_requires\s*=\s*(.*)$/m,
    'gemspec required_ruby_version': /required_ruby_version\s*=\s*["']([^"']*)["']/,
  };
  const m = pats[rule] ? text.match(pats[rule]) : null;
  return m ? m[1].trim() : null;
}

/**
 * The line that WOULD change, for a declined floor.
 * The old version grepped the whole file for the target's major digit and
 * surfaced whatever matched first — `requires = ["setuptools>=83"]`,
 * `# - Create "v1.x.y" git tag.`, `"@babel/core": "7.26.10"`. Diff the two
 * texts instead; the changed line is not a guess.
 */
function previewLine(before, after) {
  const a = before.split('\n'), b = after.split('\n');
  for (let i = 0; i < Math.max(a.length, b.length); i++)
    if (a[i] !== b[i]) return `${(a[i] ?? '').trim()}  ->  ${(b[i] ?? '').trim()}`.slice(0, 140);
  return '';
}

/** Minimal unified diff. No dependency, no shelling out to diff(1). */
export function unified(file, before, after, context = 2) {
  // Three things made the old emitter produce patches git refuses:
  //
  //  1. `"3.14.9\n".split('\n')` yields a trailing '' that is NOT a line. A
  //     one-line pin file was diffed as two, the hunk header claimed `-1,2`,
  //     and `git apply` rejected every .nvmrc / .python-version / .ruby-version.
  //  2. Two edits closer together than 2x context produced OVERLAPPING hunks
  //     (`@@ -19,5` and `@@ -23,5`), which git rejects outright.
  //  3. A newly created file was emitted as `--- a/<file>` with a `-1,1` hunk
  //     instead of `/dev/null` and `@@ -0,0`.
  //
  // Under MODE=plan the diff IS the deliverable, so these were not cosmetic.
  const split = t => {
    if (t === '') return { lines: [], eof: true };
    const lines = t.split('\n');
    const eof = lines[lines.length - 1] === '';   // text ended with a newline
    if (eof) lines.pop();
    return { lines, eof };
  };
  const A = split(before), B = split(after);
  const a = A.lines, b = B.lines;

  const out = [`--- ${before === '' ? '/dev/null' : 'a/' + file}`,
               `+++ ${after === '' ? '/dev/null' : 'b/' + file}`];

  // ── locate the changed regions ──
  let i = 0, j = 0;
  const raw = [];
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) { i++; j++; continue; }
    const si = i, sj = j;
    while ((i < a.length || j < b.length) && !(i < a.length && j < b.length && a[i] === b[j])) {
      if (i < a.length && !b.includes(a[i], j)) i++;
      else if (j < b.length) j++;
      else i++;
    }
    raw.push([si, i, sj, j]);
  }
  if (!raw.length) return '';

  // ── merge regions whose context windows touch or overlap ──
  const hunks = [raw[0]];
  for (const h of raw.slice(1)) {
    const prev = hunks[hunks.length - 1];
    if (h[0] - prev[1] <= context * 2) { prev[1] = h[1]; prev[3] = h[3]; }
    else hunks.push(h);
  }

  const noNewline = '\\ No newline at end of file';
  for (const [ai, aj, bi, bj] of hunks) {
    const s = Math.max(0, ai - context), e = Math.min(a.length, aj + context);
    const bs = Math.max(0, bi - context), be = Math.min(b.length, bj + context);
    // an empty side is numbered from 0, not 1 — git requires this for add/delete
    out.push(`@@ -${(e - s) === 0 ? 0 : s + 1},${e - s} +${(be - bs) === 0 ? 0 : bs + 1},${be - bs} @@`);
    for (let k = s; k < ai; k++) out.push(' ' + a[k]);
    for (let k = ai; k < aj; k++) {
      out.push('-' + a[k]);
      if (k === a.length - 1 && !A.eof) out.push(noNewline);
    }
    for (let k = bi; k < bj; k++) {
      out.push('+' + b[k]);
      if (k === b.length - 1 && !B.eof) out.push(noNewline);
    }
    for (let k = aj; k < e; k++) {
      out.push(' ' + a[k]);
      if (k === a.length - 1 && !A.eof) out.push(noNewline);
    }
  }
  return out.join('\n') + '\n';
}


/**
 * Pins to CREATE when a project declares no runtime anywhere in its manifest.
 * Rewriting cannot help a file that never had the field; without this, the
 * repos that most need a pin are exactly the ones nothing happens to.
 */
export const ADD_PIN_RULES = {
  node: (t) => ({ file: 'package.json', rule: 'add engines.node', needs: 'package.json',
    edit: x => {
      const o = JSON.parse(x);
      if (o.engines?.node) return x;
      o.engines = { ...(o.engines || {}), node: `>=${mm(t)}` };
      return JSON.stringify(o, null, detectIndent(x)) + (x.endsWith('\n') ? '\n' : '');
    } }),
  bun: (t) => ({ file: 'package.json', rule: 'add engines.bun', needs: 'package.json',
    edit: x => {
      const o = JSON.parse(x);
      if (o.engines?.bun) return x;
      o.engines = { ...(o.engines || {}), bun: `>=${t}` };
      return JSON.stringify(o, null, detectIndent(x)) + (x.endsWith('\n') ? '\n' : '');
    } }),
  deno: (t) => ({ file: '.deno-version', rule: 'add .deno-version', create: `${t}\n` }),
  php: (t) => ({ file: 'composer.json', rule: 'add require.php', needs: 'composer.json',
    edit: x => {
      const o = JSON.parse(x);
      if (o.require?.php) return x;
      o.require = { php: `^${t}`, ...(o.require || {}) };
      return JSON.stringify(o, null, detectIndent(x)) + (x.endsWith('\n') ? '\n' : '');
    } }),
  python: (t) => ({ file: '.python-version', rule: 'add .python-version', create: `${t}\n` }),
  ruby:   (t) => ({ file: '.ruby-version', rule: 'add .ruby-version', create: `${t}\n` }),
  java:   (t) => ({ file: '.java-version', rule: 'add .java-version', create: `${String(t).split('.')[0]}\n` }),
  go:     (t) => ({ file: '.tool-versions', rule: 'add .tool-versions golang', create: `golang ${t}\n` }),
  // `rootOnly`: a rust-toolchain.toml is a RUSTUP OVERRIDE. Dropped into a
  // subdirectory it silently changes the toolchain for every contributor who
  // builds from there — and tokio deliberately ships none at all. Creating one
  // is only ever defensible at the top of the project, never in tokio/fuzz.
  rust:   (t) => ({ file: 'rust-toolchain.toml', rule: 'add rust-toolchain.toml', rootOnly: true,
                    create: `[toolchain]\nchannel = "${t}"\n` }),
  perl:   (t) => ({ file: '.perl-version', rule: 'add .perl-version', create: `${t}\n` }),
  kotlin: (t) => ({ file: '.tool-versions', rule: 'add .tool-versions kotlin', create: `kotlin ${t}\n` }),
  scala:  (t) => ({ file: '.scala-version', rule: 'add .scala-version', create: `${t}\n` }),
  elixir: (t) => ({ file: '.tool-versions', rule: 'add .tool-versions elixir', create: `elixir ${t}\n` }),
  erlang: (t) => ({ file: '.tool-versions', rule: 'add .tool-versions erlang', create: `erlang ${String(t).split('.')[0]}\n` }),
  // No dotnet entry on purpose. A global.json does not exist by default, and
  // creating one makes every contributor's build select a specific SDK — and
  // the SDK version is NOT derivable from a runtime release number anyway
  // (runtime 10.0.13 does not tell you whether the SDK is 10.0.100 or 10.0.400).
  // Inventing one would be a guess written into a file that gates every build.
};

/**
 * Raise ONLY the lower bound of a version constraint, leaving every other term
 * exactly as written.
 *
 * Replacing the whole value turned `>=3.9,<4.0` into `>=3.15` — silently
 * dropping an upper cap the project had chosen — and turned
 * `>=3.8,!=3.9.*,<3.14` into `>=3.15`, which drops two exclusions AND reverses
 * the declared intent (the cap had excluded everything from 3.14 up).
 *
 * A constraint whose terms cannot be preserved is returned unchanged, with the
 * caller left to report it: a compound constraint is a decision someone made.
 */
/**
 * Is this constraint more than a single lower bound?
 *
 * A disjunction or a capped range encodes a decision someone made, and no
 * mechanical rewrite preserves it. `>=8.1.0 <8.3 || ~8.4.2` collapsed to `^8.5`
 * destroys the whole shape; grafana's `>= 22 <25` lost its cap. When this is
 * true the right move is to change nothing and tell the user what is there.
 */
export function isCompoundConstraint(value) {
  const v = String(value || '').trim();
  if (!v) return false;
  if (/\|\||\s-\s/.test(v)) return true;                       // a || b, or "1 - 2"
  const comparators = v.match(/(>=|<=|>|<|~>|~=|\^|==|!=)/g) || [];
  return comparators.length > 1;
}

export function raiseLowerBound(value, floor) {
  const raw = String(value).trim();
  if (!raw) return `>=${floor}`;
  const parts = raw.split(',').map(x => x.trim()).filter(Boolean);
  // a bare `~=` or `==` constraint is not a floor at all — do not touch it
  if (parts.some(x => /^(~=|==)/.test(x)) && !parts.some(x => /^>=?/.test(x))) return raw;
  let sawLower = false;
  const out = parts.map(x => {
    const m = x.match(/^(>=|>)\s*(.+)$/);
    if (!m) return x;                       // <, <=, !=, === : preserved verbatim
    sawLower = true;
    return `>=${floor}`;
  });
  if (!sawLower) return raw;                // nothing to raise; leave the author's intent
  // an upper bound now below the new floor would make the constraint unsatisfiable
  const cap = out.find(x => /^<=?/.test(x));
  if (cap) {
    const capV = cap.replace(/^<=?/, '').trim().split('.').map(Number);
    const flV = String(floor).split('.').map(Number);
    const capBelow = (capV[0] || 0) < (flV[0] || 0)
      || ((capV[0] || 0) === (flV[0] || 0) && (capV[1] || 0) <= (flV[1] || 0));
    if (capBelow) return raw;               // refuse: raising it would exclude everything
  }
  return out.join(',');
}

function detectIndent(text) {
  const m = text.match(/\n([ \t]+)"/);
  return m ? (m[1].includes('\t') ? '\t' : m[1].length) : 2;
}

/** Only fires when planPinEdits found nothing to rewrite. */
/**
 * Is the version declared here in a form the rewriter simply cannot read?
 *
 * planAddPin fires when planPinEdits found nothing to rewrite, and reports
 * "the project declared no runtime". But "no edit was possible" and "nothing
 * is declared" are different things:
 *
 *   rust-version.workspace = true          inherited from [workspace.package]
 *   required_ruby_version = Gem::Requirement.new(">= #{MIN}")   computed
 *   <java.version>${jdk.version}</java.version>                 indirected
 *   "engines": { "node": ">=20" }  in a JSONC package.json      unparsed
 *
 * In each case the declaration EXISTS. Creating a pin beside it is not filling
 * a gap, it is adding a second, contradictory source of truth — and for
 * `rust-toolchain.toml` specifically, a file in a directory is a rustup
 * override that changes the toolchain for every contributor who builds there.
 */
export function declaredButUnreadable(lang, dir) {
  const read = f => { try { return readText(join(dir, f)) || ''; } catch { return ''; } };
  const found = [];
  const note = (file, evidence, how) => found.push({ file, evidence: evidence.trim().slice(0, 100), how });
  if (lang === 'rust') {
    const c = read('Cargo.toml');
    if (/rust-version\s*\.\s*workspace\s*=\s*true|rust-version\s*=\s*\{[^}]*workspace\s*=\s*true/.test(c))
      note('Cargo.toml', (c.match(/.*rust-version.*/) || [''])[0],
           'the MSRV is inherited from [workspace.package] in the workspace root');
  }
  if (lang === 'ruby') {
    for (const f of globFiles(dir, /\.gemspec$/)) {
      const g = read(f);
      if (/required_ruby_version\s*=/.test(g) && !/required_ruby_version\s*=\s*["'][^"']*\d/.test(g))
        note(f, (g.match(/.*required_ruby_version.*/) || [''])[0],
             'the constraint is computed at load time, not a literal string');
    }
  }
  if (lang === 'java') {
    const pom = read('pom.xml');
    const m = pom.match(/<(java\.version|maven\.compiler\.(?:release|source|target))>\s*\$\{[^}]+\}/);
    if (m) note('pom.xml', m[0], 'the version is a property reference resolved elsewhere in the POM');
  }
  if (lang === 'node') {
    const pkg = read('package.json');
    if (pkg && /"engines"/.test(pkg)) {
      try { JSON.parse(pkg); }
      catch { note('package.json', '"engines": …', 'the manifest declares engines but is not valid JSON (JSONC?), so it could not be read'); }
    }
  }
  return found;
}

export function planAddPin(lang, dir, target, { isRoot = true } = {}) {
  const make = ADD_PIN_RULES[lang];
  if (!make) return null;
  // never create a pin beside a declaration that is simply unreadable
  const hidden = declaredButUnreadable(lang, dir);
  if (hidden.length) return { blocked: true, declaredButUnreadable: hidden,
    why: 'a runtime version IS declared here, in a form this tool cannot rewrite. Creating a second '
       + 'pin beside it would add a contradictory source of truth, not fill a gap.' };
  const r = make(target);
  if (r.rootOnly && !isRoot)
    return { blocked: true, rootOnly: r.file,
      why: `creating ${r.file} in a subdirectory is a toolchain OVERRIDE for everyone who builds there, `
         + 'not a project-wide pin. If the project should pin a toolchain, it belongs at the repo root — '
         + 'and that is a decision for a maintainer, not a side effect of upgrading one crate.' };
  const path = join(dir, r.file);
  if (r.create !== undefined) {
    if (existsSync(path)) return null;
    return { file: r.file, path, rule: r.rule, before: '', after: r.create, created: true };
  }
  if (r.needs && !existsSync(join(dir, r.needs))) return null;
  const before = readText(path);
  if (before == null) return null;
  let after; try { after = r.edit(before); } catch { return null; }
  return after === before ? null : { file: r.file, path, rule: r.rule, before, after, created: false };
}
