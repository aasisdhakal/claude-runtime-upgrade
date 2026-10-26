#!/usr/bin/env node
// Phase 1 — DISCOVER. Portable replacement for detect.sh.
// No find(1), no jq, no python3, no mapfile, no paste. Runs on macOS, Linux, WSL.
// usage: node detect.mjs [root]
import { walk, readText, readJson, existsSync, join, resolve, rel, emit, die, readdirSync } from './lib/io.mjs';
import { adapters, matchesManifest, adaptersForManifest } from './adapters/index.mjs';
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
          // `node-version: [24, 26]` is the most common matrix form and was
          // invisible: the old pattern only read a single scalar after the
          // colon, so fastify's real matrix (24, 26) was missed and a lone
          // non-matrix job pinned at 20 was reported instead.
          const list = line.match(/:\s*\[([^\]]+)\]/);
          if (list) {
            for (const v of list[1].split(',')) {
              const n = v.trim().replace(/^["']|["']$/g, '');
              if (/^[0-9][0-9.xX]*$/.test(n)) versions.push(n);
            }
          } else {
            const m = line.match(/:\s*["']?([0-9][0-9.xX]*)/);
            if (m) versions.push(m[1]);
          }
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
// Trees that are not deployables. Reported separately rather than dropped —
// a fixture pinned to an EOL runtime is worth knowing about, it just is not
// upgrade WORK and must not carry story points or be chosen as the pilot.
const NOISE = /(^|\/)(examples?|samples?|fixtures?|testdata|test-?data|benchmarks?|docs?|website|demo|\.devcontainer|\.github|tests?)(\/|$)/i;
const allManifestPaths = walk(ROOT, { match: matchesManifest });
const manifestPaths = allManifestPaths.filter(p => !NOISE.test(rel(ROOT, p)));
const ancillaryPaths = allManifestPaths.filter(p => NOISE.test(rel(ROOT, p)));
const dockerPaths = walk(ROOT, { match: n => n === 'Dockerfile' || n.startsWith('Dockerfile.') });

// ---------- classify repo shape ----------
const rootPkg = readJson(join(ROOT, 'package.json'));
const rootComposer = readJson(join(ROOT, 'composer.json'));
// shape was Node/PHP-only: a repo with go.mod or pyproject.toml at its root
// was classified "no-manifest", which is the one shape that means "stop".
const rootManifests = [];
for (const a of adapters) for (const m of a.manifests)
  if (existsSync(join(ROOT, m)) && !rootManifests.includes(m)) rootManifests.push(m);
const rootLangs = [...new Set(adapters
  .filter(a => a.manifests.some(m => existsSync(join(ROOT, m))))
  .map(a => a.id))];
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

let shape;   // provisional — finalised below, once targets are known

// ---------- scan each manifest with its adapter ----------
const targets = [];
const seenDirs = new Set();
for (const p of manifestPaths) {
  const filename = p.split('/').pop();
  const dir = p.slice(0, -(filename.length + 1)) || ROOT;
  for (const adapter of adaptersForManifest(filename)) {
  // one target per (dir, adapter): Java has pom.xml AND build.gradle,
  // .NET has global.json AND *.csproj, Python has several manifests
  if (seenDirs.has(dir + '::' + adapter.id)) continue;
  const imgs = dockerImages(dir);
  const ci = ciInfo(dir, adapter);
  try {
    const tgt = adapter.scan({ dir, root: ROOT, dockerImages: imgs, ciText: ci.matrix ? '' : ci.text });
    // Several adapters can claim one filename: Bun also reads package.json,
    // Java also reads build.gradle.kts. Only the adapter for which this is the
    // PRIMARY manifest owns the directory on that basis alone.
    tgt.primaryManifest = adapter.manifests[0] === filename;
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

// an adapter can match a shared manifest (build.gradle.kts) yet find no version
// and no dependencies — that is a non-target, not a finding
// The ROOT manifest is the project itself — a package.json with a name but no
// dependencies is still the thing being upgraded. Pruning it made a real repo
// report zero targets.
// The ROOT manifest is the project itself — a package.json with a name but no
// dependencies is still the thing being upgraded, so it is never pruned. But
// only for the adapter that OWNS that filename; a secondary claimant needs its
// own evidence.
const meaningful = targets.filter(t =>
  (t.dir === '.' && t.primaryManifest) || t.error || t.containerOnly
  || t.declaredMajors || t.deps > 0 || t.devDeps > 0 || t.lockfile);
targets.length = 0; targets.push(...meaningful);

// Shape is decided from RESOLVED targets, not from which adapters merely claim
// a filename. Bun claims package.json and Kotlin claims build.gradle.kts, so
// classifying on claims alone reported every Node repo as "mixed-single".
// a container-only target has no manifest, so it must not make the repo look
// like a manifest-pinned single-language project
const rootTargetLangs = [...new Set(targets
  .filter(t => t.dir === '.' && t.declaredMajors && !t.containerOnly).map(t => t.lang))];
if (gitChildren >= 2) shape = 'polyrepo';
else if (isWorkspace) shape = 'monorepo';
else if (rootTargetLangs.length > 1) shape = 'mixed-single';
else if (rootTargetLangs.length === 1) shape = 'single';
else if (targets.some(t => !t.containerOnly)) shape = 'multi-package';
else if (targets.length || dockerPaths.length) shape = 'container-only';
else shape = 'no-manifest';

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
  ancillaryTargets: ancillaryPaths.map(p => rel(ROOT, p)),
  ancillaryNote: ancillaryPaths.length
    ? 'test fixtures, examples, docs and .devcontainer/.github trees. Worth knowing about, '
    + 'but they are not deployables: no story points, never the pilot.'
    : null,
  allTargetsUndeclared: targets.length > 0 && targets.every(t => !t.declaredMajors),
  undeclaredGuidance: targets.length > 0 && targets.every(t => !t.declaredMajors)
    ? 'No target declares a runtime anywhere in its manifest or version files. That is itself '
    + 'the finding: nothing pins the version, so CI and production can drift apart silently. '
    + 'Check the CI field below for what is actually used, and add a pin.'
    : null,
  shapeGuidance: {
    single: 'one target, straightforward',
    monorepo: 'upgrade the ROOT runtime pin once; each workspace gets its own compat pass. Do not file one ticket per package',
    polyrepo: 'each repo is its own unit of work with its own branch and rollback',
    'mixed-single': 'two runtimes in one repo — run both adapters, upgrade them in SEPARATE commits',
    'multi-package': 'no manifest at the root, but packages below it. Treat each as its own target; the root pins nothing',
    'container-only': 'runtime pinned only in a Dockerfile. Add a manifest pin as part of the work, or nothing enforces the version',
    'no-manifest': 'nothing to upgrade until someone declares a runtime — report and stop',
  }[shape],
  targets,
});
