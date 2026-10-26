// Source-level breaking-change rules, keyed by the version that introduces the
// break. A rule fires only when you are crossing that version — scanning for
// Node 24 removals while upgrading 20 -> 22 is noise, not signal.
//
// `severity`: removed  = will throw/fail to build
//             runtime  = deprecated at runtime, still works, warns loudly
//             behaviour= still runs, DIFFERENT RESULT — the dangerous class
import { compare } from './semver.mjs';

const R = (introducedIn, re, severity, what, fix, autofix = null, scope = 'code') =>
  ({ introducedIn, re, severity, what, fix, autofix, scope });

/**
 * `scope` says WHERE a rule is allowed to match.
 *   'code'    default — comments and string literals are blanked first
 *   'strings' the construct only exists INSIDE a string (PHP "${x}" interpolation)
 *   'any'     the construct is a string by nature (a Go import path), so
 *             blanking strings would delete the very thing being matched
 * Without this, Go's x/exp rule and PHP's interpolation rule silently never
 * fired: both live inside quotes.
 */

/**
 * `autofix` is a per-rule, hand-written rewrite. It is NOT derived from the
 * `fix` text, because detecting with a regex does not imply being able to
 * rewrite with one:
 *
 *   new Buffer(x)            -> Buffer.from(x) OR Buffer.alloc(x) depending on
 *                               the argument's TYPE — not decidable statically
 *   crypto.createCipher(a,b) -> createCipheriv(a,b,iv) — needs an IV that does
 *                               not exist in the source
 *   Deno.run({cmd:[a,b]})    -> new Deno.Command(a,{args:[b]}) — reshapes the
 *                               argument object
 *   enumValues<T>()          -> enumEntries<T>() — returns List, not Array
 *
 * Only a rewrite that is correct for EVERY match gets an autofix. A
 * behaviour-class rule never gets one: it needs a test, not an edit.
 */

