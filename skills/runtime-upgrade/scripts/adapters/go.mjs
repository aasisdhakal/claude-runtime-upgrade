import { join, existsSync, readText, rel } from '../lib/io.mjs';
import { osvAdvisories } from '../lib/osv.mjs';

export const id = 'go';
export const label = 'Go';
export const manifests = ['go.mod'];
export const eolProduct = 'go';
export const osvEcosystem = 'Go';
/**
 * Go CAN be gated: OSV carries `stdlib` in the Go ecosystem as a real,
 * version-ranged package. But the Go vulnerability database assigns NO
 * severity (0 of 82 records at go1.22 carry one), so the gate metric is
 * TOTAL unpatched stdlib advisories, not high/critical.
 */
export const gateCapable = true;
export const gateMetric = 'total';
export const gateNote =
  'Go advisories carry no severity rating, so the gate counts TOTAL unpatched stdlib ' +
  'advisories rather than high/critical. The Go security team only publishes reviewed ' +
  'issues, so a non-zero count is actionable.';
export const cveSource = { url: 'https://api.osv.dev/v1/query', note: 'OSV.dev `stdlib` (Go ecosystem) — version-ranged, no severity ratings' };
export const ciKey = /\b(?:go|golang)[-_]?version/i;
export const imageRe = /\b(golang|go)[:@]([^\s"']+)/gi;

export async function runtimeCves(version) {
  const { hits, error } = await osvAdvisories('stdlib', 'Go', version);
  return { hits, error };
}

export function scan({ dir, root, dockerImages, ciText }) {
  const gomod = readText(join(dir, 'go.mod')) || '';
  const declared = {
    goDirective:   (gomod.match(/^go\s+(\d+(?:\.\d+)*)/m) || [])[1] || '',
    toolchain:     (gomod.match(/^toolchain\s+go(\d+(?:\.\d+)*)/m) || [])[1] || '',
    toolVersions:  (readText(join(dir, '.tool-versions')) || '').match(/^golang\s+(\S+)/mi)?.[1] || '',
    dockerfile:    dockerImages.filter(s => /^(golang|go)[:@]/i.test(s)).join(' | '),
    ci:            ciText,
  };
  const module = (gomod.match(/^module\s+(\S+)/m) || [])[1] || dir.split('/').pop();
  const majors = [...new Set(Object.values(declared)
    .map(v => (String(v).match(/(\d+\.\d+)/) || [])[1]).filter(Boolean))];
  const deps = (gomod.match(/^\s*require\s*\(/m)
    ? (gomod.split(/^\s*require\s*\(/m)[1] || '').split(/^\s*\)/m)[0].split('\n').filter(l => l.trim() && !l.trim().startsWith('//')).length
    : (gomod.match(/^require\s+\S+/gm) || []).length);
  return {
    lang: id, name: module.split('/').pop(), dir: rel(root, dir), manifest: rel(root, join(dir, 'go.mod')),
    declared, lockfile: existsSync(join(dir, 'go.sum')) ? 'go.sum' : '',
    declaredMajors: majors.join(','), drift: majors.length > 1,
    deps, devDeps: 0,
    // Go links statically; CGO_ENABLED is the only native axis that matters.
    cgo: /\bC\b/.test(gomod) || existsSync(join(dir, 'cgo.go')),
  };
}
