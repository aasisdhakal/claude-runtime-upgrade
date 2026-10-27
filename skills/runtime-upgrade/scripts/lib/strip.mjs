// Blank out comments and string literals before pattern matching.
//
// Without this, every rule fires inside prose: Scala's symbol-literal rule
// matched the apostrophe in "`Const`'s second parameter", Elixir's charlist
// rule matched `'fetch_'` in a doc string, and Java's sun.misc.Unsafe rule
// matched a Javadoc paragraph. 35 of 35 findings across four real repos were
// comment matches.
//
// Replacement is space-for-character so byte offsets — and therefore the
// reported line numbers — are preserved exactly.

const C_LIKE = { line: ['//'], block: [['/*', '*/']], strings: ['"', "'", '`'], raw: [['"""', '"""']] };

export const SYNTAX = {
  node:   C_LIKE,
  deno:   C_LIKE,
  bun:    C_LIKE,
  php:    { line: ['//', '#'], block: [['/*', '*/']], strings: ['"', "'"] },
  java:   { line: ['//'], block: [['/*', '*/']], strings: ['"'], raw: [['"""', '"""']] },
  kotlin: { line: ['//'], block: [['/*', '*/']], strings: ['"'], raw: [['"""', '"""']] },
  dotnet: { line: ['//'], block: [['/*', '*/']], strings: ['"'], raw: [['"""', '"""']] },
  go:     { line: ['//'], block: [['/*', '*/']], strings: ['"', '`'] },
  rust:   { line: ['//'], block: [['/*', '*/']], strings: ['"'] },
  // Scala doc comments are the main source of apostrophes
  scala:  { line: ['//'], block: [['/*', '*/']], strings: ['"'], raw: [['"""', '"""']] },
  python: { line: ['#'], block: [], strings: ['"', "'"], raw: [['"""', '"""'], ["'''", "'''"]] },
  ruby:   { line: ['#'], block: [['=begin', '=end']], strings: ['"', "'"] },
  // Elixir charlists ARE single-quoted, and detecting them is the point —
  // so blank double-quoted strings and heredocs only.
  elixir: { line: ['#'], block: [], strings: ['"'], raw: [['"""', '"""']] },
  erlang: { line: ['%'], block: [], strings: ['"'] },
  // Perl POD runs from ^=word to ^=cut and is pure prose
  perl:   { line: ['#'], block: [], strings: ['"', "'"], pod: true },
};

/**
 * Blank COMMENTS only, keeping string literals intact.
 *
 * An import specifier IS a string literal — `require('ms')`, `from 'semver'`,
 * `import "golang.org/x/exp/slices"`. Blanking strings turns that into
 * `require(    )` and the package name disappears, so any search for call
 * sites silently finds nothing. Use this whenever the thing being matched
 * legitimately lives inside quotes; use stripNonCode when it must not.
 */
export function stripComments(text, lang) {
  return stripNonCode(text, lang, { strings: false });
}

export function stripNonCode(text, lang, { strings = true } = {}) {
  const cfg = SYNTAX[lang];
  if (!cfg) return text;
  const out = text.split('');
  const n = text.length;
  const blank = (a, b) => { for (let k = a; k < b && k < n; k++) if (out[k] !== '\n') out[k] = ' '; };

  if (cfg.pod) {
    const re = /^=\w+[\s\S]*?^=cut.*$/gm;
    let m; while ((m = re.exec(text)) !== null) blank(m.index, m.index + m[0].length);
  }

  let i = 0;
  while (i < n) {
    const rest = () => text.slice(i, i + 3);
    // raw / triple-quoted first: """ would otherwise be read as an empty "" plus "
    let matched = false;
    for (const [open, close] of (strings ? cfg.raw : []) || []) {
      if (text.startsWith(open, i)) {
        const end = text.indexOf(close, i + open.length);
        const stop = end === -1 ? n : end + close.length;
        blank(i, stop); i = stop; matched = true; break;
      }
    }
    if (matched) continue;
    for (const [open, close] of cfg.block || []) {
      if (text.startsWith(open, i)) {
        const end = text.indexOf(close, i + open.length);
        const stop = end === -1 ? n : end + close.length;
        blank(i, stop); i = stop; matched = true; break;
      }
    }
    if (matched) continue;
    for (const lc of cfg.line || []) {
      if (text.startsWith(lc, i)) {
        const end = text.indexOf('\n', i);
        const stop = end === -1 ? n : end;
        blank(i, stop); i = stop; matched = true; break;
      }
    }
    if (matched) continue;
    for (const q of (strings ? cfg.strings : []) || []) {
      if (text[i] === q) {
        let j = i + 1;
        while (j < n && text[j] !== q) { if (text[j] === '\\') j++; if (text[j] === '\n') break; j++; }
        const stop = Math.min(j + 1, n);
        blank(i, stop); i = stop; matched = true; break;
      }
    }
    if (matched) continue;
    i++;
  }
  return out.join('');
}



/**
 * Does this Go module actually use cgo?
 *
 * cgo is `import "C"` in a .go FILE. Both detectors looked in go.mod instead:
 *   `/\bC\b/.test(gomod)`  matched the comment "the C zlib library" -> cgo: true
 *   `/"C"/.test(gomod)`     never matches anything -> cgo: false for a module
 *                           whose main.go genuinely imports "C"
 * Both directions were wrong, and the answer drives real advice: a cgo binary
 * is bound to its libc and cannot move between a glibc and a musl image.
 *
 * `import "C"` must be the import DIRECTLY above the comment block it consumes,
 * and it is never grouped — `import ( "C" )` is not cgo. Comments are stripped
 * first so prose about C cannot match.
 */
export function usesCgo(dir, { walk, readText, join }) {
  const files = walk(dir, { match: n => n.endsWith('.go'), maxDepth: 8, limit: 4000 });
  for (const f of files) {
    const code = stripComments(readText(f) || '', 'go');
    if (/^\s*import\s+"C"\s*$/m.test(code)) return { cgo: true, evidence: f.slice(dir.length + 1) };
  }
  return { cgo: false, evidence: null, scanned: files.length, truncated: !!files.truncated };
}
