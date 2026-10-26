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

export function stripNonCode(text, lang) {
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
    for (const [open, close] of cfg.raw || []) {
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
    for (const q of cfg.strings || []) {
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
