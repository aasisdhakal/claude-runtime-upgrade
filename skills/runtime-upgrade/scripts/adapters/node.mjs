import { join, existsSync, readJson, readText, rel } from '../lib/io.mjs';
import { rangeMajor, satisfies } from '../lib/semver.mjs';

export const id = 'node';
export const label = 'Node.js';
export const manifests = ['package.json'];
export const eolProduct = 'nodejs';
export const osvEcosystem = 'npm';
/** Node is the ONLY runtime with a curated, semver-ranged CVE database. */
export const gateCapable = true;
export const cveSource = {
  url: 'https://raw.githubusercontent.com/nodejs/security-wg/main/vuln/core/index.json',
  note: 'nodejs/security-wg — curated, semver-ranged, authoritative',
};
export const imageRe = /\b(node|bun|deno)[:@]([^\s"']+)/gi;

export function matchRuntimeCve(db, version) {
  const hits = [];
  for (const [key, v] of Object.entries(db || {})) {
    if (!v || !v.vulnerable) continue;
    const exposed = satisfies(version, v.vulnerable) && !(v.patched && satisfies(version, v.patched));
    if (!exposed) continue;
    hits.push({
      id: (v.cve && v.cve[0]) || key,
      severity: String(v.severity || 'unknown').toLowerCase(),
      patched: v.patched || null,
      overview: String(v.overview || '').replace(/\s+/g, ' ').slice(0, 180),
    });
  }
  return hits;
}

const CI_FILES = [
  '.github/workflows', '.gitlab-ci.yml', 'bitbucket-pipelines.yml',
  'buildspec.yml', 'buildspec.yaml', 'azure-pipelines.yml', 'Jenkinsfile', '.circleci/config.yml',
];

export function scan({ dir, root, dockerImages, ciText }) {
  const pkgPath = join(dir, 'package.json');
  const pkg = readJson(pkgPath) || {};
  const declared = {
    engines:      String(pkg.engines?.node ?? ''),
    devEngines:   String(pkg.devEngines?.runtime?.version ?? ''),
    volta:        String(pkg.volta?.node ?? ''),
    nvmrc:        (readText(join(dir, '.nvmrc')) || '').trim(),
    nodeVersion:  (readText(join(dir, '.node-version')) || '').trim(),
    toolVersions: toolVersion(readText(join(dir, '.tool-versions')), /^nodejs\s+(\S+)/mi),
    dockerfile:   dockerImages.filter(s => /^(node|bun|deno)/i.test(s)).join(' | '),
    ci:           ciText,
  };
  let lockfile = '';
  for (const l of ['package-lock.json', 'pnpm-lock.yaml', 'yarn.lock', 'bun.lock', 'bun.lockb']) {
    if (existsSync(join(dir, l))) { lockfile = l; break; }
  }
  const majors = [...new Set(Object.values(declared).map(rangeMajor).filter(Boolean))];
  return {
    lang: id,
    name: pkg.name || dir.split('/').pop(),
    dir: rel(root, dir),
    manifest: rel(root, pkgPath),
    declared,
    packageManager: String(pkg.packageManager ?? ''),
    lockfile,
    declaredMajors: majors.join(','),
    drift: majors.length > 1,
    deps: Object.keys(pkg.dependencies || {}).length,
    devDeps: Object.keys(pkg.devDependencies || {}).length,
    workspaceRoot: !!(pkg.workspaces || existsSync(join(dir, 'pnpm-workspace.yaml'))),
  };
}

function toolVersion(text, re) {
  if (!text) return '';
  const m = text.match(re);
  return m ? m[1] : '';
}
export { CI_FILES };
