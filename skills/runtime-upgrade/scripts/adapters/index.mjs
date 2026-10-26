// Adapter registry.
//
// Two layers are shared across every language, which is why adding one is cheap:
//   EOL        endoflife.date — 485 products, identical JSON shape
//   Dep CVEs   OSV.dev        — npm, Packagist, PyPI, RubyGems, Go, Maven,
//                               NuGet, crates.io, Pub, Hex through one endpoint
//
// What is NOT shared is the runtime CVE source. Only two runtimes have a
// curated, version-ranged database:
//   node  nodejs/security-wg  (severity-rated)  -> gate on high/critical
//   go    OSV `stdlib`        (no severity)     -> gate on total
// Everything else reports `gateCapable: false` with a reason. Say so rather
// than implying a gate that cannot be enforced.
import * as node from './node.mjs';
import * as php from './php.mjs';
import * as go from './go.mjs';
import * as python from './python.mjs';
import * as ruby from './ruby.mjs';
import * as rust from './rust.mjs';
import * as java from './java.mjs';
import * as dotnet from './dotnet.mjs';

export const adapters = [node, php, go, python, ruby, rust, java, dotnet];
export const byId = Object.fromEntries(adapters.map(a => [a.id, a]));
export const allManifests = new Set(adapters.flatMap(a => a.manifests));

export function matchesManifest(filename) {
  return adapters.some(a => a.manifests.includes(filename) || (a.manifestMatch && a.manifestMatch(filename)));
}
export function adapterForManifest(filename) {
  // exact manifest names win over pattern matches (global.json before *.csproj)
  return adapters.find(a => a.manifests.includes(filename))
      || adapters.find(a => a.manifestMatch && a.manifestMatch(filename))
      || null;
}
