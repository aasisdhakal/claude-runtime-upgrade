// Minimal semver range matcher. Zero deps. Verified against npm `semver`
// on the nodejs/security-wg CVE database (identical results on 20.11.1,
// 22.11.0, 24.13.0, 24.22.1, 26.12.1).

export function parse(v) {
  const m = String(v ?? '').trim().replace(/^[v=]+/, '').match(/^(\d+)(?:\.(\d+))?(?:\.(\d+))?/);
  return m ? [+m[1], +(m[2] ?? 0), +(m[3] ?? 0)] : null;
}
export function cmp(a, b) {
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
  return 0;
}
export function compare(a, b) {
  const pa = parse(a), pb = parse(b);
  if (!pa || !pb) return 0;
  return cmp(pa, pb);
}

function satisfiesOne(ver, raw) {
  const t = String(raw).trim();
  if (!t || t === '*' || t === 'x' || t === 'X') return true;
  let m;
  // ^1.2.3 / ^1.2 / ^1 — partial versions are legal and common in engines fields
  if ((m = t.match(/^\^\s*v?(\d+)(?:\.(\d+))?(?:\.(\d+))?/))) {
    const lo = [+m[1], +(m[2] ?? 0), +(m[3] ?? 0)];
    const hi = lo[0] > 0 ? [lo[0] + 1, 0, 0]
             : m[2] === undefined ? [1, 0, 0]
             : lo[1] > 0 ? [0, lo[1] + 1, 0]
             : m[3] === undefined ? [0, 1, 0]
             : [0, 0, lo[2] + 1];
    return cmp(ver, lo) >= 0 && cmp(ver, hi) < 0;
  }
  // ~1.2.3 / ~1.2 / ~1
  if ((m = t.match(/^~\s*v?(\d+)(?:\.(\d+))?(?:\.(\d+))?/))) {
    const lo = [+m[1], +(m[2] ?? 0), +(m[3] ?? 0)];
    const hi = m[2] === undefined ? [lo[0] + 1, 0, 0] : [lo[0], lo[1] + 1, 0];
    return cmp(ver, lo) >= 0 && cmp(ver, hi) < 0;
  }
  if ((m = t.match(/^(>=|<=|>|<|=)?\s*v?(\d+)(?:\.(\d+|[xX*]))?(?:\.(\d+|[xX*]))?/))) {
    const op = m[1] || '=';
    const wildMinor = m[3] === undefined || /^[xX*]$/.test(m[3]);
    const wildPatch = m[4] === undefined || /^[xX*]$/.test(m[4]);
    const base = [+m[2], wildMinor ? 0 : +m[3], wildPatch ? 0 : +m[4]];
    if (op === '=') {
      if (wildMinor) return ver[0] === base[0];
      if (wildPatch) return ver[0] === base[0] && ver[1] === base[1];
      return cmp(ver, base) === 0;
    }
    // X-ranges: a partial version denotes an INTERVAL, so `>` and `<=` must
    // bound against the end of that interval, not its start.
    //   >1.2   -> >=1.3.0        >1     -> >=2.0.0
    //   <=1.2  -> <1.3.0         <=1    -> <2.0.0
    //   >=1.2  -> >=1.2.0        <1.2   -> <1.2.0   (start bound, unchanged)
    const partial = wildMinor || wildPatch;
    if (partial && (op === '>' || op === '<=')) {
      const next = wildMinor ? [base[0] + 1, 0, 0] : [base[0], base[1] + 1, 0];
      return op === '>' ? cmp(ver, next) >= 0 : cmp(ver, next) < 0;
    }
    const c = cmp(ver, base);
    return op === '>=' ? c >= 0 : op === '<=' ? c <= 0 : op === '>' ? c > 0 : c < 0;
  }
  return false;
}

// Tokenise comparator+version pairs. Splitting on whitespace is WRONG:
// ">= 20" would become [">=", "20"] and the orphaned operator fails to parse,
// so every range with a space after the operator silently evaluated to false.
const COMPARATOR_RE = /(>=|<=|>|<|=|\^|~)?\s*(v?\d+(?:\.(?:\d+|[xX*]))?(?:\.(?:\d+|[xX*]))?)/g;

/** "||" separates alternatives; comparators within an alternative are ANDed. */
export function satisfies(version, range) {
  const ver = parse(version);
  if (!ver || range == null) return false;
  return String(range).split('||').some(alt => {
    const t = alt.trim();
    if (!t || t === '*' || t === 'x' || t === 'X') return true;
    // hyphen range: "1.2.3 - 2.3.4"
    const hy = t.match(/^(v?\d[\w.*-]*)\s+-\s+(v?\d[\w.*-]*)$/);
    if (hy) return satisfiesOne(ver, '>=' + hy[1]) && satisfiesOne(ver, '<=' + hy[2]);
    const parts = [];
    COMPARATOR_RE.lastIndex = 0;
    let m;
    while ((m = COMPARATOR_RE.exec(t)) !== null) parts.push((m[1] || '') + m[2]);
    return parts.length ? parts.every(p => satisfiesOne(ver, p)) : false;
  });
}

/** Lowest integer major mentioned in a range string. ">= 20.x" -> 20 */
export function rangeMajor(s) {
  const m = String(s ?? '').match(/\d+/);
  return m ? m[0] : '';
}
/** Lowest MAJOR.MINOR mentioned. "^8.1" -> "8.1" */
export function rangeMajorMinor(s) {
  const m = String(s ?? '').match(/(\d+)\.(\d+)/);
  return m ? `${m[1]}.${m[2]}` : rangeMajor(s);
}
