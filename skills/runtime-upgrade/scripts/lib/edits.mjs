// Runtime-pin rewriting. Each rule finds a version declaration and produces the
// replacement. Rules are pure: they return {file, before, after, rule} and never
// touch disk, so dry-run and apply share exactly one code path.
import { join, existsSync, readText, readdirSync } from './io.mjs';

const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Replace the version inside a Docker FROM line, preserving registry + suffix. */
function dockerRewrite(text, imageNames, target, suffixMap = {}) {
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
export function planCiEdits(lang, dir, target) {
  const key = CI_KEY[lang];
  if (!key) return [];
  const images = CI_IMAGE[lang] || [];
  const major = (target.match(/^\d+(\.\d+)?/) || [target])[0];
  const edits = [];
  for (const f of ciFiles(dir)) {
    const before = readText(f);
    if (before == null) continue;
    let after = before;
    // setup-* action inputs: `node-version: 20.11.1`
    after = after.replace(
      new RegExp(`(^\\s*${key}[-_]?version\\s*:\\s*["']?)(?!\\$\\{\\{)([0-9][0-9.xX]*)(["']?)`, 'gmi'),
      (m, head, _v, tail) => head + target + tail);
    // container images
    for (const img of images) {
      after = after.replace(
        new RegExp(`((?:image|container)\\s*:\\s*["']?\\S*?${img.replace('/', '\\/')}[:@])([^\\s"']+)`, 'gi'),
        (m, head, tag) => head + target + tag.replace(/^v?[\d.]+/, ''));
    }
    if (after !== before) edits.push({ file: f.slice(dir.length + 1), path: f, rule: 'CI runtime version', before, after });
  }
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
      edit: t => t.replace(/("engines"\s*:\s*\{[^}]*?"node"\s*:\s*")([^"]*)(")/s, `$1>=${target} <${Number(target.split('.')[0]) + 1}$3`) },
    { file: '.nvmrc', rule: '.nvmrc', edit: () => `v${target}\n` },
    { file: '.node-version', rule: '.node-version', edit: () => `${target}\n` },
    { file: '.tool-versions', rule: '.tool-versions', edit: t => t.replace(/^nodejs\s+\S+/mi, `nodejs ${target}`) },
    { file: 'Dockerfile', rule: 'Dockerfile FROM',
      edit: t => dockerRewrite(t, ['node'], target, { '-alpine3.19': '-alpine3.22', '-alpine3.20': '-alpine3.22' }) },
  ],
  php: (target) => [
    { file: 'composer.json', rule: 'require.php',
      edit: t => t.replace(/("require"\s*:\s*\{[^}]*?"php"\s*:\s*")([^"]*)(")/s, `$1^${mm(target)}$3`) },
    { file: '.php-version', rule: '.php-version', edit: () => `${target}\n` },
    { file: '.tool-versions', rule: '.tool-versions', edit: t => t.replace(/^php\s+\S+/mi, `php ${target}`) },
    { file: 'Dockerfile', rule: 'Dockerfile FROM', edit: t => dockerRewrite(t, ['php'], target) },
  ],
  go: (target) => [
    { file: 'go.mod', rule: 'go directive', edit: t => t.replace(/^go\s+[\d.]+/m, `go ${mm(target)}`) },
    { file: '.tool-versions', rule: '.tool-versions', edit: t => t.replace(/^golang\s+\S+/mi, `golang ${target}`) },
    { file: 'Dockerfile', rule: 'Dockerfile FROM', edit: t => dockerRewrite(t, ['golang'], target) },
  ],
  python: (target) => [
    { file: 'setup.cfg', rule: 'python_requires',
      edit: t => t.replace(/^(\s*python_requires\s*=\s*)(.*)$/m, `$1>=${mm(target)}`) },
    { file: 'Pipfile', rule: 'Pipfile python_version',
      edit: t => t.replace(/(python_version\s*=\s*")([^"]*)(")/, `$1${target}$3`) },
    { file: 'tox.ini', rule: 'tox basepython',
      edit: t => t.replace(/(basepython\s*=\s*python)([\d.]+)/g, `$1${target}`) },

    { file: 'pyproject.toml', rule: 'requires-python',
      edit: t => t.replace(/^(\s*requires-python\s*=\s*")([^"]*)(")/m, `$1>=${mm(target)}$3`) },
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
      edit: t => t.replace(/(JavaLanguageVersion\.of\()(\d+)(\))/g, `$1${target}$3`) },
    { file: '.java-version', rule: '.java-version', edit: () => `${target}\n` },

    { file: 'pom.xml', rule: 'maven.compiler.release',
      edit: t => t.replace(/(<maven\.compiler\.release>)\s*\d+\s*(<)/, `$1${target}$2`)
                  .replace(/(<java\.version>)\s*[\d.]+\s*(<)/, `$1${target}$2`) },
    { file: 'build.gradle.kts', rule: 'jvmToolchain',
      edit: t => t.replace(/jvmToolchain\(\d+\)/, `jvmToolchain(${target})`) },
    { file: '.sdkmanrc', rule: '.sdkmanrc', edit: t => t.replace(/^java=\S+/mi, `java=${target}`) },
    { file: 'Dockerfile', rule: 'Dockerfile FROM',
      edit: t => dockerRewrite(t, ['eclipse-temurin', 'amazoncorretto', 'openjdk'], target) },
  ],
  dotnet: (target) => {
    // global.json pins a full SDK build (9.0.100); container tags are MAJOR.MINOR (9.0)
    const tag = (target.match(/^\d+\.\d+/) || [target])[0];
    return [
      { file: 'global.json', rule: 'sdk.version',
        // global.json pins an SDK BUILD (10.0.100); the EOL feed reports a
        // RUNTIME version (10.0.13). Writing one into the other reads as a
        // downgrade, so only move the SDK when the major.minor actually changes.
        edit: t => {
          const cur = (t.match(/"version"\s*:\s*"([^"]*)"/) || [])[1] || '';
          if (cur && mm(cur) === mm(target)) return t;      // same feature band: leave it
          return t.replace(/("version"\s*:\s*")([^"]*)(")/, `$1${mm(target)}.100$3`);
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

/** Compute every pin edit for a target. Pure: reads files, writes nothing. */
export function planPinEdits(lang, dir, target) {
  const rules = PIN_RULES[lang];
  if (!rules) return { edits: [], unsupported: true };
  const edits = [];
  for (const r of rules(target)) {
    let file = r.file;
    if (!file && r.glob) {
      try { file = readdirSync(dir).find(n => r.glob.test(n)); } catch {}
      if (!file) continue;
    }
    const path = join(dir, file);
    if (!existsSync(path)) continue;
    const before = readText(path);
    if (before == null) continue;
    const after = r.edit(before);
    if (after !== before) edits.push({ file, path, rule: r.rule, before, after });
  }
  return { edits, unsupported: false };
}

/** Minimal unified diff. No dependency, no shelling out to diff(1). */
export function unified(file, before, after, context = 2) {
  const a = before.split('\n'), b = after.split('\n');
  const out = [`--- a/${file}`, `+++ b/${file}`];
  let i = 0, j = 0;
  const hunks = [];
  while (i < a.length || j < b.length) {
    if (a[i] === b[j]) { i++; j++; continue; }
    const si = i, sj = j;
    while ((i < a.length || j < b.length) && a[i] !== b[j]) {
      if (i < a.length && !b.includes(a[i], j)) i++;
      else if (j < b.length) j++;
      else i++;
    }
    hunks.push([si, i, sj, j]);
  }
  for (const [ai, aj, bi, bj] of hunks) {
    const s = Math.max(0, ai - context), e = Math.min(a.length, aj + context);
    out.push(`@@ -${s + 1},${e - s} +${Math.max(0, bi - context) + 1},${Math.min(b.length, bj + context) - Math.max(0, bi - context)} @@`);
    for (let k = s; k < ai; k++) out.push(' ' + a[k]);
    for (let k = ai; k < aj; k++) out.push('-' + a[k]);
    for (let k = bi; k < bj; k++) out.push('+' + b[k]);
    for (let k = aj; k < e; k++) out.push(' ' + a[k]);
  }
  return out.join('\n');
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
      o.engines = { ...(o.engines || {}), node: `>=${t} <${Number(String(t).split('.')[0]) + 1}` };
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
  rust:   (t) => ({ file: 'rust-toolchain.toml', rule: 'add rust-toolchain.toml', create: `[toolchain]\nchannel = "${t}"\n` }),
  perl:   (t) => ({ file: '.perl-version', rule: 'add .perl-version', create: `${t}\n` }),
  kotlin: (t) => ({ file: '.tool-versions', rule: 'add .tool-versions kotlin', create: `kotlin ${t}\n` }),
  scala:  (t) => ({ file: '.scala-version', rule: 'add .scala-version', create: `${t}\n` }),
  elixir: (t) => ({ file: '.tool-versions', rule: 'add .tool-versions elixir', create: `elixir ${t}\n` }),
  erlang: (t) => ({ file: '.tool-versions', rule: 'add .tool-versions erlang', create: `erlang ${String(t).split('.')[0]}\n` }),
  dotnet: (t) => ({ file: 'global.json', rule: 'add global.json',
    create: JSON.stringify({ sdk: { version: t, rollForward: 'latestFeature' } }, null, 2) + '\n' }),
};

function detectIndent(text) {
  const m = text.match(/\n([ \t]+)"/);
  return m ? (m[1].includes('\t') ? '\t' : m[1].length) : 2;
}

/** Only fires when planPinEdits found nothing to rewrite. */
export function planAddPin(lang, dir, target) {
  const make = ADD_PIN_RULES[lang];
  if (!make) return null;
  const r = make(target);
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
