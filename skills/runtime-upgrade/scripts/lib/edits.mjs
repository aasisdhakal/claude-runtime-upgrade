// Runtime-pin rewriting. Each rule finds a version declaration and produces the
// replacement. Rules are pure: they return {file, before, after, rule} and never
// touch disk, so dry-run and apply share exactly one code path.
import { join, existsSync, readText } from './io.mjs';

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
      edit: t => t.replace(/("require"\s*:\s*\{[^}]*?"php"\s*:\s*")([^"]*)(")/s, `$1^${target}$3`) },
    { file: '.php-version', rule: '.php-version', edit: () => `${target}\n` },
    { file: '.tool-versions', rule: '.tool-versions', edit: t => t.replace(/^php\s+\S+/mi, `php ${target}`) },
    { file: 'Dockerfile', rule: 'Dockerfile FROM', edit: t => dockerRewrite(t, ['php'], target) },
  ],
  go: (target) => [
    { file: 'go.mod', rule: 'go directive', edit: t => t.replace(/^go\s+[\d.]+/m, `go ${target}`) },
    { file: '.tool-versions', rule: '.tool-versions', edit: t => t.replace(/^golang\s+\S+/mi, `golang ${target}`) },
    { file: 'Dockerfile', rule: 'Dockerfile FROM', edit: t => dockerRewrite(t, ['golang'], target) },
  ],
  python: (target) => [
    { file: 'pyproject.toml', rule: 'requires-python',
      edit: t => t.replace(/^(\s*requires-python\s*=\s*")([^"]*)(")/m, `$1>=${target}$3`) },
    { file: '.python-version', rule: '.python-version', edit: () => `${target}\n` },
    { file: 'runtime.txt', rule: 'runtime.txt', edit: () => `python-${target}\n` },
    { file: '.tool-versions', rule: '.tool-versions', edit: t => t.replace(/^python\s+\S+/mi, `python ${target}`) },
    { file: 'Dockerfile', rule: 'Dockerfile FROM', edit: t => dockerRewrite(t, ['python'], target) },
  ],
  ruby: (target) => [
    { file: 'Gemfile', rule: 'Gemfile ruby', edit: t => t.replace(/^(\s*ruby\s+["'])([^"']+)(["'])/m, `$1${target}$3`) },
    { file: '.ruby-version', rule: '.ruby-version', edit: () => `${target}\n` },
    { file: '.tool-versions', rule: '.tool-versions', edit: t => t.replace(/^ruby\s+\S+/mi, `ruby ${target}`) },
    { file: 'Dockerfile', rule: 'Dockerfile FROM', edit: t => dockerRewrite(t, ['ruby'], target) },
  ],
  rust: (target) => [
    { file: 'Cargo.toml', rule: 'rust-version',
      edit: t => t.replace(/^(\s*rust-version\s*=\s*")([^"]*)(")/m, `$1${target}$3`) },
    { file: 'rust-toolchain.toml', rule: 'toolchain channel',
      edit: t => t.replace(/(channel\s*=\s*")([^"]*)(")/, `$1${target}$3`) },
    { file: 'Dockerfile', rule: 'Dockerfile FROM', edit: t => dockerRewrite(t, ['rust'], target) },
  ],
  java: (target) => [
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
        edit: t => t.replace(/("version"\s*:\s*")([^"]*)(")/, `$1${target}$3`) },
      { file: 'Dockerfile', rule: 'Dockerfile FROM',
        edit: t => dockerRewrite(t, ['dotnet/sdk', 'dotnet/runtime', 'dotnet/aspnet'], tag) },
    ];
  },
  deno:   (t) => [{ file: 'Dockerfile', rule: 'Dockerfile FROM', edit: x => dockerRewrite(x, ['denoland/deno'], t) }],
  bun:    (t) => [{ file: '.bun-version', rule: '.bun-version', edit: () => `${t}\n` },
                  { file: 'Dockerfile', rule: 'Dockerfile FROM', edit: x => dockerRewrite(x, ['oven/bun'], t) }],
  elixir: (t) => [{ file: 'mix.exs', rule: 'elixir requirement', edit: x => x.replace(/(elixir:\s*")[^"]*(")/, `$1~> ${t}$2`) }],
  erlang: (t) => [{ file: 'rebar.config', rule: 'minimum_otp_vsn', edit: x => x.replace(/(minimum_otp_vsn\s*,\s*")[^"]*(")/, `$1${t}$2`) }],
  kotlin: (t) => [{ file: 'build.gradle.kts', rule: 'kotlin plugin version',
                    edit: x => x.replace(/(kotlin\(["']jvm["']\)\s*version\s*["'])[^"']*(["'])/, `$1${t}$2`) }],
  scala:  (t) => [{ file: 'build.sbt', rule: 'scalaVersion', edit: x => x.replace(/(scalaVersion\s*:=\s*")[^"]*(")/, `$1${t}$2`) }],
  perl:   (t) => [{ file: 'cpanfile', rule: 'requires perl',
                    edit: x => x.replace(/(requires\s+["']perl["']\s*,\s*["']?)[\d._v]+/, `$1${t}`) },
                  { file: '.perl-version', rule: '.perl-version', edit: () => `${t}\n` }],
};

/** Compute every pin edit for a target. Pure: reads files, writes nothing. */
export function planPinEdits(lang, dir, target) {
  const rules = PIN_RULES[lang];
  if (!rules) return { edits: [], unsupported: true };
  const edits = [];
  for (const r of rules(target)) {
    const path = join(dir, r.file);
    if (!existsSync(path)) continue;
    const before = readText(path);
    if (before == null) continue;
    const after = r.edit(before);
    if (after !== before) edits.push({ file: r.file, path, rule: r.rule, before, after });
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
