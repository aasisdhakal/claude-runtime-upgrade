// Filesystem + HTTP helpers. Zero deps. Works on Node 14+ (https fallback
// for runtimes older than the global fetch introduced in 18).
import { readFileSync, writeFileSync, existsSync, mkdirSync, statSync, readdirSync, rmSync } from 'node:fs';
import { join, resolve, relative, dirname, basename } from 'node:path';
import { tmpdir } from 'node:os';

export { join, resolve, relative, dirname, basename, existsSync, readdirSync, statSync };

export const CACHE_DIR = process.env.RU_CACHE || join(tmpdir(), 'runtime-upgrade-cache');
export const OFFLINE = process.env.RU_OFFLINE === '1';

export function readText(p) { try { return readFileSync(p, 'utf8'); } catch { return null; } }
export function readJson(p) { const t = readText(p); if (t == null) return null; try { return JSON.parse(t); } catch { return null; } }

/** Read a dotted path out of an object without throwing. */
export function pick(obj, path, dflt = '') {
  let cur = obj;
  for (const k of String(path).split('.')) {
    if (cur == null || typeof cur !== 'object') return dflt;
    cur = cur[k];
  }
  return cur == null ? dflt : cur;
}

function cacheKey(url) {
  let h = 5381;
  for (let i = 0; i < url.length; i++) h = ((h * 33) ^ url.charCodeAt(i)) >>> 0;
  return h.toString(36) + '-' + url.length;
}

async function rawGet(url, headers) {
  if (typeof fetch === 'function') {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 25000);
    try {
      const r = await fetch(url, { headers, signal: ctl.signal });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return await r.text();
    } finally { clearTimeout(t); }
  }
  const { get } = await import('node:https');
  return await new Promise((ok, bad) => {
    const req = get(url, { headers, timeout: 25000 }, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume(); return rawGet(res.headers.location, headers).then(ok, bad);
      }
      if (res.statusCode !== 200) { res.resume(); return bad(new Error('HTTP ' + res.statusCode)); }
      let b = ''; res.setEncoding('utf8');
      res.on('data', d => b += d); res.on('end', () => ok(b));
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', bad);
  });
}

/**
 * GET with an on-disk cache. Returns {text, cached, stale, error}.
 * Never throws — callers degrade instead of dying.
 */
export async function fetchCached(url, { ttl = 86400, headers = {} } = {}) {
  mkdirSync(CACHE_DIR, { recursive: true });
  const f = join(CACHE_DIR, cacheKey(url));
  let cachedText = null, ageSec = Infinity;
  if (existsSync(f)) {
    cachedText = readText(f);
    try { ageSec = (Date.now() - statSync(f).mtimeMs) / 1000; } catch {}
  }
  if (cachedText != null && ageSec < ttl) return { text: cachedText, cached: true, stale: false };
  if (OFFLINE) {
    return cachedText != null
      ? { text: cachedText, cached: true, stale: true, error: 'offline: using cache' }
      : { text: null, cached: false, stale: false, error: 'offline and no cached copy' };
  }
  try {
    const text = await rawGet(url, { 'user-agent': 'runtime-upgrade-skill', ...headers });
    try { writeFileSync(f, text); } catch {}
    return { text, cached: false, stale: false };
  } catch (e) {
    if (cachedText != null) return { text: cachedText, cached: true, stale: true, error: String(e.message || e) };
    return { text: null, cached: false, stale: false, error: String(e.message || e) };
  }
}

export async function fetchJson(url, opts) {
  const r = await fetchCached(url, opts);
  if (r.text == null) return { data: null, ...r };
  try { return { data: JSON.parse(r.text), ...r }; }
  catch (e) { return { data: null, ...r, error: 'bad JSON: ' + e.message }; }
}

// Names that are USUALLY an artefact directory but are sometimes a real source
// tree. These are the only skips worth telling the user about.
const AMBIGUOUS_SKIP = new Set(['build', 'out', 'target', 'bin', 'obj', 'dist', 'tmp']);

const SKIP = new Set(['node_modules','vendor','.git','dist','build','.next','.nuxt','.venv','venv',
  '__pycache__','.turbo','coverage','target','bin','obj','.gradle','.terraform','tmp','.cache','out']);

/**
 * Recursive walk replacing `find`. Portable: no -printf, no bfs/BSD divergence.
 * Returns absolute paths of files whose basename matches `match`.
 */
