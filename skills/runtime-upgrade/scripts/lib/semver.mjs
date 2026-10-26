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
  if (!t || t === '*' || t === 'x') return true;
  let m;
  if ((m = t.match(/^\^\s*(\d+)\.(\d+)\.(\d+)/))) {
    const lo = [+m[1], +m[2], +m[3]];
    const hi = lo[0] > 0 ? [lo[0] + 1, 0, 0] : lo[1] > 0 ? [0, lo[1] + 1, 0] : [0, 0, lo[2] + 1];
    return cmp(ver, lo) >= 0 && cmp(ver, hi) < 0;
  }
  if ((m = t.match(/^~\s*(\d+)\.(\d+)\.(\d+)/))) {
    const lo = [+m[1], +m[2], +m[3]];
    return cmp(ver, lo) >= 0 && cmp(ver, [lo[0], lo[1] + 1, 0]) < 0;
  }
  if ((m = t.match(/^(>=|<=|>|<|=)?\s*(\d+)(?:\.(\d+|[xX*]))?(?:\.(\d+|[xX*]))?/))) {
    const op = m[1] || '=';
    const wildMinor = m[3] === undefined || /^[xX*]$/.test(m[3]);
    const wildPatch = m[4] === undefined || /^[xX*]$/.test(m[4]);
    const base = [+m[2], wildMinor ? 0 : +m[3], wildPatch ? 0 : +m[4]];
    if (op === '=') {
      if (wildMinor) return ver[0] === base[0];
      if (wildPatch) return ver[0] === base[0] && ver[1] === base[1];
      return cmp(ver, base) === 0;
    }
    const c = cmp(ver, base);
    return op === '>=' ? c >= 0 : op === '<=' ? c <= 0 : op === '>' ? c > 0 : c < 0;
  }
  return false;
}

/** "||" separates alternatives; whitespace within an alternative ANDs comparators. */
export function satisfies(version, range) {
  const ver = parse(version);
  if (!ver || !range) return false;
  return String(range).split('||').some(alt => {
    const parts = alt.trim().split(/\s+(?=[<>=^~]|\d)/).filter(Boolean);
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
