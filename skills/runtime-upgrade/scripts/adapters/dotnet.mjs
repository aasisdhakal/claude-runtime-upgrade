import { join, existsSync, readText, readJson, readdirSync, rel } from '../lib/io.mjs';

export const id = 'dotnet';
export const label = '.NET';
export const manifests = ['global.json'];           // plus *.csproj, matched dynamically
export const manifestMatch = n => n === 'global.json' || /\.(csproj|fsproj|vbproj)$/.test(n);
export const eolProduct = 'dotnet';
export const osvEcosystem = 'NuGet';
export const gateCapable = false;
export const gateNote =
  'OSV returns nothing for the .NET runtime itself. Microsoft ships advisories through its ' +
  'Security Update Guide and `dotnet list package --vulnerable`. Gate on EOL/support status ' +
  'and that command; treat runtime CVEs as advisory.';
export const cveSource = { url: null, note: 'none in OSV — Microsoft Security Update Guide + `dotnet list package --vulnerable`' };
export const ciKey = /\bdotnet[-_]?version/i;
export const imageRe = /\b(?:mcr\.microsoft\.com\/)?dotnet\/(?:sdk|runtime|aspnet)[:@]([^\s"']+)/gi;

/**
 * The one place a .NET version string is turned into a comparable number.
 * EXPORTED because plan.mjs reimplemented this and reintroduced the exact bug
 * the comments below describe: it read `net472` as version "472", making a
 * .NET Framework project look newer than .NET 10, and scored a cross-platform
 * port as a 2-point, zero-cycle change. 119 of roslyn's 123 plans were that.
 *
 *   net8.0, net10.0   .NET (Core) — the major is before the dot
 *   net46, net472     .NET FRAMEWORK 4.6 / 4.7.2 — the digits are 4.x, NOT 46
 *   netstandard2.0    not a runtime version at all
 */
export const normalizeVersion = v => {
  const s2 = String(v);
  const core = s2.match(/^net(?:coreapp)?(\d+)\.\d+/);     // net8.0 -> 8
  if (core) return core[1];
  const fw = s2.match(/^net(\d)(\d)(\d)?$/);                // net472 -> 4.7
  if (fw) return `${fw[1]}.${fw[2]}`;
  if (/^netstandard/.test(s2)) return '';                    // not a runtime version
  const plain = s2.match(/^(\d+)\./);                       // 8.0.401 -> 8
  return plain ? plain[1] : '';
};

export function scan({ dir, root, dockerImages, ciText }) {
  let proj = '', projFile = '';
  try {
    for (const f of readdirSync(dir)) if (/\.(csproj|fsproj|vbproj)$/.test(f)) { projFile = f; proj = readText(join(dir, f)) || ''; break; }
  } catch {}
  const g = readJson(join(dir, 'global.json'));
  // <TargetFrameworks Condition="...">net10.0;net8.0</TargetFrameworks> — the
  // conditional form is normal in multi-targeted libraries and was being missed
  // entirely, so Newtonsoft.Json's flagship project reported no framework at all.
  const tfms = [...new Set([...(proj.matchAll(/<TargetFrameworks?(?:\s[^>]*)?>\s*([^<]+)/g))]
    .flatMap(m => m[1].split(';').map(s => s.trim()).filter(Boolean))
    .filter(t => !t.startsWith('$')))];                     // skip MSBuild variables
  const declared = {
    targetFramework: tfms.join(';'),
    globalJsonSdk:   String(g?.sdk?.version ?? ''),
    rollForward:     String(g?.sdk?.rollForward ?? ''),
    langVersion:     (proj.match(/<LangVersion>\s*([^<]+)/) || [])[1]?.trim() || '',
    dockerfile:      dockerImages.filter(s => /dotnet\//i.test(s)).join(' | '),
    ci:              ciText,
  };
  // TWO different numbering schemes share the "net" prefix:
  //   net8.0, net10.0   .NET (Core) — the major is before the dot
  //   net46, net472     .NET FRAMEWORK 4.6 / 4.7.2 — digits are 4.x, NOT 46
  // Reading net46 as "46" made a .NET Framework project look newer than .NET 10
  // and scored a cross-platform port as a 2-point, zero-cycle change.
  const norm = normalizeVersion;
  const majors = [...new Set(Object.entries(declared)
    .filter(([k]) => k !== 'langVersion' && k !== 'rollForward')
    .flatMap(([, v]) => String(v).split(/[;|]/).map(norm)).filter(Boolean))];
  return {
    lang: id, name: (projFile || dir.split('/').pop()).replace(/\.(csproj|fsproj|vbproj)$/, ''),
    dir: rel(root, dir), manifest: rel(root, join(dir, projFile || 'global.json')),
    declared, lockfile: existsSync(join(dir, 'packages.lock.json')) ? 'packages.lock.json' : '',
    declaredMajors: majors.join(','),
    // <TargetFrameworks>net10.0;net9.0;net8.0</TargetFrameworks> is deliberate
    // multi-targeting — the whole point of the file, never disagreement
    drift: tfms.length > 1 ? false : majors.length > 1,
    deps: (proj.match(/<PackageReference\s/g) || []).length, devDeps: 0,
    multiTargeted: tfms.length > 1,
    // a .NET Framework TFM is a PORT target, not a version bump
    netFrameworkTfms: tfms.filter(t => /^net\d{2,3}$/.test(t)),
    netStandardTfms: tfms.filter(t => /^netstandard/.test(t)),
    abiNote: 'TFM (net8.0) is the compatibility axis; global.json rollForward decides which SDK a build accepts.',
  };
}
