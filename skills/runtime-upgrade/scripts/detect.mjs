#!/usr/bin/env node
// Phase 1 — DISCOVER. Portable replacement for detect.sh.
// No find(1), no jq, no python3, no mapfile, no paste. Runs on macOS, Linux, WSL.
// usage: node detect.mjs [root]
import { walk, readText, readJson, existsSync, join, resolve, rel, emit, die, readdirSync } from './lib/io.mjs';
import { adapters, matchesManifest, adapterForManifest } from './adapters/index.mjs';
import { detectFrameworks } from './lib/frameworks.mjs';

const ROOT = resolve(process.argv[2] || '.');
if (!existsSync(ROOT)) die(`no such directory: ${ROOT}`);

const CI_GLOBS = [
  '.github/workflows', '.gitlab-ci.yml', 'bitbucket-pipelines.yml', 'azure-pipelines.yml',
  'Jenkinsfile', '.circleci/config.yml', 'buildspec.yml', 'buildspec.yaml',
  'buildspec-dev.yaml', 'buildspec-prod.yaml', 'staging-buildspec.yaml',
];
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
      if (/^(node|php|python|pypy|ruby|jruby|golang|go|rust|eclipse-temurin|amazoncorretto|openjdk|ibm-semeru|graalvm|sapmachine|bun|deno|composer)[:@]/i.test(short)) out.push(short);
      // mcr.microsoft.com/dotnet/sdk:8.0 — the useful part is two segments deep
      else if (/dotnet\/(sdk|runtime|aspnet)[:@]/i.test(img)) out.push(img.split('/').slice(-2).join('/'));
    }
  }
  return [...new Set(out)];
}

/**
 * CI version declarations, scoped to ONE adapter.
 * Reading every `*-version:` key and attributing it to whichever adapter is
 * scanning the directory makes a Node project inherit a `python-version` from
 * the same workflow file. Each adapter supplies its own key pattern.
 *
 * Returns { text, versions[] }. More than one distinct version means a TEST
 * MATRIX, which is deliberate and must not be reported as drift.
 */
function ciInfo(dir, adapter) {
  const versions = [];
  const keyRe = adapter.ciKey;
  for (const g of CI_GLOBS) {
    const p = join(dir, g);
    if (!existsSync(p)) continue;
    let files = [p];
    try { if (readdirSync(p).length) files = readdirSync(p).map(n => join(p, n)); } catch {}
    for (const f of files) {
      const t = readText(f);
      if (!t) continue;
      for (const line of t.split('\n')) {
        // skip templated values: `python-version: ${{ matrix.python }}`
        if (/\$\{\{/.test(line)) continue;
        if (keyRe && keyRe.test(line)) {
          const m = line.match(/:\s*["']?([0-9][0-9.xX]*)/);
          if (m) versions.push(m[1]);
        }
        const im = line.match(/image:\s*["']?(\S+)/);
        if (im) {
          const short = im[1].split('/').pop();
          const re = new RegExp(adapter.imageRe.source, 'i');
          if (re.test(short)) { const v = short.match(/[:@]v?([0-9][^\s"']*)/); if (v) versions.push(v[1]); }
        }
      }
    }
  }
  const uniq = [...new Set(versions)];
  return { text: uniq.slice(0, 4).join(' | '), versions: uniq, matrix: uniq.length > 1 };
}

/** Dependency map for framework detection, per ecosystem. */
function manifestDeps(dir, lang) {
  if (lang === 'node') {
    const p = readJson(join(dir, 'package.json')) || {};
    return { ...p.dependencies, ...p.devDependencies };
  }
  if (lang === 'php') {
    const c = readJson(join(dir, 'composer.json')) || {};
    return { ...c.require, ...c['require-dev'] };
  }
  if (lang === 'python') {
    const t = (readText(join(dir, 'requirements.txt')) || '') + '\n' + (readText(join(dir, 'pyproject.toml')) || '');
    const out = {};
    for (const m of t.matchAll(/^\s*["']?([A-Za-z][\w.-]*)["']?\s*[>=~^]{1,2}\s*["']?([\d.]+)/gm)) out[m[1]] = m[2];
    return out;
  }
  if (lang === 'ruby') {
    const g = readText(join(dir, 'Gemfile')) || '';
    const out = {};
    for (const m of g.matchAll(/^\s*gem\s+["']([^"']+)["'](?:\s*,\s*["']([^"']+)["'])?/gm)) out[m[1]] = m[2] || '*';
    return out;
  }
  if (lang === 'java') {
    const pom = readText(join(dir, 'pom.xml')) || '';
    const out = {};
    for (const m of pom.matchAll(/<artifactId>\s*([^<\s]+)\s*<\/artifactId>\s*(?:<version>\s*([^<\s]+))?/g)) out[m[1]] = m[2] || '*';
    return out;
  }
  return {};
}

// ---------- locate manifests + dockerfiles ----------
const manifestPaths = walk(ROOT, { match: matchesManifest });
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
  // one target per (dir, adapter): Java has pom.xml AND build.gradle,
  // .NET has global.json AND *.csproj, Python has several manifests
  if (seenDirs.has(dir + '::' + adapter.id)) continue;
  const imgs = dockerImages(dir);
  const ci = ciInfo(dir, adapter);
  try {
    const tgt = adapter.scan({ dir, root: ROOT, dockerImages: imgs, ciText: ci.matrix ? '' : ci.text });
    // frameworks are often the real blocker, not the runtime
    const fw = detectFrameworks(adapter.id, manifestDeps(dir, adapter.id));
    if (fw.found.length) tgt.frameworks = fw.found;
    if (fw.untracked.length) tgt.frameworksUntracked = fw.untracked;
    // a CI test matrix is intentional breadth, not disagreement
    if (ci.matrix) { tgt.ciMatrix = ci.versions; tgt.declared.ci = ci.text + '  (test matrix)'; }
    targets.push(tgt);
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
      declared: { dockerfile: mine.join(' | '), ci: ciInfo(dir, a).text },
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
