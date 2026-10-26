import { join, existsSync, readText, rel } from '../lib/io.mjs';
import { classifyDeclared } from '../lib/semver.mjs';

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

// path identity without importing node:path into an adapter
function resolveSafe(p) { return String(p).replace(/\/+$/, ''); }

export function scan({ dir, root, dockerImages, ciText }) {
  const cargo = readText(join(dir, 'Cargo.toml')) || '';
  // rustup resolves a toolchain file by walking UPWARD from the build
  // directory, so a crate deep in a workspace is governed by the root's file.
  // Reading only the crate's own directory left 62 of next.js's 64 Rust targets
  // looking as though nothing pinned their toolchain.
  let toolchain = '', toolchainFrom = '';
  for (let up = dir, i = 0; i < 6; up = join(up, '..'), i++) {
    const t = readText(join(up, 'rust-toolchain.toml')) || readText(join(up, 'rust-toolchain'));
    if (t) { toolchain = t; toolchainFrom = rel(root, up) || '.'; break; }
    if (resolveSafe(up) === resolveSafe(root)) break;
  }
  const declared = {
    rustVersion:  (cargo.match(/^\s*rust-version\s*=\s*["']([^"']+)/m) || [])[1] || '',
    edition:      (cargo.match(/^\s*edition\s*=\s*["']([^"']+)/m) || [])[1] || '',
    toolchain:    (toolchain.match(/channel\s*=\s*["']([^"']+)/) || [])[1] || toolchain.trim().split('\n')[0] || '',
    toolVersions: (readText(join(dir, '.tool-versions')) || '').match(/^rust\s+(\S+)/mi)?.[1] || '',
    dockerfile:   dockerImages.filter(s => /^rust/i.test(s)).join(' | '),
    ci:           ciText,
  };
  const considered = Object.fromEntries(Object.entries(declared).filter(([k]) => k !== 'edition'));
  const { pins, floors } = classifyDeclared(considered);
  const pinMajors = [...new Set(Object.values(pins).map(v => (String(v).match(/(\d+\.\d+)/) || [])[1]).filter(Boolean))];
  const floorMajors = [...new Set(Object.values(floors).map(v => (String(v).match(/(\d+\.\d+)/) || [])[1]).filter(Boolean))];
  const majors = [...new Set([...pinMajors, ...floorMajors])];
  const name = (cargo.match(/^\s*name\s*=\s*["']([^"']+)/m) || [])[1] || dir.split('/').pop();

  // A channel is a PIN even when it carries no version number. next.js pins
  // `nightly-2026-10-06`, and because `(\d+\.\d+)` cannot match that, every one
  // of its 64 Rust targets was reported as declaring nothing — with guidance
  // saying nothing enforced the version, which was simply false.
  //
  // It must not be rewritten to a stable release either: moving off nightly
  // removes the unstable features the code was written against. That is a
  // decision, not a version bump.
  const channel = declared.toolchain;
  const channelKind = !channel ? null
    : /^nightly/.test(channel) ? 'nightly'
    : /^beta/.test(channel) ? 'beta'
    : /^stable$/.test(channel) ? 'stable-floating'
    : /^\d/.test(channel) ? 'stable-pinned' : 'other';
  return {
    lang: id, name, dir: rel(root, dir), manifest: rel(root, join(dir, 'Cargo.toml')),
    declared, lockfile: existsSync(join(dir, 'Cargo.lock')) ? 'Cargo.lock' : '',
    declaredMajors: majors.join(','),
    pinnedMajors: pinMajors.join(','), floorMajors: floorMajors.join(','),
    channel: channel || undefined,
    channelKind: channelKind || undefined,
    // a non-numeric channel still pins the toolchain; it just has no major
    unversionedPin: channelKind && !pinMajors.length ? {
      file: (toolchainFrom === '.' ? '' : toolchainFrom + '/')
          + (existsSync(join(root, toolchainFrom === '.' ? '' : toolchainFrom, 'rust-toolchain.toml'))
              ? 'rust-toolchain.toml' : 'rust-toolchain'),
      inheritedFrom: toolchainFrom === rel(root, dir) ? undefined : toolchainFrom,
      channel,
      meaning: channelKind === 'nightly'
        ? 'pinned to a dated NIGHTLY — the toolchain IS enforced, it just has no release number. '
        + 'Moving to a stable release removes the unstable features the code targets: that is a port, not a bump. '
        + 'Bump the nightly DATE instead, and only after checking the components list still resolves.'
        : channelKind === 'stable-floating'
        ? 'pinned to the `stable` channel, which floats — the version is whatever rustup last installed. '
        + 'Nothing enforces a specific release; pin a number if reproducibility matters.'
        : `pinned to channel "${channel}" — enforced, but not a numbered release`,
    } : undefined,
    drift: pinMajors.length > 1,
    deps: (cargo.split(/^\[dependencies\]/m)[1] || '').split(/^\[/m)[0].split('\n').filter(l => /^\s*[\w-]+\s*=/.test(l)).length,
    devDeps: 0,
    // No stable ABI, but crates compile from source every time — nothing to prebuild.
    abiNote: 'no ABI concern: crates always compile from source. `edition` is independent of toolchain version.',
    edition: declared.edition,
  };
}
