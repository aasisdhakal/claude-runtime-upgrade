import { join, existsSync, readText, rel } from '../lib/io.mjs';

export const id = 'rust';
export const label = 'Rust';
export const manifests = ['Cargo.toml'];
export const eolProduct = 'rust';
export const osvEcosystem = 'crates.io';
export const gateCapable = false;
export const gateNote =
  'Rust has no curated, version-ranged CVE database for the toolchain itself (OSV returns ' +
  '0 for it). Gate on `cargo audit` findings against RustSec; treat toolchain CVEs as ' +
  'advisory. Rust releases are also not LTS — endoflife.date reports no EOL date.';
export const cveSource = { url: null, note: 'none — RustSec advisory DB covers crates, not the toolchain' };
export const ciKey = /\b(?:rust|toolchain)[-_]?version/i;
export const imageRe = /\b(rust|rustlang\/rust)[:@]([^\s"']+)/gi;

export function scan({ dir, root, dockerImages, ciText }) {
  const cargo = readText(join(dir, 'Cargo.toml')) || '';
  const toolchain = readText(join(dir, 'rust-toolchain.toml')) || readText(join(dir, 'rust-toolchain')) || '';
  const declared = {
    rustVersion:  (cargo.match(/^\s*rust-version\s*=\s*["']([^"']+)/m) || [])[1] || '',
    edition:      (cargo.match(/^\s*edition\s*=\s*["']([^"']+)/m) || [])[1] || '',
    toolchain:    (toolchain.match(/channel\s*=\s*["']([^"']+)/) || [])[1] || toolchain.trim().split('\n')[0] || '',
    toolVersions: (readText(join(dir, '.tool-versions')) || '').match(/^rust\s+(\S+)/mi)?.[1] || '',
    dockerfile:   dockerImages.filter(s => /^rust/i.test(s)).join(' | '),
    ci:           ciText,
  };
  const majors = [...new Set(Object.entries(declared)
    .filter(([k]) => k !== 'edition')
    .map(([, v]) => (String(v).match(/(\d+\.\d+)/) || [])[1]).filter(Boolean))];
  const name = (cargo.match(/^\s*name\s*=\s*["']([^"']+)/m) || [])[1] || dir.split('/').pop();
  return {
    lang: id, name, dir: rel(root, dir), manifest: rel(root, join(dir, 'Cargo.toml')),
    declared, lockfile: existsSync(join(dir, 'Cargo.lock')) ? 'Cargo.lock' : '',
    declaredMajors: majors.join(','), drift: majors.length > 1,
    deps: (cargo.split(/^\[dependencies\]/m)[1] || '').split(/^\[/m)[0].split('\n').filter(l => /^\s*[\w-]+\s*=/.test(l)).length,
    devDeps: 0,
    // No stable ABI, but crates compile from source every time — nothing to prebuild.
    abiNote: 'no ABI concern: crates always compile from source. `edition` is independent of toolchain version.',
    edition: declared.edition,
  };
}
