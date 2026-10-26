#!/usr/bin/env node
// Phase 2 — RESEARCH. EOL windows + runtime CVE exposure.
// usage: node research.mjs <lang> <current-version> [target-version]
import { fetchJson, emit, die, OFFLINE } from './lib/io.mjs';
import { byId } from './adapters/index.mjs';
import { rangeMajor, rangeMajorMinor, compare } from './lib/semver.mjs';

const argv = process.argv.slice(2);
const [langArg, current, targetArg] = argv.filter(a => !a.startsWith('--'));
if (!langArg || !current) die('usage: research.mjs <lang|product> <current-version> [target] [--product <endoflife-slug>]', 2);

/**
 * Any of the 485 products endoflife.date tracks can be researched, adapter or
 * not. With an adapter you also get runtime-CVE gating and discovery; without
 * one you still get EOL, support windows and a target recommendation.
 */
const pi = argv.indexOf('--product');
const explicitProduct = pi >= 0 ? argv[pi + 1] : null;
let A = byId[langArg];
if (!A) {
  const product = explicitProduct || langArg;
  A = {
    id: langArg, label: langArg, eolProduct: product, osvEcosystem: null,
    gateCapable: false, generic: true,
    gateNote: `No adapter exists for "${langArg}". EOL and support windows come from `
            + `endoflife.date/${product}; there is no runtime CVE gating, no discovery and no `
            + `remediation for it. Add an adapter under scripts/adapters/ to get those.`,
    cveSource: { url: null, note: 'none — generic endoflife.date lookup only' },
  };
}

const today = new Date().toISOString().slice(0, 10);
const isNode = A.id === 'node';
// Node/Java/.NET use integer majors; the rest use MAJOR.MINOR cycles
const intMajor = ['node', 'java', 'dotnet'].includes(A.id);
const majorOf = intMajor ? rangeMajor : rangeMajorMinor;
const curMajor = majorOf(current);

// ---------- EOL: endoflife.date, identical shape for all 485 products ----------
const eolRes = await fetchJson(`https://endoflife.date/api/${A.eolProduct}.json`);
if (!eolRes.data) die(`cannot reach endoflife.date for ${A.eolProduct}: ${eolRes.error}`);
const cycles = eolRes.data;
const find = c => cycles.find(x => String(x.cycle) === String(c)) || {};

const notEol = c => c.eol === false || (typeof c.eol === 'string' && c.eol > today);
const inSupport = c => c.support === false || (typeof c.support === 'string' && c.support > today);
const isLts = c => c.lts !== false && c.lts != null;

// target: newest cycle still in ACTIVE support; else newest not-yet-EOL
let target = targetArg;
if (!target) {
  const prefer = isNode
    ? cycles.filter(c => notEol(c) && isLts(c))
    : cycles.filter(c => notEol(c) && inSupport(c));
  const pool = prefer.length ? prefer : cycles.filter(notEol);
  const best = pool.sort((a, b) => compare(String(a.cycle), String(b.cycle))).pop();
  target = best?.latest || '';
}
let tgtMajor = majorOf(target);
let cur = find(curMajor), tgt = find(tgtMajor);

// A newer number is not automatically a better target. Java 27 is non-LTS and
// loses support in 2027-04; Java 17 is supported to 2029-10. "Upgrading" there
// SHORTENS the support window by 2.5 years. Only auto-selected targets are
// corrected — an explicit --target is the user's call.
let targetDowngradesSupport = false;
if (!targetArg && cur.eol && tgt.eol && typeof cur.eol === 'string' && typeof tgt.eol === 'string'
    && tgt.eol < cur.eol) {
  const better = cycles
    .filter(c => typeof c.eol === 'string' && c.eol > cur.eol && compare(String(c.cycle), curMajor) > 0)
    .sort((a, b) => compare(String(a.cycle), String(b.cycle)))[0];
  if (better) { target = better.latest; tgtMajor = majorOf(target); tgt = find(tgtMajor); }
  else targetDowngradesSupport = true;
}

// amazon-corretto publishes latest as "21.0.13.0.10"; nobody targets that
// string. Trim AFTER any correction above, or the correction reintroduces it.
if (intMajor && /^\d+(\.\d+){3,}/.test(String(target))) {
  target = String(target).split('.')[0];
  tgtMajor = majorOf(target);
}

// ---------- runtime CVEs ----------
// Three shapes exist. Only the first two can gate:
//   static-db  node  -> nodejs/security-wg, severity-rated, gate on high/critical
//   osv        go    -> OSV `stdlib`, version-ranged but NO severity, gate on total
//   none       rest  -> advisory only; the adapter says why in gateNote
let currentCve = { total: 0, counts: {}, blocking: 0, cves: [], source: A.cveSource.note };
let targetCve = { ...currentCve, cves: [] };
let cveError = null;
const gateMetric = A.gateMetric || (A.gateCapable ? 'blocking' : null);

