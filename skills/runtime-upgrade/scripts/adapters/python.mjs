import { join, existsSync, readText, readJson, rel } from '../lib/io.mjs';
import { classifyDeclared } from '../lib/semver.mjs';

export const id = 'python';
export const label = 'Python';
export const manifests = ['pyproject.toml', 'setup.cfg', 'Pipfile', 'requirements.txt'];
export const eolProduct = 'python';
export const osvEcosystem = 'PyPI';
/** OSV returns nothing for the CPython interpreter itself — no curated runtime CVE DB. */
export const gateCapable = false;
export const gateNote =
  'No curated, version-ranged CVE database exists for CPython (OSV returns 0 for the ' +
  'interpreter). Gate on EOL/support status and pip-audit/safety findings instead; treat ' +
  'runtime CVEs as advisory and triage against the python.org security notes.';
export const cveSource = { url: null, note: 'none — python.org security notes + distro trackers, manual triage' };
export const ciKey = /\bpython[-_]?version/i;
export const imageRe = /\b(python|pypy)[:@]([^\s"']+)/gi;

export function scan({ dir, root, dockerImages, ciText }) {
  const pyproject = readText(join(dir, 'pyproject.toml')) || '';
  const setupcfg = readText(join(dir, 'setup.cfg')) || '';
  const pipfile = readText(join(dir, 'Pipfile')) || '';
  const toxini = readText(join(dir, 'tox.ini')) || '';
  const declared = {
    requiresPython: (pyproject.match(/^\s*requires-python\s*=\s*["']([^"']+)/m) || [])[1] || '',
    poetryPython:   (pyproject.match(/^\s*python\s*=\s*["']([^"']+)/m) || [])[1] || '',
    pythonRequires: (setupcfg.match(/^\s*python_requires\s*=\s*(.+)$/m) || [])[1]?.trim() || '',
    pipfilePython:  (pipfile.match(/python_version\s*=\s*["']([^"']+)/) || [])[1] || '',
    pythonVersion:  (readText(join(dir, '.python-version')) || '').trim(),
    runtimeTxt:     (readText(join(dir, 'runtime.txt')) || '').trim().replace(/^python-?/i, ''),
    toolVersions:   (readText(join(dir, '.tool-versions')) || '').match(/^python\s+(\S+)/mi)?.[1] || '',
    toxEnvs:        (toxini.match(/^\s*envlist\s*=\s*(.+)$/m) || [])[1]?.trim() || '',
    dockerfile:     dockerImages.filter(s => /^(python|pypy)[:@]/i.test(s)).join(' | '),
    ci:             ciText,
  };
  const considered = Object.fromEntries(Object.entries(declared).filter(([k]) => k !== 'toxEnvs'));
  const { pins, floors } = classifyDeclared(considered);
  const pinMajors = [...new Set(Object.values(pins).map(v => (String(v).match(/(\d+\.\d+)/) || [])[1]).filter(Boolean))];
  const floorMajors = [...new Set(Object.values(floors).map(v => (String(v).match(/(\d+\.\d+)/) || [])[1]).filter(Boolean))];
  const majors = [...new Set([...pinMajors, ...floorMajors])];
  let lockfile = '';
  for (const l of ['poetry.lock', 'Pipfile.lock', 'uv.lock', 'pdm.lock', 'requirements.lock']) {
    if (existsSync(join(dir, l))) { lockfile = l; break; }
  }
  const reqs = readText(join(dir, 'requirements.txt')) || '';
  const name = (pyproject.match(/^\s*name\s*=\s*["']([^"']+)/m) || [])[1] || dir.split('/').pop();
  return {
    lang: id, name, dir: rel(root, dir),
    manifest: rel(root, join(dir, existsSync(join(dir, 'pyproject.toml')) ? 'pyproject.toml' : 'requirements.txt')),
    declared, lockfile,
    declaredMajors: majors.join(','),
    pinnedMajors: pinMajors.join(','), floorMajors: floorMajors.join(','),
    drift: pinMajors.length > 1,
    deps: reqs ? reqs.split('\n').filter(l => l.trim() && !l.trim().startsWith('#')).length
               : (pyproject.match(/^\s*[\w.-]+\s*=\s*["\^~><=]/gm) || []).length,
    devDeps: 0,
    // Binary wheels are tagged cp3XX + a manylinux/musllinux platform; a new
    // minor needs wheels built for that ABI tag or a source build with a toolchain.
    abiNote: 'wheels are tagged cp3XX-<abi>-<platform>; a new MINOR needs matching wheels or a source build',
  };
}
