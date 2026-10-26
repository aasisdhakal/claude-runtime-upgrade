// What ACTUALLY changed in a dependency upgrade, per ecosystem.
//
// The manifest says what you asked for ("^2.1.0"); the lockfile says what you
// got. Only the lockfile can tell you a transitive dependency moved three
// majors while your direct dependency looks untouched — and transitive moves
// are where silent behaviour changes hide.
import { readText } from './io.mjs';

const num = v => String(v).split(/[.+-]/).map(x => (/^\d+$/.test(x) ? +x : x));
const cmpVer = (x, y) => {
  const A = num(x), B = num(y);
  for (let i = 0; i < Math.max(A.length, B.length); i++) {
    const a = A[i] ?? 0, b = B[i] ?? 0;
    if (a === b) continue;
    return typeof a === typeof b ? (a < b ? -1 : 1) : (typeof a === 'number' ? -1 : 1);
  }
  return 0;
};

const j = t => { try { return JSON.parse(t); } catch { return null; } };

// one exit point for every parser branch: unique + sorted, so set comparison is
// order-independent and a lockfile reshuffle is not mistaken for an upgrade
const done = out => {
  for (const k of Object.keys(out)) out[k] = [...new Set(out[k])].sort(cmpVer);
  return out;
};

// A large repo installs the SAME package at several versions at once: nest has
// semver at 2 versions and glob at 4. Keying `name -> version` collapsed those
// to whichever came last in iteration order, which both HID real moves (4 of 6
// seeded changes went undetected on nest) and would invent false ones when that
// order shifted. Small repos never show this — every package has one copy.
//
// There is no honest way to pair up duplicate copies without the resolution
// graph, so don't try: record the SET of versions a name is installed at and
// compare sets. A version that appears on one side only is a real move.

/** name -> sorted unique version list, from a lockfile's text. */
export function parseLock(kind, text) {
  if (!text) return {};
  const out = {};
  const add = (n, v) => { if (!n || !v) return; (out[n] ??= []).push(String(v)); };
  if (kind === 'package-lock.json') {
    const o = j(text); if (!o) return done(out);
    for (const [p, v] of Object.entries(o.packages || {})) {
      if (!p || !v?.version) continue;
      add(p.replace(/^node_modules\//, '').replace(/.*\/node_modules\//, ''), v.version);
    }
    // lockfile v1 has no `packages`; walk the nested `dependencies` tree instead
    (function walk(d) {
      for (const [n, v] of Object.entries(d || {})) {
        if (v?.version) add(n, v.version);
        if (v?.dependencies) walk(v.dependencies);
      }
    })(o.dependencies);
    return done(out);
  }
  if (kind === 'composer.lock') {
    const o = j(text); if (!o) return done(out);
    for (const p of [...(o.packages || []), ...(o['packages-dev'] || [])])
      if (p?.name && p?.version) add(p.name, String(p.version).replace(/^v/, ''));
    return done(out);
  }
  if (kind === 'pnpm-lock.yaml') {
    // Three key spellings across lockfile versions, and the quoted one is the
    // current default:
    //   v6:  `  /@babel/core@7.26.10:`
    //   v9:  `  '@babel/core@7.26.10':`   <- quoted, and ONLY scoped names are
    //   v9:  `  postcss@8.5.23:`             quoted, so an unquoted-only pattern
    // silently dropped every scoped package. On next.js that was 2113 entries —
    // 0 scoped parsed out of 1785 — hiding exactly the packages that matter most
    // (@babel/*, @swc/*, @next/*).
    for (const m of text.matchAll(/^\s{2}'?\/?((?:@[^/\s']+\/)?[^/\s@']+)@([\d][^:\s('"]*)/gm))
      add(m[1], m[2]);
    return done(out);
  }
  if (kind === 'yarn.lock') {
    let name = null;
    for (const line of text.split('\n')) {
      const h = line.match(/^"?((?:@[^/]+\/)?[^@"\s]+)@/);
      if (h && !line.startsWith(' ')) { name = h[1]; continue; }
      const v = line.match(/^\s+version:?\s+"?([^"\s]+)/);
      if (v && name) { add(name, v[1]); name = null; }
    }
    return done(out);
  }
  if (kind === 'Cargo.lock') {
    for (const b of text.split('[[package]]').slice(1)) {
      const n = b.match(/^\s*name\s*=\s*"([^"]+)"/m), v = b.match(/^\s*version\s*=\s*"([^"]+)"/m);
      if (n && v) add(n[1], v[1]);
    }
    return done(out);
  }
  if (kind === 'go.sum') {
    for (const m of text.matchAll(/^(\S+)\s+v(\S+?)(?:\/go\.mod)?\s/gm)) add(m[1], m[2]);
    return done(out);
  }
  if (kind === 'Gemfile.lock') {
    for (const m of text.matchAll(/^\s{4}([a-zA-Z0-9_.-]+) \(([^)]+)\)/gm)) add(m[1], m[2]);
    return done(out);
  }
  if (kind === 'poetry.lock' || kind === 'uv.lock') {
    for (const b of text.split(/\[\[package\]\]/).slice(1)) {
      const n = b.match(/^\s*name\s*=\s*"([^"]+)"/m), v = b.match(/^\s*version\s*=\s*"([^"]+)"/m);
      if (n && v) add(n[1], v[1]);
    }
    return done(out);
  }
  if (kind === 'mix.lock') {
    for (const m of text.matchAll(/"([^"]+)":\s*\{:hex,\s*:[^,]+,\s*"([^"]+)"/g)) add(m[1], m[2]);
    return done(out);
  }
  return done(out);
}

