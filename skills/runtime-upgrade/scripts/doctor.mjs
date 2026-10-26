#!/usr/bin/env node
// Reports what this machine can and cannot do, and what degrades without each tool.
import { have, run } from './lib/sh.mjs';
import { fetchJson, CACHE_DIR, OFFLINE, emit } from './lib/io.mjs';
import { adapters } from './adapters/index.mjs';

const TOOLS = [
  ['node',     'required', 'everything — this skill is Node-native'],
  ['docker',   'optional', 'image-level verification gates (version, ABI, extensions)'],
  ['git',      'optional', 'branch creation in write mode'],
  ['npm',      'node',     'dependency advisories + direct dependency floors'],
  ['pnpm',     'node',     'advisories for pnpm workspaces'],
  ['yarn',     'node',     'advisories for yarn projects'],
  ['php',      'php',      'extension list, Zend module API, thread safety'],
  ['composer', 'php',      'advisories, `prohibits`, `check-platform-reqs` — the whole PHP assess phase'],
  ['rector',   'php',      'automated code migration (80-90% of PHP version changes)'],
  ['phpstan',  'php',      'type-aware compatibility analysis'],
  ['phpcs',    'php',      'PHPCompatibility sniffs'],
];

const tools = TOOLS.map(([cmd, scope, why]) => {
  const present = have(cmd);
  let version = null;
  if (present) {
    const r = run(cmd, ['--version'], { timeout: 8000 });
    version = (r.stdout || r.stderr).split('\n')[0].trim().slice(0, 60) || null;
  }
  return { tool: cmd, scope, present, version, degradesWithout: present ? null : why };
});

const nodeMajor = Number(process.versions.node.split('.')[0]);
const sources = [];
for (const [name, url] of [
  ['endoflife.date', 'https://endoflife.date/api/nodejs.json'],
  ['nodejs/security-wg', 'https://raw.githubusercontent.com/nodejs/security-wg/main/vuln/core/index.json'],
]) {
  const r = await fetchJson(url, { ttl: 86400 });
  sources.push({ name, reachable: !!r.data, cached: !!r.cached, stale: !!r.stale, error: r.error || null });
}

emit({
  node: { version: process.versions.node, ok: nodeMajor >= 18,
          note: nodeMajor >= 18 ? null : 'Node 18+ recommended; using the https fallback for fetch' },
  platform: `${process.platform}/${process.arch}`,
  cacheDir: CACHE_DIR,
  offline: OFFLINE,
  tools,
  dataSources: sources,
  languages: adapters.map(a => ({
    id: a.id, label: a.label, gateCapable: a.gateCapable,
    eolProduct: a.eolProduct, osvEcosystem: a.osvEcosystem,
    ready: a.id === 'node' ? have('node') : have('php') || have('composer'),
  })),
  nvdApiKey: process.env.NVD_API_KEY ? 'set' : 'not set — PHP NVD lookups limited to 5 requests/30s',
  missingRequired: tools.filter(t => t.scope === 'required' && !t.present).map(t => t.tool),
});
