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

export function scan({ dir, root, dockerImages, ciText }) {
  let proj = '', projFile = '';
  try {
    for (const f of readdirSync(dir)) if (/\.(csproj|fsproj|vbproj)$/.test(f)) { projFile = f; proj = readText(join(dir, f)) || ''; break; }
  } catch {}
  const g = readJson(join(dir, 'global.json'));
  const tfms = [...new Set([...(proj.matchAll(/<TargetFrameworks?>\s*([^<]+)/g))]
    .flatMap(m => m[1].split(';').map(s => s.trim()).filter(Boolean)))];
  const declared = {
    targetFramework: tfms.join(';'),
    globalJsonSdk:   String(g?.sdk?.version ?? ''),
    rollForward:     String(g?.sdk?.rollForward ?? ''),
    langVersion:     (proj.match(/<LangVersion>\s*([^<]+)/) || [])[1]?.trim() || '',
    dockerfile:      dockerImages.filter(s => /dotnet\//i.test(s)).join(' | '),
    ci:              ciText,
  };
  // net8.0 -> 8 ; 8.0.401 -> 8
  const norm = v => (String(v).match(/net(\d+)\.\d+/) || String(v).match(/^(\d+)\./) || [])[1] || '';
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
    abiNote: 'TFM (net8.0) is the compatibility axis; global.json rollForward decides which SDK a build accepts.',
  };
}