export const LOCKFILES = [
  'package-lock.json', 'pnpm-lock.yaml', 'yarn.lock', 'composer.lock',
  'Cargo.lock', 'go.sum', 'Gemfile.lock', 'poetry.lock', 'uv.lock', 'mix.lock',
];

const part = v => String(v).replace(/^[v^~>=<\s]+/, '').split(/[.+-]/).map(n => parseInt(n, 10) || 0);

/** How far a version moved, and whether that crosses a major. */
export function bump(from, to) {
  if (!from || !to || from === to) return null;
  const a = part(from), b = part(to);
  const level = a[0] !== b[0] ? 'major' : a[1] !== b[1] ? 'minor' : 'patch';
  return { from, to, level, majorsCrossed: Math.max(0, (b[0] || 0) - (a[0] || 0)) };
}

/** Compare two lockfile snapshots. */
export function diffLocks(kind, beforeText, afterText) {
  const a = parseLock(kind, beforeText), b = parseLock(kind, afterText);
  const changed = [], added = [], removed = [];
  for (const name of new Set([...Object.keys(a), ...Object.keys(b)])) {
    const was = a[name] || [], now = b[name] || [];
    const gone = was.filter(v => !now.includes(v));
    const fresh = now.filter(v => !was.includes(v));
    if (!gone.length && !fresh.length) continue;          // same set: nothing moved
    if (!was.length) { added.push({ name, to: now[now.length - 1], versions: now }); continue; }
    if (!now.length) { removed.push({ name, from: was[was.length - 1], versions: was }); continue; }
    // compare the highest version that left against the highest that arrived —
    // the biggest move is the one worth probing first
    const from = gone.length ? gone[gone.length - 1] : was[was.length - 1];
    const to = fresh.length ? fresh[fresh.length - 1] : now[now.length - 1];
    const d = bump(from, to);
    if (!d) continue;
    const e = { name, ...d };
    // a package installed at several versions at once is itself worth saying:
    // the probe has to pick which copy the call site actually resolves to
    if (was.length > 1 || now.length > 1) {
      e.copies = { before: was, after: now };
      e.note = `installed at ${now.length} version(s) simultaneously — a call site may resolve to any of them`;
    }
    changed.push(e);
  }
  const order = { major: 0, minor: 1, patch: 2 };
  changed.sort((x, y) => (order[x.level] - order[y.level]) || y.majorsCrossed - x.majorsCrossed);
  return { kind, changed, added, removed,
           counts: { changed: changed.length, added: added.length, removed: removed.length,
                     major: changed.filter(c => c.level === 'major').length,
                     duplicated: changed.filter(c => c.copies).length } };
}