export const RULES = {
  node: [
    R('12.0.0', /\bnew Buffer\s*\(/,                      'removed',  'new Buffer() was removed', 'use Buffer.from() / Buffer.alloc()'),
    R('16.0.0', /\brequire\(['"]url['"]\)\.parse|\burl\.parse\s*\(/, 'runtime', 'url.parse() is runtime-deprecated (DEP0169)', 'use new URL()'),
    R('22.0.0', /\bprocess\.binding\s*\(/,                'removed',  'process.binding() was removed', 'use the public API or a native addon'),
    R('23.0.0', /\brequire\(['"]punycode['"]\)/,          'runtime',  'the bundled punycode module is deprecated', 'use the punycode npm package or the WHATWG URL parser'),
    R('24.0.0', /\bnew AsyncLocalStorage\b|\brequire\(['"]async_hooks['"]\)|from ['"]async_hooks['"]/, 'behaviour',
      'AsyncLocalStorage now uses AsyncContextFrame by default — context can go MISSING rather than throwing',
      'assert context identity across an await boundary and across any message/command bus; confirm a regression with --no-async-context-frame'),
    R('24.0.0', /\bcrypto\.createCipher\s*\(|\bcrypto\.createDecipher\s*\(/, 'removed',
      'createCipher/createDecipher were removed', 'use createCipheriv/createDecipheriv'),
    R('26.0.0', /\brequire\(['"]_stream_(wrap|readable|writable|duplex|transform|passthrough)['"]\)/, 'removed',
      'the legacy _stream_* internals were removed in Node 26', "import from 'stream' instead"),
    R('26.0.0', /\.writeHeader\s*\(/,                     'removed',  'http.Server.prototype.writeHeader() was removed', 'use writeHead()',
      m => m.replace('.writeHeader', '.writeHead')),
    R('26.0.0', /--experimental-transform-types/,         'removed',  '--experimental-transform-types was removed', 'use --experimental-strip-types or precompile'),
  ],
  php: [
    R('8.0.0', /\bcreate_function\s*\(/,                  'removed',  'create_function() was removed', 'use a closure'),
    R('8.0.0', /\beach\s*\(/,                             'removed',  'each() was removed', 'use foreach'),
    R('8.0.0', /\{\s*\$[A-Za-z_]\w*\s*\}/,                'removed',  'curly-brace string offset access was removed', 'use square brackets'),
    R('8.1.0', /\$\w+\s*=\s*null\s*;[\s\S]{0,80}?function\s+\w+\s*\([^)]*\?\s*\w+\s+\$\w+\s*=\s*null/, 'runtime',
      'implicitly nullable parameter types are deprecated', 'declare ?Type explicitly'),
    R('8.1.0', /\bstrftime\s*\(|\bgmstrftime\s*\(/,       'runtime',  'strftime()/gmstrftime() are deprecated', 'use IntlDateFormatter or date()'),
    R('8.1.0', /\bFILTER_SANITIZE_STRING\b/,              'runtime',  'FILTER_SANITIZE_STRING is deprecated', 'use htmlspecialchars()'),
    R('8.2.0', /\butf8_encode\s*\(|\butf8_decode\s*\(/,   'runtime',  'utf8_encode()/utf8_decode() are deprecated', 'use mb_convert_encoding()'),
    // interpolation only exists inside a double-quoted string
    R('8.2.0', /\$\{\s*(\$?\w+)\s*\}/,                     'runtime',  '${} string interpolation is deprecated', 'use {$var}',
      m => { const n = m.match(/\$\{\s*\$?(\w+)\s*\}/)[1]; return '{$' + n + '}'; }, 'strings'),
    R('8.3.0', /\bReflectionClass::getStaticProperties\b/, 'runtime', 'nullable return deprecated', 'check the PHP 8.3 UPGRADING notes'),
    R('8.4.0', /\bmysqli_execute\s*\(|\bsession_set_save_handler\s*\(\s*\w+\s*,/, 'runtime',
      'several signatures were deprecated in 8.4', 'see UPGRADING for the exact call'),
  ],
  python: [
    R('3.9.0',  /\bfrom\s+collections\s+import\s+(?:Mapping|Sequence|Iterable|MutableMapping)/, 'removed',
      'collections ABCs moved to collections.abc', 'import from collections.abc',
      m => m.replace('from collections import', 'from collections.abc import')),
    R('3.10.0', /\basyncio\.get_event_loop\s*\(\s*\)/,    'runtime',  'get_event_loop() outside a running loop is deprecated', 'use asyncio.run() or get_running_loop()'),
    R('3.12.0', /\bimp\.|\bimport\s+imp\b/,               'removed',  'the imp module was removed', 'use importlib'),
    R('3.12.0', /\bdistutils\b/,                          'removed',  'distutils was removed', 'use setuptools or packaging'),
    R('3.12.0', /\bdatetime\.utcnow\s*\(|\bdatetime\.utcfromtimestamp\s*\(/, 'runtime',
      'utcnow()/utcfromtimestamp() are deprecated', 'use datetime.now(timezone.utc)'),
    R('3.13.0', /\bimport\s+(?:cgi|cgitb|telnetlib|nntplib|aifc|audioop|crypt|pipes|sunau|uu|xdrlib|chunk|msilib|spwd|sndhdr|ossaudiodev|nis)\b/,
      'removed', 'a PEP 594 "dead battery" module was removed in 3.13', 'use the PyPI replacement named in PEP 594'),
    R('3.14.0', /\bast\.(Num|Str|Bytes|NameConstant|Ellipsis)\b/, 'removed', 'legacy ast node aliases were removed', 'use ast.Constant'),
  ],
  ruby: [
    R('3.0.0', /\bTaint\b|\.taint\b|\.untaint\b/,         'removed',  'the taint mechanism was removed', 'delete the calls'),
    R('3.1.0', /\bFile\.exists\?\s*\(/,                   'runtime',  'File.exists? is deprecated', 'use File.exist?',
      m => m.replace('File.exists?', 'File.exist?')),
    R('3.4.0', /\bObject#=~|\bNilClass#=~/,               'removed',  'Object#=~ was removed', 'use explicit matching'),
  ],
  go: [
    R('1.16.0', /\bio\/ioutil\b/,                         'runtime',  'io/ioutil is deprecated', 'use io and os'),
    R('1.20.0', /\bmath\/rand"\s*\)?[\s\S]{0,40}rand\.Seed\s*\(/, 'runtime', 'rand.Seed is deprecated', 'the global source is auto-seeded; use rand.New for determinism'),
    // a Go import path IS a string literal, so this rule must see strings
    R('1.21.0', /\bgolang\.org\/x\/exp\/(slices|maps)\b/, 'runtime',
      'x/exp/slices and x/exp/maps graduated to the stdlib', 'import "slices" / "maps"',
      m => m.replace(/golang\.org\/x\/exp\//, ''), 'any'),
  ],
  java: [
    R('17', /\bsun\.misc\.Unsafe\b/,                      'runtime',  'sun.misc.Unsafe is being removed incrementally', 'use VarHandle / MemorySegment'),
    R('17', /\bSecurityManager\b/,                        'runtime',  'SecurityManager is deprecated for removal', 'remove the dependency on it'),
    R('21', /\bThread\.stop\s*\(|\bThread\.suspend\s*\(|\bThread\.resume\s*\(/, 'removed',
      'Thread.stop/suspend/resume now throw', 'use interruption'),
    R('24', /\bfinalize\s*\(\s*\)/,                       'removed',  'finalization is disabled by default', 'use Cleaner or try-with-resources'),
  ],
  dotnet: [
    R('8.0', /\bBinaryFormatter\b/,                       'removed',  'BinaryFormatter is removed in .NET 9', 'use System.Text.Json or MessagePack'),
    R('8.0', /\bWebRequest\.Create\s*\(/,                 'runtime',  'WebRequest is obsolete', 'use HttpClient'),
  ],
  rust: [
    R('1.39.0', /\bstd::mem::uninitialized\s*(::<|\()/,   'runtime',  'mem::uninitialized is deprecated and is UB for most types', 'use MaybeUninit'),
    R('1.39.0', /\bstd::mem::zeroed\s*(::<|\()/,          'runtime',  'mem::zeroed is unsound for types without a valid zero', 'use MaybeUninit'),
    R('1.39.0', /\btry!\s*\(/,                            'removed',  'the try! macro was removed in the 2018 edition', 'use the ? operator'),
    R('1.52.0', /#\[derive\([^)]*\bPartialEq\b[^)]*\)\][\s\S]{0,80}?impl\s+Eq\b/, 'runtime',
      'deriving PartialEq alongside a manual Eq is now linted', 'derive both or implement both'),
    R('1.82.0', /\bextern\s+crate\s+/,                    'runtime',  'extern crate is unnecessary since the 2018 edition', 'delete it; use path-based imports'),
  ],
  elixir: [
    R('1.13.0', /\bMix\.Config\b/,                        'removed',  'Mix.Config was replaced by Config', 'use Config (available since 1.9)',
      () => 'Config'),
    R('1.14.0', /\buse\s+Bitwise\b/,                      'runtime',  'use Bitwise is deprecated', 'import Bitwise',
      () => 'import Bitwise'),
    R('1.15.0', /\bLogger\.warn\s*\(/,                    'runtime',  'Logger.warn/2 is deprecated — Erlang :logger uses "warning"', 'use Logger.warning/2',
      m => m.replace('Logger.warn', 'Logger.warning')),
    R('1.17.0', /(?<![\w?!])'[^'\n]{1,80}'(?![\w])/,      'runtime',  "single-quoted charlists are deprecated", 'use ~c"..."'),
  ],
  erlang: [
    R('18', /\berlang:now\s*\(\s*\)|(?<!\w)now\s*\(\s*\)/, 'runtime', 'erlang:now/0 is deprecated', 'use erlang:system_time/1 or erlang:monotonic_time/0'),
    R('20', /\brandom:uniform\s*\(/,                      'removed',  'the random module was removed in OTP 20', 'use rand:uniform/0,1',
      m => m.replace('random:uniform', 'rand:uniform')),
    R('20', /\brandom:seed\s*\(/,                         'removed',  'random:seed was removed in OTP 20',
      'use rand:seed/1,2 — the argument shape differs, so this is not a rename'),
    R('23', /\bhttp_uri:(?:parse|encode|decode)\s*\(/,    'runtime',  'http_uri is deprecated', 'use uri_string'),
    R('24', /\bcrypto:(?:block_encrypt|block_decrypt|stream_init|next_iv)\s*\(/, 'removed',
      'the old crypto block/stream API was removed in OTP 24', 'use crypto:crypto_one_time/4,5 or crypto_init/4'),
  ],
  kotlin: [
    R('1.4.0', /\b@?kotlin\.Experimental\b|@Experimental\b/, 'removed', 'kotlin.Experimental was replaced by RequiresOptIn', 'use @RequiresOptIn / @OptIn'),
    R('1.6.0', /@JvmDefault\b/,                           'removed',  '@JvmDefault was removed', 'use -Xjvm-default=all'),
    R('1.9.0', /\benumValues\s*<|\benumValues\s*\(/,      'runtime',  'enumValues is deprecated', 'use enumEntries (Kotlin 1.9+)'),
    R('2.0.0', /\bkotlin\.jvm\.JvmDefaultWithoutCompatibility\b/, 'runtime', 'JVM default handling changed under K2', 'review -Xjvm-default settings'),
  ],
  scala: [
    // Scala 3 is an EDITION boundary; these are the dropped constructs
    R('3.0.0', /(?<![\w"'])'[A-Za-z_]\w*(?![\w'"])/,      'removed',  "symbol literals ('foo) were dropped in Scala 3", 'use Symbol("foo")',
      m => 'Symbol("' + m.slice(1) + '")'),
    R('3.0.0', /\bdef\s+\w+\s*\([^)]*\)\s*\{/,            'removed',  'procedure syntax (def f() { }) was dropped in Scala 3', 'write def f(): Unit = { }'),
    R('3.0.0', /\bdo\s*\{[\s\S]{0,400}?\}\s*while\s*\(/,  'removed',  'do...while was dropped in Scala 3', 'use while ({ ...; cond }) ()'),
    R('3.0.0', /<\/?[a-zA-Z][^>]*>\s*(?:\{|$)/m,          'runtime',  'XML literals are being dropped', 'use XML string interpolation'),
  ],
  perl: [
    R('5.30', /\$\[/,                                     'removed',  '$[ (array base) was removed in 5.30', 'arrays always start at 0'),
    R('5.42', /(?<![=!~])~~(?!~)/,                        'behaviour','smartmatch (~~) is disabled in the 5.42 feature bundle onward',
      "enable it with `use feature 'smartmatch'` or rewrite the comparison explicitly"),
    R('5.42', /(?<!\w)(?:given|when)\s*\(/,               'behaviour','given/when are disabled in the 5.42 feature bundle onward',
      'rewrite as if/elsif, or opt in explicitly'),
  ],
  deno: [
    R('2.0', /\bDeno\.run\s*\(/,                          'removed',  'Deno.run was removed in Deno 2', 'use new Deno.Command()'),
    R('2.0', /(?<![\w.])window\./,                        'removed',  'the window global was removed in Deno 2', 'use globalThis',
      () => 'globalThis.'),
    R('2.0', /\bDeno\.(?:readAll|writeAll|iter|copy)\s*\(/, 'removed','these Deno I/O helpers moved to the Standard Library in Deno 2', 'import them from jsr:@std/io'),
    R('2.0', /\bDeno\.(?:Buffer|Reader|Writer|Seeker)\b/, 'removed',  'the Deno.Buffer/Reader/Writer/Seeker interfaces were removed in Deno 2', 'use Web Streams or @std/io'),
    R('2.0', /\bDeno\.(?:resources|metrics|close)\s*\(/,  'removed',  'resource-id APIs were removed in Deno 2', 'use the resource\'s own .close(); metrics has no replacement'),
    R('2.0', /\bDeno\.customInspect\b/,                   'removed',  'Deno.customInspect was removed in Deno 2', 'use Symbol.for("Deno.customInspect")'),
  ],
  // Bun implements the Node API surface, so Node's removals apply to Bun code
  // too. There is no separate catalogue of Bun-specific removals worth
  // asserting yet — saying so beats inventing rules.
  bun: [],
};

/** Source file globs worth scanning, per language. */
export const SOURCE_EXT = {
  node: /\.(mjs|cjs|jsx?|tsx?)$/, php: /\.(php|phtml)$/, python: /\.pyi?$/,
  ruby: /\.(rb|rake)$/, go: /\.go$/, java: /\.java$/, dotnet: /\.(cs|fs|vb)$/,
  rust: /\.rs$/, elixir: /\.exs?$/, erlang: /\.(erl|hrl)$/, kotlin: /\.kts?$/,
  scala: /\.scala$/, perl: /\.(pl|pm|t)$/, deno: /\.(ts|js)$/, bun: /\.(ts|js)$/,
};

/** Rules that fire when moving from `from` to `to` — nothing outside the window. */
/** Languages whose code is also subject to another catalogue. */
const INHERITS = { bun: 'node', deno: 'node' };

export function rulesFor(lang, from, to) {
  // Bun and Deno run Node APIs, so Node's removals apply to their code too.
  // Those are reported against the Node version they target, not the runtime's
  // own version, so they are surfaced separately by scan.mjs.
  return (RULES[lang] || []).filter(r =>
    (!from || compare(r.introducedIn, from) > 0) && (!to || compare(r.introducedIn, to) <= 0));
}

/**
 * Rules that already applied BEFORE the current version. These are not caused
 * by this upgrade — the code has been living with them — but a plan that claims
 * to cover every aspect should say they exist, because they are what the NEXT
 * upgrade will turn into failures.
 */
export function inheritedCatalogue(lang) { return INHERITS[lang] || null; }

export function preExistingRules(lang, from) {
  if (!from) return [];
  return (RULES[lang] || []).filter(r => compare(r.introducedIn, from) <= 0);
}
