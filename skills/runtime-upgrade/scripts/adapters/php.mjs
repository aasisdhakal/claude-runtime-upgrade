import { join, existsSync, readJson, readText, rel } from '../lib/io.mjs';
import { rangeMajorMinor } from '../lib/semver.mjs';

export const id = 'php';
export const label = 'PHP';
export const manifests = ['composer.json'];
export const eolProduct = 'php';
export const osvEcosystem = 'Packagist';
/**
 * PHP has NO curated, semver-ranged runtime CVE database. NVD CPE returns
 * historical CVEs for the product, not "unpatched at this version", so it
 * cannot support a hard numeric gate. Gate on EOL/support + composer audit.
 */
export const gateCapable = false;
export const gateNote =
  'PHP runtime CVE data cannot support a hard numeric gate. Gate on EOL/support status and ' +
  'composer advisories instead; treat runtime CVEs as advisory and triage by hand.';
export const cveSource = {
  url: 'https://services.nvd.nist.gov/rest/json/cves/2.0?cpeName=cpe:2.3:a:php:php:{version}:*:*:*:*:*:*:*',
  note: 'NVD CPE — historical, noisy, rate-limited (5 req/30s without NVD_API_KEY, 50 with)',
};
export const ciKey = /\bphp[-_]?version/i;
export const imageRe = /\b(php)[:@]([^\s"']+)/gi;

export function scan({ dir, root, dockerImages, ciText }) {
  const cjPath = join(dir, 'composer.json');
  const cj = readJson(cjPath) || {};
  const lock = readJson(join(dir, 'composer.lock'));
  const declared = {
    requirePhp:     String(cj.require?.php ?? ''),
    configPlatform: String(cj.config?.platform?.php ?? ''),
    phpVersionFile: (readText(join(dir, '.php-version')) || '').trim(),
    toolVersions:   toolVersion(readText(join(dir, '.tool-versions')), /^php\s+(\S+)/mi),
    lockPlatform:   String(lock?.platform?.php ?? ''),
    dockerfile:     dockerImages.filter(s => /^php/i.test(s)).join(' | '),
    ci:             ciText,
  };
  const majors = [...new Set(Object.values(declared).map(rangeMajorMinor).filter(Boolean))];
  return {
    lang: id,
    name: cj.name || dir.split('/').pop(),
    dir: rel(root, dir),
    manifest: rel(root, cjPath),
    declared,
    lockfile: existsSync(join(dir, 'composer.lock')) ? 'composer.lock' : '',
    declaredMajors: majors.join(','),
    drift: majors.length > 1,
    deps: Object.keys(cj.require || {}).length,
    devDeps: Object.keys(cj['require-dev'] || {}).length,
    // config.platform.php makes Composer resolve AS IF on that version regardless
    // of the real runtime — a repo can resolve for 7.4 while running 8.2.
    platformOverride: !!cj.config?.platform?.php,
  };
}

function toolVersion(text, re) {
  if (!text) return '';
  const m = text.match(re);
  return m ? m[1] : '';
}
