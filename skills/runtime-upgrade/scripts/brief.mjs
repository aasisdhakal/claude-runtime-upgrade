#!/usr/bin/env node
// What is specific to ONE language, in one document: how it is gated, how its
// dependencies are audited, what a native blocker looks like, where to check
// that a package supports the target, which engine migrates its source, and the
// exact command for every phase.
//
// usage: node brief.mjs <lang> [dir] [from] [to]
//        node brief.mjs --list
//
// Nothing here is stated twice. Every field is read from the adapter, the
// engine registry, the rule catalogue or lib/langfacts.mjs — the same sources
// the other scripts run on. A prompt that names a language goes stale the day
// a language is added; a prompt that says "run brief.mjs and follow it" cannot.
import { resolve, join, dirname, existsSync, emit, die } from './lib/io.mjs';
import { have } from './lib/sh.mjs';
import { adapters, byId } from './adapters/index.mjs';
import { LANG_FACTS, OSV_SCANNER } from './lib/langfacts.mjs';
import { engineStatus } from './lib/engines.mjs';
import { rulesFor } from './lib/breaking.mjs';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SKILL = resolve(HERE, '..');
const [, , langArg, dirArg, from, to] = process.argv;

if (langArg === '--list') {
  emit({ languages: adapters.map(a => ({ lang: a.id, label: a.label, manifests: a.manifests,
                                         gateCapable: !!a.gateCapable })) });
  process.exit(0);
}
if (!langArg) die('usage: brief.mjs <lang> [dir] [from] [to]   |   brief.mjs --list', 2);
const A = byId[langArg];
if (!A) die(`unsupported language: ${langArg}. Supported: ${adapters.map(a => a.id).join(', ')}`, 2);
const F = LANG_FACTS[A.id];
if (!F) die(`no language facts registered for ${A.id} — add an entry to lib/langfacts.mjs`);
const DIR = dirArg ? resolve(dirArg) : null;
if (DIR && !existsSync(DIR)) die(`no such directory: ${DIR}`);

const s = p => join(HERE, p);
const d = DIR || '<dir>', f = from || '<from>', t = to || '<to>';

// ── dependency audit: the ecosystem's own tool, or the fallback, or nothing ──
const au = F.auditor;
const ownPresent = au?.cmd ? have(au.cmd) : false;
const osvPresent = have(OSV_SCANNER.cmd);
const audit = {
  tool: au?.cmd ? [au.cmd, ...au.args].join(' ') : null,
  note: F.auditorNote || null,
  present: au?.cmd ? ownPresent : null,
  install: au?.install || null,
  fallback: { tool: OSV_SCANNER.cmd, present: osvPresent, install: osvPresent ? null : OSV_SCANNER.install },
  // which of these assess.mjs will actually run on this machine
  willRun: A.id === 'node' || A.id === 'php' ? F.auditorNote
         : ownPresent ? au.cmd : osvPresent ? OSV_SCANNER.cmd : null,
};
if (audit.willRun === null)
  audit.gap = 'no auditor is installed — assess.mjs will report dependency advisories as NOT CHECKED. '
            + 'Do not read that as zero advisories.';

// ── the native / compiled-artefact axis ──
const N = F.native || {};
const native = {
  enumeratedByAssess: !!N.enumerated,
  axis: N.axis || A.abiNote || null,
  blocker: N.blocker || null,
  noise: N.noise || null,
  unknown: N.unknown || null,
};
if (!native.enumeratedByAssess)
  native.gap = 'assess.mjs does not enumerate native artefacts for this language: nativeAddons and '
             + 'nativeBlockers come back EMPTY because nothing was checked. Check the axis above by hand.';

// ── source migration: a real engine, or an honest "none" ──
const engine = engineStatus(A.id, DIR || process.cwd(), from || null, to || null);
const rules = rulesFor(A.id, from || null, to || null);

emit({
  lang: A.id, label: A.label,
  reference: join(SKILL, F.reference),
  manifests: A.manifests,
  lockfiles: A.lockfiles?.length ? A.lockfiles : undefined,
  eolProduct: A.eolProduct,
  gate: {
    // the ONLY thing that decides whether runtime CVEs can block an upgrade
    runtimeCvesCanGate: !!A.gateCapable,
    metric: A.gateCapable ? (A.gateMetric || 'high/critical') : null,
    note: A.gateNote || null,
    source: A.cveSource?.note || null,
    whenNotCapable: A.gateCapable ? null
      : 'gate on EOL/support status and dependency advisories; present runtime CVEs as advisory only',
  },
  dependencyAudit: audit,
  native,
  registry: F.registry,
  installedTree: F.installedTree,
  runtime: { bin: F.runtimeBin, present: have(F.runtimeBin) },
  sourceMigration: engine.engine
    ? { engine: engine.engine, present: engine.present, installWith: engine.installWith,
        covers: engine.covers, doesNotTouch: engine.doesNotTouch,
        hazards: (engine.hazards || []).map(h => h.what || h), exactRecipe: engine.exact,
        how: `node ${s('fix.mjs')} ${A.id} ${d} ${f} ${t}` }
    : { engine: null, why: engine.whyNone,
        how: `node ${s('scan.mjs')} ${A.id} ${d} ${f} ${t}   (preflight findings only — fix by hand)` },
  preflightRules: {
    forThisHop: from && to ? rules.length : null,
    note: from && to ? null : 'pass <from> <to> to count the rules that apply to this upgrade',
  },
  commands: {
    research:  `node ${s('research.mjs')} ${A.id} ${f} ${to || '[target]'}`,
    assess:    `node ${s('assess.mjs')} ${A.id} ${d} ${t}`,
    scan:      `node ${s('scan.mjs')} ${A.id} ${d} ${f} ${t}`,
    fix:       `node ${s('fix.mjs')} ${A.id} ${d} ${f} ${t} --list`,
    remediate: `node ${s('remediate.mjs')} ${A.id} ${d} ${t} --deps none`,
    verify:    `node ${s('verify.mjs')} ${A.id} ${d} ${t}`,
  },
});
