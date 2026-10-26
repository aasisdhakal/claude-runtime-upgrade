#!/usr/bin/env node
// Phase 1 — DISCOVER. Portable replacement for detect.sh.
// No find(1), no jq, no python3, no mapfile, no paste. Runs on macOS, Linux, WSL.
// usage: node detect.mjs [root]
import { walk, readText, readJson, existsSync, join, resolve, rel, emit, die, readdirSync } from './lib/io.mjs';
import { adapters, allManifests, adapterForManifest } from './adapters/index.mjs';

const ROOT = resolve(process.argv[2] || '.');
if (!existsSync(ROOT)) die(`no such directory: ${ROOT}`);

const CI_GLOBS = [
  '.github/workflows', '.gitlab-ci.yml', 'bitbucket-pipelines.yml', 'azure-pipelines.yml',
  'Jenkinsfile', '.circleci/config.yml', 'buildspec.yml', 'buildspec.yaml',
  'buildspec-dev.yaml', 'buildspec-prod.yaml', 'staging-buildspec.yaml',
];
const CI_RE = /(?:node|php)[-_]?version:?\s*["']?([0-9][0-9.xX]*)|image:\s*((?:node|php|bun|deno):[0-9][^\s"']*)/gi;
const FROM_RE = /^[ \t]*FROM[ \t]+(?:--\S+[ \t]+)*(\S+)/gim;

/** Every runtime image referenced by any FROM line, normalised to name:tag. */
function dockerImages(dir) {
  const out = [];
  let names;
  try { names = readdirSync(dir).filter(n => n === 'Dockerfile' || n.startsWith('Dockerfile.')); }
  catch { return out; }
  for (const n of names) {
    const text = readText(join(dir, n));
    if (!text) continue;
    for (const m of text.matchAll(FROM_RE)) {
      const img = m[1];
      // strip registry/namespace: public.ecr.aws/docker/library/node:20 -> node:20
      const short = img.split('/').pop();
      if (/^(node|php|bun|deno|composer)[:@]/i.test(short)) out.push(short);
    }
  }
  return [...new Set(out)];
}

function ciText(dir) {
  const found = [];
  for (const g of CI_GLOBS) {
    const p = join(dir, g);
    if (!existsSync(p)) continue;
    let files = [p];
    try { if (readdirSync(p).length) files = readdirSync(p).map(n => join(p, n)); } catch {}
    for (const f of files) {
      const t = readText(f);
      if (!t) continue;
      for (const m of t.matchAll(CI_RE)) found.push(m[1] || m[2]);
    }
  }
  return [...new Set(found)].slice(0, 4).join(' | ');
}

// ---------- locate manifests + dockerfiles ----------
const manifestPaths = walk(ROOT, { match: n => allManifests.has(n) });
const dockerPaths = walk(ROOT, { match: n => n === 'Dockerfile' || n.startsWith('Dockerfile.') });

// ---------- classify repo shape ----------
const rootPkg = readJson(join(ROOT, 'package.json'));
const rootComposer = readJson(join(ROOT, 'composer.json'));
const isWorkspace =
  !!(rootPkg && (rootPkg.workspaces || rootPkg.private && manifestPaths.length > 2)) ||
  existsSync(join(ROOT, 'pnpm-workspace.yaml')) ||
  existsSync(join(ROOT, 'turbo.json')) ||
  existsSync(join(ROOT, 'nx.json')) ||
  existsSync(join(ROOT, 'lerna.json'));

let gitChildren = 0;
try {
  for (const e of readdirSync(ROOT, { withFileTypes: true })) {
    if (e.isDirectory() && existsSync(join(ROOT, e.name, '.git'))) gitChildren++;
  }
} catch {}

let shape;
if (gitChildren >= 2) shape = 'polyrepo';
else if (isWorkspace) shape = 'monorepo';
else if (rootPkg && rootComposer) shape = 'mixed-single';
else if (rootPkg || rootComposer) shape = 'single';
else if (dockerPaths.length) shape = 'container-only';
else shape = 'no-manifest';

// ---------- scan each manifest with its adapter ----------
const targets = [];
const seenDirs = new Set();
for (const p of manifestPaths) {
  const filename = p.split('/').pop();
  const adapter = adapterForManifest(filename);
  if (!adapter) continue;
  const dir = p.slice(0, -(filename.length + 1)) || ROOT;
  const imgs = dockerImages(dir);
  const ci = ciText(dir);
  try {
    targets.push(adapter.scan({ dir, root: ROOT, dockerImages: imgs, ciText: ci }));
    seenDirs.add(dir + '::' + adapter.id);
  } catch (e) {
    targets.push({ lang: adapter.id, dir: rel(ROOT, dir), error: String(e.message || e) });
  }
}

// ---------- container-only targets (runtime pinned ONLY in a Dockerfile) ----------
for (const df of dockerPaths) {
  const dir = df.slice(0, df.lastIndexOf('/')) || ROOT;
  const imgs = dockerImages(dir);
  if (!imgs.length) continue;
  for (const a of adapters) {
    if (seenDirs.has(dir + '::' + a.id)) continue;
    const mine = imgs.filter(s => a.imageRe && new RegExp(a.imageRe.source, 'i').test(s));
    if (!mine.length) continue;
    const majors = [...new Set(mine.map(s => (s.match(/[:@]v?(\d+)/) || [])[1]).filter(Boolean))];
    targets.push({
      lang: a.id, name: dir.split('/').pop(), dir: rel(ROOT, dir), manifest: '',
      declared: { dockerfile: mine.join(' | '), ci: ciText(dir) },
      lockfile: '', declaredMajors: majors.join(','), drift: majors.length > 1,
      deps: 0, devDeps: 0, containerOnly: true,
    });
    seenDirs.add(dir + '::' + a.id);
  }
}

const driftCount = targets.filter(t => t.drift).length;
const undeclared = targets.filter(t => !t.declaredMajors).length;

emit({
  root: ROOT,
  shape,
  scannedAt: new Date().toISOString(),
  targetCount: targets.length,
  driftCount,
  undeclaredCount: undeclared,
  languages: [...new Set(targets.map(t => t.lang))],
  shapeGuidance: {
    single: 'one target, straightforward',
    monorepo: 'upgrade the ROOT runtime pin once; each workspace gets its own compat pass. Do not file one ticket per package',
    polyrepo: 'each repo is its own unit of work with its own branch and rollback',
    'mixed-single': 'two runtimes in one repo — run both adapters, upgrade them in SEPARATE commits',
    'container-only': 'runtime pinned only in a Dockerfile. Add a manifest pin as part of the work, or nothing enforces the version',
    'no-manifest': 'nothing to upgrade until someone declares a runtime — report and stop',
  }[shape],
  targets,
});
