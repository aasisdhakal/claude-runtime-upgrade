#!/usr/bin/env node
// Reports what this machine can and cannot do, and what degrades without each tool.
import { have, run } from './lib/sh.mjs';
import { fetchJson, CACHE_DIR, OFFLINE, emit } from './lib/io.mjs';
import { adapters } from './adapters/index.mjs';
import { PR_PROVIDERS, ISSUE_PROVIDERS } from './lib/providers.mjs';

const TOOLS = [
  ['node',         'required', 'everything — this skill is Node-native'],
  ['docker',       'optional', 'image-level verification gates (version, ABI, extensions)'],
  ['git',          'optional', 'branch creation in write mode'],
  ['npm',          'node',     'dependency advisories + direct dependency floors'],
  ['pnpm',         'node',     'advisories for pnpm workspaces'],
  ['yarn',         'node',     'advisories for yarn projects'],
  ['php',          'php',      'extension list, Zend module API, thread safety'],
  ['composer',     'php',      'advisories, `prohibits`, `check-platform-reqs` — the whole PHP assess phase'],
  ['rector',       'php',      'automated code migration (80-90% of PHP version changes)'],
  ['phpstan',      'php',      'type-aware compatibility analysis'],
  ['phpcs',        'php',      'PHPCompatibility sniffs'],
  ['go',           'go',       'toolchain version and CGO inspection'],
  ['govulncheck',  'go',       'reachability-aware dependency advisories'],
  ['python3',      'python',   'interpreter version and wheel ABI tags'],
  ['pip-audit',    'python',   'dependency advisories'],
  ['ruby',         'ruby',     'interpreter version'],
  ['bundle',       'ruby',     'bundler-audit dependency advisories'],
  ['cargo',        'rust',     'cargo-audit dependency advisories'],
  ['rustc',        'rust',     'toolchain version'],
  ['java',         'java',     'JDK version and vendor'],
  ['mvn',          'java',     'dependency tree and update reports'],
  ['dotnet',       'dotnet',   '`dotnet list package --vulnerable` and SDK resolution'],
];

// Derived from the provider registries rather than hardcoded, so a new forge
// or tracker cannot silently go unreported here.
for (const p of PR_PROVIDERS)
  if (p.bin && p.bin !== 'git' && !TOOLS.some(t => t[0] === p.bin))
    TOOLS.push([p.bin, 'forge', `opening pull requests on ${p.label.replace(/ CLI$/, '')}`]);
for (const p of ISSUE_PROVIDERS)
  if (p.bin && !TOOLS.some(t => t[0] === p.bin))
    TOOLS.push([p.bin, 'tracker', `filing tickets in ${p.label.replace(/ \(.*\)$/, '')}`]);

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
  languages: adapters.map(a => {
    const probe = { node: 'node', php: 'php', go: 'go', python: 'python3',
                    ruby: 'ruby', rust: 'rustc', java: 'java', dotnet: 'dotnet' }[a.id];
    return {
      id: a.id, label: a.label,
      gateCapable: a.gateCapable,
      gateMetric: a.gateMetric || (a.gateCapable ? 'blocking' : null),
      gateNote: a.gateCapable ? null : a.gateNote,
      eolProduct: a.eolProduct, osvEcosystem: a.osvEcosystem,
      runtimeInstalled: probe ? have(probe) : false,
      // discovery and EOL/CVE research work without the runtime installed;
      // only local inspection (extensions, ABI stamps) needs it
      discoverable: true,
    };
  }),
  nvdApiKey: process.env.NVD_API_KEY ? 'set' : 'not set — PHP NVD lookups limited to 5 requests/30s',
  // every route needs SOME way out, so report which ones are usable right now
  pullRequestRoutes: PR_PROVIDERS.map(p => ({ id: p.id, label: p.label,
    usable: !p.bin || p.bin === 'git' || have(p.bin), needs: p.bin && p.bin !== 'git' ? p.bin : null })),
  issueRoutes: ISSUE_PROVIDERS.map(p => ({ id: p.id, label: p.label,
    usable: !p.bin || have(p.bin), needs: p.bin || null })),
  alwaysAvailable: {
    pullRequest: PR_PROVIDERS.filter(p => !p.bin || p.bin === 'git').map(p => p.id),
    issues: ISSUE_PROVIDERS.filter(p => !p.bin).map(p => p.id),
    note: 'these need no CLI, so there is always a way to ship the work',
  },
  missingRequired: tools.filter(t => t.scope === 'required' && !t.present).map(t => t.tool),
});
