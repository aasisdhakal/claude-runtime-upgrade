// OSV.dev client. One endpoint serves npm, Packagist, PyPI, RubyGems, Go,
// Maven, NuGet, crates.io, Pub and Hex — which is why adding a language is cheap.
//
// Note it does NOT carry most runtimes: querying the Node/Python/Ruby/.NET/Rust
// interpreter returns nothing. Go is the exception — `stdlib` in the `Go`
// ecosystem is a real, version-ranged package, so Go can be gated like Node.
import { OFFLINE } from './io.mjs';
import { compare } from './semver.mjs';

const ENDPOINT = 'https://api.osv.dev/v1/query';

export async function osvQuery(name, ecosystem, version, { timeout = 25000 } = {}) {
  if (OFFLINE) return { vulns: [], error: 'offline' };
  const body = JSON.stringify({ package: { name, ecosystem }, version });
  try {
    if (typeof fetch !== 'function') return { vulns: [], error: 'fetch unavailable (Node 18+ required for OSV)' };
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), timeout);
    try {
      const r = await fetch(ENDPOINT, {
        method: 'POST', body, signal: ctl.signal,
        headers: { 'content-type': 'application/json', 'user-agent': 'runtime-upgrade-skill' },
      });
      if (!r.ok) return { vulns: [], error: 'HTTP ' + r.status };
      const j = await r.json();
      return { vulns: j.vulns || [] };
    } finally { clearTimeout(t); }
  } catch (e) {
    return { vulns: [], error: String(e.message || e) };
  }
}

/** Highest severity OSV records for an advisory, normalised to our vocabulary. */
export function osvSeverity(v) {
  const db = v.database_specific || {};
  const raw = String(db.severity || v.severity?.[0]?.score || '').toUpperCase();
  if (raw.includes('CRITICAL')) return 'critical';
  if (raw.includes('HIGH')) return 'high';
  if (raw.includes('MODERATE') || raw.includes('MEDIUM')) return 'medium';
  if (raw.includes('LOW')) return 'low';
  // CVSS vector/score fallback
  const s = v.severity?.find(x => x.type?.startsWith('CVSS'));
  if (s) {
    const n = Number(String(s.score).match(/\d+(\.\d+)?/)?.[0]);
    if (!Number.isNaN(n)) return n >= 9 ? 'critical' : n >= 7 ? 'high' : n >= 4 ? 'medium' : 'low';
  }
  return 'unknown';
}

/** Is `version` inside any affected SEMVER range of this advisory? */
export function osvAffects(v, version) {
  for (const a of v.affected || []) {
    for (const r of a.ranges || []) {
      if (r.type !== 'SEMVER' && r.type !== 'ECOSYSTEM') continue;
      let inside = false;
      for (const ev of r.events || []) {
        if (ev.introduced !== undefined) {
          const i = ev.introduced === '0' ? '0.0.0' : ev.introduced;
          if (compare(version, i.replace(/-0$/, '')) >= 0) inside = true;
        } else if (ev.fixed !== undefined) {
          if (compare(version, ev.fixed) >= 0) inside = false;
        } else if (ev.last_affected !== undefined) {
          if (compare(version, ev.last_affected) > 0) inside = false;
        }
      }
      if (inside) return true;
    }
    if ((a.versions || []).includes(version)) return true;
  }
  return false;
}

/** Normalised advisory list for a package@version. */
export async function osvAdvisories(name, ecosystem, version) {
  const { vulns, error } = await osvQuery(name, ecosystem, version);
  const hits = vulns.filter(v => osvAffects(v, version)).map(v => ({
    id: (v.aliases || []).find(a => a.startsWith('CVE-')) || v.id,
    severity: osvSeverity(v),
    overview: String(v.summary || v.details || '').replace(/\s+/g, ' ').slice(0, 180),
    fixed: (v.affected || []).flatMap(a => (a.ranges || []).flatMap(r => (r.events || [])
      .filter(e => e.fixed).map(e => e.fixed)))[0] || null,
  }));
  return { hits, error };
}
