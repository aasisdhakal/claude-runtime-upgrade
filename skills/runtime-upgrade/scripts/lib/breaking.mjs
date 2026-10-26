// Source-level breaking-change rules, keyed by the version that introduces the
// break. A rule fires only when you are crossing that version — scanning for
// Node 24 removals while upgrading 20 -> 22 is noise, not signal.
//
// `severity`: removed  = will throw/fail to build
//             runtime  = deprecated at runtime, still works, warns loudly
//             behaviour= still runs, DIFFERENT RESULT — the dangerous class
import { compare } from './semver.mjs';

const R = (introducedIn, re, severity, what, fix) => ({ introducedIn, re, severity, what, fix });

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
    R('26.0.0', /\.writeHeader\s*\(/,                     'removed',  'http.Server.prototype.writeHeader() was removed', 'use writeHead()'),
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
    R('8.2.0', /\$\{\s*\$?\w+\s*\}/,                      'runtime',  '${} string interpolation is deprecated', 'use {$var}'),
    R('8.3.0', /\bReflectionClass::getStaticProperties\b/, 'runtime', 'nullable return deprecated', 'check the PHP 8.3 UPGRADING notes'),
    R('8.4.0', /\bmysqli_execute\s*\(|\bsession_set_save_handler\s*\(\s*\w+\s*,/, 'runtime',
      'several signatures were deprecated in 8.4', 'see UPGRADING for the exact call'),
  ],
  python: [
    R('3.9.0',  /\bfrom\s+collections\s+import\s+(?:Mapping|Sequence|Iterable|MutableMapping)/, 'removed',
      'collections ABCs moved to collections.abc', 'import from collections.abc'),
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
    R('3.1.0', /\bFile\.exists\?\s*\(/,                   'runtime',  'File.exists? is deprecated', 'use File.exist?'),
    R('3.4.0', /\bObject#=~|\bNilClass#=~/,               'removed',  'Object#=~ was removed', 'use explicit matching'),
  ],
  go: [
    R('1.16.0', /\bio\/ioutil\b/,                         'runtime',  'io/ioutil is deprecated', 'use io and os'),
    R('1.20.0', /\bmath\/rand"\s*\)?[\s\S]{0,40}rand\.Seed\s*\(/, 'runtime', 'rand.Seed is deprecated', 'the global source is auto-seeded; use rand.New for determinism'),
    R('1.21.0', /\bgolang\.org\/x\/exp\/slices\b|\bgolang\.org\/x\/exp\/maps\b/, 'runtime',
      'x/exp/slices and x/exp/maps graduated to the stdlib', 'import "slices" / "maps"'),
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
  rust: [], elixir: [], erlang: [], kotlin: [], scala: [], perl: [], deno: [], bun: [],
};

/** Source file globs worth scanning, per language. */
export const SOURCE_EXT = {
  node: /\.(mjs|cjs|jsx?|tsx?)$/, php: /\.(php|phtml)$/, python: /\.pyi?$/,
  ruby: /\.(rb|rake)$/, go: /\.go$/, java: /\.java$/, dotnet: /\.(cs|fs|vb)$/,
  rust: /\.rs$/, elixir: /\.exs?$/, erlang: /\.(erl|hrl)$/, kotlin: /\.kts?$/,
  scala: /\.scala$/, perl: /\.(pl|pm|t)$/, deno: /\.(ts|js)$/, bun: /\.(ts|js)$/,
};

/** Rules that fire when moving from `from` to `to` — nothing outside the window. */
export function rulesFor(lang, from, to) {
  return (RULES[lang] || []).filter(r =>
    (!from || compare(r.introducedIn, from) > 0) && (!to || compare(r.introducedIn, to) <= 0));
}

/**
 * Rules that already applied BEFORE the current version. These are not caused
 * by this upgrade — the code has been living with them — but a plan that claims
 * to cover every aspect should say they exist, because they are what the NEXT
 * upgrade will turn into failures.
 */
export function preExistingRules(lang, from) {
  if (!from) return [];
  return (RULES[lang] || []).filter(r => compare(r.introducedIn, from) <= 0);
}