export function walk(root, { match, maxDepth = 6, limit = 5000, skip = SKIP } = {}) {
  const hits = [];
  // Hitting a cap is not the same as finding everything. next.js scanned
  // 19,999 files and reported truncated:false; kubernetes lost 14 .go files to
  // the depth cap and grafana's real module pkg/build/wire/go.mod was invisible
  // because `build` is in the skip set. Silence on a big repo reads as a clean
  // result, so the walk now says what it could not see.
  hits.truncated = false;
  hits.deepest = 0;
  hits.depthCapped = [];
  hits.skipped = [];
  const stack = [[resolve(root), 0]];
  while (stack.length) {
    if (hits.length >= limit) { hits.truncated = true; break; }
    const [dir, depth] = stack.pop();
    if (depth > hits.deepest) hits.deepest = depth;
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      const full = join(dir, e.name);
      if (e.isSymbolicLink()) continue;
      if (e.isDirectory()) {
        if (skip.has(e.name) || e.name.startsWith('.') && skip.has(e.name)) {
          // Only the AMBIGUOUS names are worth reporting. `.git`, `node_modules`
          // and `__pycache__` are never source trees, so listing them is noise
          // that buries the one case that matters: grafana's real Go module
          // lives at pkg/build/wire, and `build` is in this set.
          if (AMBIGUOUS_SKIP.has(e.name) && hits.skipped.length < 40) hits.skipped.push(rel(root, full));
          continue;
        }
        if (depth < maxDepth) stack.push([full, depth + 1]);
        else if (hits.depthCapped.length < 40) hits.depthCapped.push(rel(root, full));
      } else if (e.isFile() && match(e.name)) {
        hits.push(full);
        if (hits.length >= limit) { hits.truncated = true; break; }
      }
    }
  }
  return hits;
}

/**
 * What a walk could not see, in a form worth printing. Returns null when the
 * walk was complete — so a caller can say nothing, honestly.
 */
export function walkGaps(hits, { what = 'files' } = {}) {
  const g = {};
  if (hits.truncated) g.hitFileCap = `stopped after ${hits.length} ${what} — there are more`;
  if (hits.depthCapped?.length)
    g.belowDepthLimit = { count: hits.depthCapped.length, examples: hits.depthCapped.slice(0, 5),
                          meaning: 'directories deeper than the walk limit were never opened' };
  if (hits.skipped?.length)
    g.skippedByName = { count: hits.skipped.length, examples: hits.skipped.slice(0, 5),
                        meaning: 'skipped by name as artefact directories, but these names are ambiguous — '
                               + 'check whether any is a real source tree (grafana keeps a Go module at pkg/build/wire)' };
  return Object.keys(g).length ? g : null;
}

/** Path relative to root, with the root itself rendered as "." */
export function rel(root, p) {
  const r = relative(resolve(root), resolve(p));
  return r === '' ? '.' : r;
}

/**
 * Write the JSON result, and optionally set the process exit code.
 *
 * `emit(obj, 1)` previously discarded the second argument entirely, so
 * probe.mjs — which ends `}, outcome === 'changed' ? 1 : 0)` — always exited 0.
 * A CI job gating on exit status passed a probe that had just found a
 * behaviour change. Found by an agent actually using the runner.
 *
 * Sets `process.exitCode` rather than calling `process.exit()`: exit() can
 * truncate stdout mid-write on a pipe, which would corrupt the very JSON the
 * caller is about to parse. Setting the code lets the process drain and exit
 * naturally with the right status.
 */
export function emit(obj, code) {
  process.stdout.write(JSON.stringify(obj, null, 2) + '\n');
  if (typeof code === 'number' && code !== 0) process.exitCode = code;
}
export function die(msg, code = 1) { process.stderr.write('ERROR: ' + msg + '\n'); process.exit(code); }

/**
 * Split argv into positionals and flags, knowing which flags TAKE A VALUE.
 *
 * `argv.filter(a => !a.startsWith('--'))` cannot know that, so a flag's value
 * silently became a positional: `scan.mjs java <dir> 17 --max 50` scanned the
 * window 17 -> "50" instead of reporting a missing target, and
 * `plan.mjs --target 21 <dir>` resolved "21" as the DIRECTORY.
 *
 * `valueFlags` lists the flags that consume the next argument. Anything else
 * starting with `--` is a boolean.
 */
export function parseArgv(argv, valueFlags = []) {
  const takesValue = new Set(valueFlags);
  const positional = [], flags = {}, bools = new Set();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) { positional.push(a); continue; }
    const name = a.slice(2).split('=')[0];
    if (a.includes('=')) { flags[name] = a.slice(a.indexOf('=') + 1); continue; }
    if (takesValue.has(name)) { flags[name] = argv[++i]; continue; }
    bools.add(name);
  }
  return {
    positional, flags,
    flag: n => flags[n] ?? null,
    has: n => bools.has(n) || n in flags,
  };
}
