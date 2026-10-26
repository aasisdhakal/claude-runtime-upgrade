// Adapter factory for runtimes whose discovery is "read a few files with a few
// regexes". Node, PHP, Go, Python, Ruby, Rust, Java and .NET each have enough
// quirks to justify a hand-written module; these do not.
//
// A spec declares WHERE the version lives and WHAT the ABI story is. Everything
// else — EOL lookup, OSV dependency advisories, drift, image parsing — is shared.
import { join, existsSync, readText, readdirSync, rel } from '../lib/io.mjs';
import { classifyDeclared } from '../lib/semver.mjs';

export function makeAdapter(spec) {
  const {
    id, label, manifests, eolProduct, osvEcosystem, imageNames,
    ciKeyWords, sources, lockfiles = [], abiNote = null,
    versionShape = 'major.minor', gateNote, countDeps,
    driftExclude = [],
    postProcess = null,
  } = spec;

  const imageRe = new RegExp(`\\b(${imageNames.join('|')})[:@]([^\\s"']+)`, 'gi');
  const ciKey = new RegExp(`\\b(?:${ciKeyWords.join('|')})[-_]?version`, 'i');
  // Perl writes 5.030 for 5.30 and 5.008 for 5.8 — strip the zero-padding so
  // the cycle matches what endoflife.date publishes.
  const unpad = s => s.replace(/^(\d+)\.0*(\d+)$/, (_, a, b) => `${a}.${Number(b)}`);
  const extract = versionShape === 'major'
    ? v => (String(v).match(/(\d+)/) || [])[1] || ''
    : v => { const m = String(v).match(/(\d+\.\d+)/); return m ? unpad(m[1]) : ((String(v).match(/(\d+)/) || [])[1] || ''); };

  function scan({ dir, root, dockerImages, ciText }) {
    const declared = {};
    for (const [key, src] of Object.entries(sources)) {
      let text = '';
      if (src.file) text = readText(join(dir, src.file)) || '';
      else if (src.glob) {
        try { for (const f of readdirSync(dir)) if (src.glob.test(f)) { text = readText(join(dir, f)) || ''; break; } } catch {}
      }
      if (!text) { declared[key] = ''; continue; }
      declared[key] = src.re ? ((text.match(src.re) || [])[1] || '').trim() : text.trim().split('\n')[0];
    }
    // sbt writes `scalaVersion := Scala213` — an identifier, not a literal.
    // postProcess resolves those against the manifest text before classification.
    if (postProcess) postProcess(declared, f => readText(join(dir, f)) || '');
    declared.toolVersions = (readText(join(dir, '.tool-versions')) || '')
      .match(new RegExp(`^(?:${ciKeyWords.join('|')})\\s+(\\S+)`, 'mi'))?.[1] || '';
    declared.dockerfile = dockerImages.filter(s => new RegExp(`^(${imageNames.join('|')})[:@]`, 'i').test(s)).join(' | ');
    declared.ci = ciText;

    // Keys listed in driftExclude describe a DIFFERENT axis (Kotlin's JVM
    // toolchain, Scala's cross-build matrix). Counting them as disagreement
    // reports drift where none exists.
    const considered = Object.fromEntries(Object.entries(declared).filter(([k]) => !driftExclude.includes(k)));
    const { pins, floors } = classifyDeclared(considered);
    const pinMajors = [...new Set(Object.values(pins).map(extract).filter(Boolean))];
    const floorMajors = [...new Set(Object.values(floors).map(extract).filter(Boolean))];
    const majors = [...new Set([...pinMajors, ...floorMajors])];
    const otherAxis = Object.fromEntries(driftExclude
      .filter(k => declared[k]).map(k => [k, declared[k]]));
    let lockfile = '';
    for (const l of lockfiles) if (existsSync(join(dir, l))) { lockfile = l; break; }
    const primary = manifests.find(m => existsSync(join(dir, m))) || manifests[0];
    const manifestText = readText(join(dir, primary)) || '';
    return {
      lang: id, name: dir.split('/').pop(), dir: rel(root, dir), manifest: rel(root, join(dir, primary)),
      declared, lockfile,
      declaredMajors: majors.join(','),
      pinnedMajors: pinMajors.join(','), floorMajors: floorMajors.join(','),
      drift: pinMajors.length > 1,
      ...(Object.keys(otherAxis).length ? { otherAxis } : {}),
      deps: countDeps ? countDeps(manifestText) : 0, devDeps: 0,
      abiNote,
    };
  }

  return {
    id, label, manifests, eolProduct, osvEcosystem,
    gateCapable: false, gateNote, imageRe, ciKey, scan,
    cveSource: { url: null, note: `none curated for ${label} — gate on EOL/support plus the ecosystem auditor` },
  };
}
