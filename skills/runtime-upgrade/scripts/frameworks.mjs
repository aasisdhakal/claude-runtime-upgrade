#!/usr/bin/env node
// Framework EOL for a directory. The runtime is often not the real blocker.
// usage: node frameworks.mjs <dir>
import { resolve, existsSync, emit, die } from './lib/io.mjs';
import { runJson } from './lib/sh.mjs';
import { frameworkEol } from './lib/frameworks.mjs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const DIR = resolve(process.argv[2] || '.');
if (!existsSync(DIR)) die(`no such directory: ${DIR}`);

const det = runJson(process.execPath, [join(HERE, 'detect.mjs'), DIR]);
if (!det.data) die('detect.mjs produced no output: ' + (det.stderr || '').slice(0, 300));

const today = new Date().toISOString().slice(0, 10);
const perTarget = [];
for (const t of det.data.targets) {
  if (!t.frameworks && !t.frameworksUntracked) continue;
  const resolved = t.frameworks ? await frameworkEol(t.frameworks, today) : [];
  perTarget.push({
    dir: t.dir, lang: t.lang,
    frameworks: resolved,
    untracked: t.frameworksUntracked || [],
  });
}

const allFw = perTarget.flatMap(p => p.frameworks);
emit({
  root: DIR, today,
  targetsWithFrameworks: perTarget.length,
  eolFrameworks: allFw.filter(f => f.isEol).map(f => `${f.product} ${f.cycle}`),
  perTarget,
  note: 'endoflife.date tracks 41 frameworks. Anything under `untracked` has no upstream EOL feed — '
      + 'judge it from its own release notes and support policy, and say so rather than implying a date exists.',
});
