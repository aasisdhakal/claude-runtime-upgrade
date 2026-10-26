// Can a type checker catch a change in this dependency — or not?
//
// This is the question that decides whether an upgrade needs a RUNTIME probe.
// A type checker only ever catches SHAPE changes: a renamed export, a changed
// arity, a different return type. It cannot catch a function that still takes
// the same arguments and returns the same type while returning a DIFFERENT
// ANSWER — an unstable sort, a timezone rule, a rounding change, a hash.
//
// And in Python, Ruby, PHP or untyped JS there is often no checker at all, so
// even shape changes reach production untouched.
import { join, existsSync, readJson, readText, readdirSync } from './io.mjs';

/** Is a type checker wired into this project at all? */
export function projectTypeChecking(lang, dir) {
  const has = f => existsSync(join(dir, f));
  switch (lang) {
    case 'node': case 'deno': case 'bun': {
      const ts = has('tsconfig.json');
      const cfg = ts ? readJson(join(dir, 'tsconfig.json')) : null;
      const strict = !!(cfg?.compilerOptions?.strict);
      return { checker: ts ? 'typescript' : null, enabled: ts, strict,
               note: ts ? (strict ? 'TypeScript, strict' : 'TypeScript, non-strict — many shape changes pass')
                        : 'no TypeScript: NOTHING catches a shape change at build time' };
    }
    case 'python': {
      const t = readText(join(dir, 'pyproject.toml')) || '';
      const mypy = has('mypy.ini') || /\[tool\.mypy\]/.test(t);
      const pyright = has('pyrightconfig.json') || /\[tool\.pyright\]/.test(t);
      const ty = mypy || pyright;
      return { checker: mypy ? 'mypy' : pyright ? 'pyright' : null, enabled: ty, strict: /strict/.test(t),
               note: ty ? 'a type checker is configured' : 'no mypy/pyright: shape changes surface only at runtime' };
    }
    case 'php': {
      const ps = has('phpstan.neon') || has('phpstan.neon.dist') || has('psalm.xml');
      return { checker: ps ? 'phpstan/psalm' : null, enabled: ps, strict: false,
               note: ps ? 'static analysis is configured' : 'no PHPStan/Psalm: shape changes surface only at runtime' };
    }
    case 'ruby': {
      const s = has('sorbet') || has('.rubocop.yml');
      return { checker: has('sorbet') ? 'sorbet' : null, enabled: has('sorbet'), strict: false,
               note: has('sorbet') ? 'Sorbet is configured' : 'Ruby is dynamically typed here: runtime is the only check' };
    }
    // compiled languages: the compiler IS the checker, and it is not optional
    case 'go': case 'rust': case 'java': case 'kotlin': case 'scala': case 'dotnet':
      return { checker: 'compiler', enabled: true, strict: true,
               note: 'the compiler rejects shape changes — but NOT behaviour changes' };
    default:
      return { checker: null, enabled: false, strict: false, note: 'unknown type-checking story' };
  }
}

/** Does THIS package ship type information the checker can use? */
export function packageTypes(lang, dir, name) {
  if (['go', 'rust', 'java', 'kotlin', 'scala', 'dotnet'].includes(lang))
    return { typed: true, how: 'compiled language — types travel with the package' };
  if (['node', 'deno', 'bun'].includes(lang)) {
    const pkg = readJson(join(dir, 'node_modules', name, 'package.json'));
    if (pkg?.types || pkg?.typings) return { typed: true, how: 'ships its own .d.ts' };
    const at = name.startsWith('@') ? '@types/' + name.slice(1).replace('/', '__') : '@types/' + name;
    if (existsSync(join(dir, 'node_modules', at))) return { typed: true, how: `types from ${at}` };
    if (pkg) return { typed: false, how: 'no .d.ts and no @types package' };
    return { typed: null, how: 'not installed — cannot tell' };
  }
  if (lang === 'python') {
    const base = join(dir, '.venv', 'lib');
    let found = null;
    try {
      for (const v of readdirSync(base)) {
        const p = join(base, v, 'site-packages', name.replace(/-/g, '_'), 'py.typed');
        if (existsSync(p)) { found = true; break; }
      }
    } catch { return { typed: null, how: 'no local venv — cannot tell' }; }
    return { typed: !!found, how: found ? 'ships py.typed (PEP 561)' : 'no py.typed marker' };
  }
  return { typed: null, how: 'unknown' };
}

/**
 * The verdict that matters: what could POSSIBLY have caught a regression here?
 *
 *   shape-checked   a checker will catch a renamed/retyped API
 *   unchecked       nothing catches even a shape change until runtime
 *   behaviour       NOTHING static can catch this, ever — only a probe can
 */
export function catchability(lang, dir, name) {
  const proj = projectTypeChecking(lang, dir);
  const pkg = packageTypes(lang, dir, name);
  // `pkg.typed !== false` counted UNKNOWN as checked. With node_modules absent
  // — the normal state of a freshly cloned repo — every package then reported
  // shapeChecked: true and majorsWithNoStaticCheck: 0, which is a claim of
  // safety derived from not having looked. In a tool whose entire premise is
  // "say what is actually checked", an unverified claim is the one thing it
  // must not make. Unknown is its own answer.
  const known = pkg.typed === true || pkg.typed === false;
  const shapeChecked = !!(proj.enabled && pkg.typed === true);
  const verdict = !proj.enabled ? 'unchecked'
                : !known ? 'unknown'
                : shapeChecked ? 'shape-checked' : 'unchecked';
  return {
    project: proj, package: pkg,
    shapeChecked,
    shapeCheckKnown: known || !proj.enabled,
    behaviourChecked: false,              // never, by construction — this is the point
    verdict,
    why: verdict === 'shape-checked'
      ? `${proj.checker} will catch a renamed or retyped API here. It will NOT catch the same `
      + 'call returning a different answer — only running the code can.'
      : verdict === 'unknown'
      ? `${proj.checker} is configured, but ${pkg.how} — so whether a SHAPE change would be caught `
      + 'is unknown, not confirmed. Install dependencies to find out. Behaviour is unchecked either way.'
      : `${proj.note}; ${pkg.how}. A shape change AND a behaviour change both reach runtime unseen.`,
    needsRuntimeProbe: true,              // always: behaviour is never statically checked
  };
}