if (A.matchRuntimeCve && A.cveSource.url) {                 // static database (node)
  const db = await fetchJson(A.cveSource.url);
  if (!db.data) cveError = db.error || 'CVE database unavailable';
  else {
    const probe = /\d+\.\d+\.\d+/.test(current) ? current : (cur.latest || current);
    currentCve = summarise(A.matchRuntimeCve(db.data, probe), probe);
    if (target) targetCve = summarise(A.matchRuntimeCve(db.data, target), target);
    if (db.stale) cveError = 'using stale cached CVE database: ' + (db.error || '');
  }
} else if (typeof A.runtimeCves === 'function') {           // OSV-backed (go)
  const probe = /\d+\.\d+/.test(current) ? (cur.latest || current) : current;
  const a = await A.runtimeCves(probe);
  currentCve = summarise(a.hits, probe);
  if (target) { const b = await A.runtimeCves(target); targetCve = summarise(b.hits, target); }
  if (a.error) cveError = a.error;
} else {                                                    // no curated source
  cveError = A.gateNote || 'no curated runtime CVE database for this runtime';
  if (A.id === 'php' && process.env.RU_NVD === '1' && !OFFLINE) {
    const v = cur.latest || current;
    const key = process.env.NVD_API_KEY;
    const r = await fetchJson(
      A.cveSource.url.replace('{version}', v) + '&resultsPerPage=1',
      { ttl: 3600, headers: key ? { apiKey: key } : {} },
    );
    currentCve.nvdCpeTotal = r.data?.totalResults ?? null;
    currentCve.nvdNote =
      `HISTORICAL count for php:${v}, NOT "unpatched at this version". Triage by hand.` +
      (key ? '' : ' No NVD_API_KEY set — limited to 5 requests/30s.');
    if (r.error) currentCve.nvdError = r.error;
  }
}

function summarise(hits, version) {
  const order = { critical: 0, high: 1, medium: 2, low: 3, unknown: 4 };
  hits.sort((a, b) => (order[a.severity] ?? 9) - (order[b.severity] ?? 9));
  const counts = {};
  for (const h of hits) counts[h.severity] = (counts[h.severity] || 0) + 1;
  return {
    version, total: hits.length, counts,
    blocking: (counts.critical || 0) + (counts.high || 0),
    cves: hits,
  };
}

/**
 * Release cycles between current and target, counted from the actual
 * endoflife.date cycle list. Heuristics got this badly wrong: Ruby 2.7 -> 4.0
 * is six published cycles, not "two majors"; Deno 2.0 -> 2.9 is nine.
 */
const cycleOrder = cycles.map(c => String(c.cycle)).sort((a, b) => compare(a, b));
const idx = v => {
  const m = majorOf(v);
  let i = cycleOrder.indexOf(m);
  if (i >= 0) return i;
  // not a published cycle (a pin below the oldest tracked one) — clamp
  for (let k = 0; k < cycleOrder.length; k++) if (compare(cycleOrder[k], m) >= 0) return k;
  return cycleOrder.length - 1;
};
const ci = idx(curMajor), ti = idx(tgtMajor);
const cyclesCrossed = Math.max(0, ti - ci);
// an EDITION boundary is a port, not an upgrade — these are the real ones
const EDITIONS = { python: [['2', '3']], scala: [['2', '3']], perl: [['5', '6']] };
const editionJump = (EDITIONS[A.id] || []).some(([f, t]) =>
  String(curMajor).startsWith(f) && String(tgtMajor).startsWith(t));

const curEol = typeof cur.eol === 'string' ? cur.eol : (cur.eol === false ? null : '');
const curSup = typeof cur.support === 'string' ? cur.support : (cur.support === false ? null : '');

emit({
  lang: A.id,
  label: A.label,
  today,
  offline: OFFLINE,
  eolSource: `endoflife.date/api/${A.eolProduct}.json`,
  current: {
    declared: current,
    major: curMajor,
    latestInLine: cur.latest || null,
    lts: cur.lts ?? null,
    supportEnds: curSup,
    eol: curEol,
    isEol: !!(curEol && curEol < today),
    securityOnly: !!(curSup && curSup < today && (!curEol || curEol >= today)),
    cve: currentCve,
  },
  target: {
    version: target,
    supportedLongerThanCurrent: !(cur.eol && tgt.eol && typeof cur.eol === 'string'
      && typeof tgt.eol === 'string' && tgt.eol < cur.eol),
    warning: targetDowngradesSupport
      ? `every newer cycle is supported for LESS time than ${curMajor} — staying put may be correct`
      : null,
    major: tgtMajor,
    lts: tgt.lts ?? null,
    supportEnds: typeof tgt.support === 'string' ? tgt.support : null,
    eol: typeof tgt.eol === 'string' ? tgt.eol : null,
    cve: targetCve,
    autoSelected: !targetArg,
  },
  distance: { cyclesCrossed, editionJump,
              from: curMajor, to: tgtMajor,
              publishedCycles: cycleOrder.length,
              note: editionJump
                ? 'this crosses a language EDITION boundary — plan it as a port, not a version bump'
                : cyclesCrossed >= 4 ? 'several release cycles in one jump — move one cycle at a time'
                : null },
  cveDelta: {
    blockingRemoved: (currentCve.blocking || 0) - (targetCve.blocking || 0),
    totalRemoved: (currentCve.total || 0) - (targetCve.total || 0),
    gateMetric,
    gateValueCurrent: gateMetric ? (gateMetric === 'total' ? currentCve.total : currentCve.blocking) : null,
    gateValueTarget: gateMetric ? (gateMetric === 'total' ? targetCve.total : targetCve.blocking) : null,
  },
  runtimeCveSource: A.cveSource.note,
  adapter: A.generic ? null : A.id,
  generic: !!A.generic,
  gateCapable: A.gateCapable,
  gateMetric,
  gateNote: A.gateNote || null,
  warnings: [cveError, eolRes.stale ? 'EOL data served from stale cache' : null].filter(Boolean),
});
