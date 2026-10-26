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
 * Keep ONLY the text where string interpolation actually happens, blanking
 * everything else space-for-character so line/column numbers survive.
 *
 * A rule like PHP's `${x}` deprecation only has meaning inside a double-quoted
 * string or a heredoc. Running it over the raw file instead matched, and an
 * autofix then rewrote:
 *   - `'${PUSHER_APP_KEY}'`  a single-quoted literal, where ${} is just text
 *   - `"\${$variable}"`      an ESCAPED dollar — the construct is not there
 *   - `` `${totalQueries}` `` a JavaScript template literal inside a .blade.php
 *   - `'${1}'`               a preg_replace backreference
 * All four rewrites produced files that still pass `php -l`, so the corruption
 * was invisible to every lint gate. Hence this narrower view.
 */
export function keepInterpolatable(text, lang) {
  if (lang !== 'php') return stripNonCode(text, lang);   // only PHP needs this today
  const n = text.length;
  const out = new Array(n);
  for (let k = 0; k < n; k++) out[k] = text[k] === '\n' ? '\n' : ' ';
  const keep = (a, b) => { for (let k = a; k < b && k < n; k++) out[k] = text[k]; };

  // A .php file is only PHP INSIDE <?php … ?>. Everything outside is literal
  // output — HTML, and in a .blade.php template, JavaScript. A JS template
  // literal there (`` `${totalQueries}` ``) sits inside a double-quoted HTML
  // attribute and read as a PHP string otherwise.
  const regions = [];
  {
    let k = 0;
    while (k < n) {
      const open = text.indexOf('<?', k);
      if (open === -1) break;
      const after = text.startsWith('<?php', open) ? open + 5
                  : text.startsWith('<?=', open) ? open + 3 : open + 2;
      const close = text.indexOf('?>', after);
      regions.push([after, close === -1 ? n : close]);
      k = close === -1 ? n : close + 2;
    }
    // No opening tag means NO php: a .php or .blade.php file with no `<?`
    // executes nothing — it is literal output end to end. Treating such a file
    // as PHP matched a JS template literal in a Blade component.
  }
  const inPhp = p => regions.some(([a, b]) => p >= a && p < b);

  let i = 0;
  while (i < n) {
    if (!inPhp(i)) { i++; continue; }
    const c = text[i];
    // comments — never interpolated
    if (c === '/' && text[i + 1] === '/') { const e = text.indexOf('\n', i); i = e === -1 ? n : e; continue; }
    if (c === '#' && text[i + 1] !== '[') { const e = text.indexOf('\n', i); i = e === -1 ? n : e; continue; }
    if (c === '/' && text[i + 1] === '*') { const e = text.indexOf('*/', i + 2); i = e === -1 ? n : e + 2; continue; }
    // single-quoted: ${} is literal text there, not interpolation
    if (c === "'") { let j = i + 1; while (j < n && text[j] !== "'") { if (text[j] === '\\') j++; j++; } i = j + 1; continue; }
    // heredoc <<<ID / <<<"ID" interpolates; nowdoc <<<'ID' does not
    if (c === '<' && text.startsWith('<<<', i)) {
      const h = text.slice(i).match(/^<<<[ \t]*(?:(["'])([A-Za-z_]\w*)\1|([A-Za-z_]\w*))\r?\n/);
      if (h) {
        const id = h[2] || h[3];
        const nowdoc = h[1] === "'";
        const bodyStart = i + h[0].length;
        const close = text.slice(bodyStart).search(new RegExp(`^[ \\t]*${id}\\b`, 'm'));
        const bodyEnd = close === -1 ? n : bodyStart + close;
        if (!nowdoc) keep(bodyStart, bodyEnd);
        i = bodyEnd === n ? n : bodyEnd + id.length;
        continue;
      }
    }
    // double-quoted: the one place ${} means what the rule says
    if (c === '"') {
      let j = i + 1;
      while (j < n && text[j] !== '"') { if (text[j] === '\\') j++; j++; }
      keep(i + 1, Math.min(j, n));
      i = j + 1; continue;
    }
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
