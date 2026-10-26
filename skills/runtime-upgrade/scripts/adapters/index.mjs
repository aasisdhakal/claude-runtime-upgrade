// Adapter registry. Adding a language means adding one module here —
// the EOL layer (endoflife.date, 485 products) and the dependency-CVE layer
// (OSV.dev, 10+ ecosystems) are already shared, so the per-language cost is
// discovery paths + native/ABI model + codemod tool.
import * as node from './node.mjs';
import * as php from './php.mjs';

export const adapters = [node, php];
export const byId = Object.fromEntries(adapters.map(a => [a.id, a]));
export const allManifests = new Set(adapters.flatMap(a => a.manifests));

export function adapterForManifest(filename) {
  return adapters.find(a => a.manifests.includes(filename)) || null;
}
