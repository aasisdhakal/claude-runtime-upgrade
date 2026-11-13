export const meta = {
  name: 'fleet',
  description: 'Upgrade any of 15 language runtimes across any repo shape: discover, research EOL/CVEs, assess blockers, plan, adversarially verify',
  whenToUse: 'When upgrading/bumping a language runtime across one or many repos, or auditing runtime EOL/CVE exposure at scale. Pass args: {root, cvePolicy:"gate"|"report", mode:"plan"|"write", skillDir, target?, lang?, only?} where skillDir is the directory holding the runtime-upgrade SKILL.md',
  phases: [
    { title: 'Discover', detail: 'detect.mjs over the root — repo shape, every runtime target, version drift' },
    { title: 'Research', detail: 'per target: EOL windows + runtime CVE delta' },
    { title: 'Assess',   detail: 'per target: dependency advisories, native/ABI blockers, dep floors' },
    { title: 'Plan',     detail: 'per target: phased upgrade plan with gates' },
    { title: 'Challenge',detail: 'adversarial review of each plan — refute blockers and couplings' },
    { title: 'Synthesize', detail: 'cross-target rollup, shared blockers, sequencing' },
  ],
}

const A = (typeof args === 'object' && args) ? args : {}
// Where the skill's files are. A workflow script gets no path variable of its
// own, and this used to be a hard-coded ~/.claude/skills path — which exists on
// the author's machine and on nobody's who installed the plugin from a
// marketplace. The caller passes it (SKILL.md says how); when it does not, one
// cheap agent call finds it.
let SKILL_DIR = A.skillDir ? String(A.skillDir).replace(/\/+$/, '') : ''
if (!SKILL_DIR) {
  const found = await agent(
    `Find the directory that holds the "runtime-upgrade" skill: the one containing BOTH
SKILL.md and scripts/detect.mjs. Check, in this order, and stop at the first that exists:
  1. $CLAUDE_PLUGIN_ROOT/skills/runtime-upgrade (if that variable is set)
  2. ~/.claude/plugins/cache/*/runtime-upgrade/*/skills/runtime-upgrade (newest version directory)
  3. ~/.claude/skills/runtime-upgrade
  4. .claude/skills/runtime-upgrade in the current project
Verify with: ls <dir>/SKILL.md <dir>/scripts/detect.mjs
Return the ABSOLUTE path (expand ~). If none exists, return an empty path.`,
    { label: 'locate skill', schema: { type: 'object', required: ['path'], properties: { path: { type: 'string' } } } },
  )
  SKILL_DIR = found && found.path ? String(found.path).replace(/\/+$/, '') : ''
}
if (!SKILL_DIR) {
  log('could not find the runtime-upgrade skill directory — pass args.skillDir')
  return { error: 'skill directory not found', needed: ['skillDir'] }
}
const SK = SKILL_DIR
const ROOT = A.root || '.'
const POLICY = A.cvePolicy === 'gate' ? 'gate' : 'report'
const MODE = A.mode === 'write' ? 'write' : 'plan'
const TARGET = A.target || ''
const ONLY = Array.isArray(A.only) ? A.only : null

const RULES = `
Skill scripts live at ${SK}/scripts. Read ${SK}/SKILL.md before judging anything.

THE LANGUAGE BRIEF. This prompt deliberately names no language. Everything that differs between
languages — whether runtime CVEs can gate, which dependency auditor runs, what a native blocker
looks like, which registry proves a package supports the target, which engine migrates the source —
comes from one command, and you must run it for the target's language before judging that target:
    node ${SK}/scripts/brief.mjs <lang> <dir> [from] [to]
Read the file it names under "reference". Where this prompt and the brief disagree, the brief wins.
Every "gap" field in the brief is something that was NOT checked: say so, never report it as clean.

CVE policy for this run: ${POLICY.toUpperCase()}.
  - gate   = runtime CVEs counted by the brief's gate.metric, or any critical/high dependency
             advisory, BLOCKS the upgrade.
  - report = surface everything, block nothing; the human decides.
  A hard gate on runtime CVEs is enforceable ONLY where the brief says gate.runtimeCvesCanGate is
  true. Where it is false, follow gate.whenNotCapable and mark runtime CVEs advisory.
  Never imply a gate you cannot enforce.
Action mode: ${MODE.toUpperCase()}. ${MODE === 'plan'
  ? 'READ-ONLY. Do not edit, create, or delete any file in the target repo. Emit diffs as text only.'
  : 'You may edit files, but only on a branch named runtime/<lang>-<target>. Commit per phase, only through guard.mjs. Never commit a dependency change without its lockfile.'}
Be concrete: cite file:line and exact versions. Never report a finding you have not verified by running something.
`

// There is no language list in this file, on purpose. It used to hold one —
// ['node', 'php'] — and it stayed that way long after the skill grew to
// fifteen: a Go or Python target was detected, filtered out, and the run
// reported nothing to upgrade. Whatever detect.mjs reports is a target; what
// is specific to its language comes from brief.mjs at run time.

const TARGETS_SCHEMA = {
  type: 'object',
  required: ['shape', 'targets'],
  properties: {
    shape: { type: 'string' },
    root: { type: 'string' },
    driftCount: { type: 'integer' },
    targets: {
      type: 'array',
      items: {
        type: 'object',
        required: ['lang', 'dir', 'currentVersion'],
        properties: {
          lang: { type: 'string', description: 'exactly as detect.mjs reports it; "unknown" only when it reports none' },
          name: { type: 'string' },
          dir: { type: 'string' },
          currentVersion: { type: 'string' },
          drift: { type: 'boolean' },
          declaredMajors: { type: 'string' },
          containerOnly: { type: 'boolean' },
          skipReason: { type: 'string' },
        },
      },
    },
  },
}

const FINDING_SCHEMA = {
  type: 'object',
  required: ['dir', 'lang', 'currentVersion', 'targetVersion', 'blockers', 'verdict'],
  properties: {
    dir: { type: 'string' }, lang: { type: 'string' },
    currentVersion: { type: 'string' }, targetVersion: { type: 'string' },
    isEol: { type: 'boolean' },
    eolDate: { type: 'string' },
    runtimeCveBlocking: { type: 'integer' },
    runtimeCveRemovedByUpgrade: { type: 'integer' },
    depAdvisories: {
      type: 'object',
      properties: { critical: { type: 'integer' }, high: { type: 'integer' } },
    },
    blockers: {
      type: 'array',
      items: {
        type: 'object',
        required: ['item', 'why', 'severity'],
        properties: {
          item: { type: 'string' },
          why: { type: 'string' },
          severity: { type: 'string', enum: ['blocker', 'major', 'minor'] },
          fix: { type: 'string' },
          evidence: { type: 'string' },
        },
      },
    },
    nativeNoise: { type: 'array', items: { type: 'string' },
      description: 'native artefacts that LOOK like blockers but match the brief\'s native.noise — kept out of the blocker list' },
    notChecked: { type: 'array', items: { type: 'string' },
      description: 'every axis the brief or assess.mjs reported as a gap / not enumerated / not checked' },
    couplings: { type: 'array', items: { type: 'string' },
      description: 'dependency pairs where upgrading one forces a major of another' },
    phasedPlan: { type: 'array', items: { type: 'string' } },
    estimatePoints: { type: 'integer' },
    verdict: { type: 'string', enum: ['proceed', 'proceed-with-conditions', 'blocked'] },
  },
}

const CHALLENGE_SCHEMA = {
  type: 'object',
  required: ['dir', 'upheld', 'refuted'],
  properties: {
    dir: { type: 'string' },
    upheld: { type: 'array', items: { type: 'string' } },
    refuted: {
      type: 'array',
      items: {
        type: 'object',
        required: ['item', 'reason'],
        properties: { item: { type: 'string' }, reason: { type: 'string' }, evidence: { type: 'string' } },
      },
    },
    missed: { type: 'array', items: { type: 'string' } },
    estimateVerdict: { type: 'string' },
  },
}

// ---------------- Phase 1: discover ----------------
phase('Discover')
log(`root=${ROOT} policy=${POLICY} mode=${MODE}${TARGET ? ` target=${TARGET}` : ' target=auto'}`)

const disco = await agent(
  `${RULES}

Run: node ${SK}/scripts/detect.mjs ${ROOT}

Return every runtime target it finds. For each target set currentVersion to the single most
authoritative declared version you can justify — prefer the Dockerfile/CI pin (what actually runs)
over the manifest range (what is merely declared), and say so if they disagree.
Set drift=true wherever declaredMajors holds more than one distinct value.
For targets with no declared version anywhere, set currentVersion to "" and skipReason to why.
Count how many targets have drift and report it as driftCount.`,
  { label: 'detect', phase: 'Discover', schema: TARGETS_SCHEMA },
)

if (!disco || !disco.targets || !disco.targets.length) {
  log('no runtime targets found — nothing to upgrade')
  return { shape: disco && disco.shape, targets: [], findings: [] }
}

let work = disco.targets.filter(t => t.lang && t.lang !== 'unknown')
if (A.lang) work = work.filter(t => t.lang === A.lang)
if (ONLY) work = work.filter(t => ONLY.some(o => t.dir.includes(o) || (t.name || '').includes(o)))
const skipped = work.filter(t => !t.currentVersion)
work = work.filter(t => t.currentVersion)

log(`shape=${disco.shape} · ${disco.targets.length} found · ${work.length} actionable · ${skipped.length} undeclared · drift on ${disco.driftCount || 0}`)
if (skipped.length) log(`skipped (no declared runtime): ${skipped.map(t => t.dir).join(', ')}`)
if (!work.length) return { shape: disco.shape, targets: disco.targets, findings: [], note: 'no target had a declared runtime version' }

// ---------- Phases 2-5: research -> assess+plan -> challenge, pipelined per target ----------
const results = await pipeline(
  work,
  t => agent(
    `${RULES}

Target: ${t.lang} in ${ROOT}/${t.dir} (currently ${t.currentVersion}${t.drift ? ', VERSION DRIFT present' : ''}).

Run: node ${SK}/scripts/brief.mjs ${t.lang} ${ROOT}/${t.dir}
Run: node ${SK}/scripts/research.mjs ${t.lang} ${t.currentVersion} ${TARGET}

Report the EOL window, support/maintenance status, the chosen target version, and the CVE delta.
Return the raw research JSON plus one paragraph of interpretation, and quote the brief's "gate"
block verbatim. If gate.runtimeCvesCanGate is false, say so explicitly.`,
    { label: `research:${t.dir}`, phase: 'Research' },
  ),

  (research, t) => agent(
    `${RULES}

Target: ${t.lang} in ${ROOT}/${t.dir}, currently ${t.currentVersion}.

Research phase returned:
${String(research).slice(0, 4000)}

Now:
0. Run: node ${SK}/scripts/brief.mjs ${t.lang} ${ROOT}/${t.dir} ${t.currentVersion} <the target version from research>
   and read the reference file it names. Steps 1-3 are judged against that brief.
1. Run: node ${SK}/scripts/assess.mjs ${t.lang} ${ROOT}/${t.dir} <the target version from research>
   Its "notes" say what it could not check. Carry every one of them into notChecked.
2. CLASSIFY NATIVE ARTEFACTS BY THE BRIEF'S "native" BLOCK, not by intuition.
   - native.blocker describes the ONLY thing that stops the upgrade on this axis.
   - native.noise describes what looks alarming and is not: put it in nativeNoise, never in blockers.
   - native.unknown describes what cannot be told apart without checking: check it, or list it in notChecked.
   - if native.enumeratedByAssess is false, assess.mjs returned EMPTY lists because it looked at
     nothing. Inspect the axis by hand as the brief describes; an empty list is not a clean result.
   Getting this backwards is the single most expensive error in this workflow.
3. Find COUPLINGS: a dependency whose only target-compatible release forces a major of something
   else (an ORM, a framework). Prove it with the brief's registry.supportsTarget lookup against the
   real registry — do not assume. A coupling you cannot prove is not a coupling.
   Then run the brief's sourceMigration.how and report what the engine would change, what its
   doesNotTouch list leaves for a human, and every hazard it names. If sourceMigration.engine is
   null, say there is no engine for this language and that findings are fixed by hand.
4. Separate runtime work from framework work. Framework majors belong in their own ticket unless
   a coupling genuinely forces them.
5. Produce a phased plan where each phase has a machine-checkable exit condition, and an estimate.

Set verdict: "blocked" if a blocker has no available fix; "proceed-with-conditions" if every blocker
has an owner or an option; "proceed" if clean.${POLICY === 'gate'
  ? ' Under GATE policy, any high/critical runtime CVE at the target, or any critical/high dependency advisory, forces verdict=blocked.'
  : ' Under REPORT policy, never set verdict=blocked for CVE counts alone — report them and let the human decide.'}`,
    { label: `assess:${t.dir}`, phase: 'Assess', schema: FINDING_SCHEMA },
  ),

  (finding, t) => finding ? agent(
    `${RULES}

Adversarially review this upgrade plan for ${t.lang} in ${ROOT}/${t.dir}. Your job is to REFUTE,
not to agree. Default to refuting when the evidence is thin.

${JSON.stringify(finding).slice(0, 6000)}

First run: node ${SK}/scripts/brief.mjs ${t.lang} ${ROOT}/${t.dir}
For each claimed blocker, verify it independently against the real repo and the registry the brief
names — re-run the scripts, read the brief's installedTree or the lockfile, run registry.supportsTarget.
Refute any blocker that:
  - matches the brief's native.noise (ABI-stable, or no native axis at all for this language)
  - already has a compatible release available (check the registry, not the installed tree)
  - was asserted from manifest ranges rather than the installed tree or registry
Also check the claimed couplings: a coupling is real ONLY if you can show the declared range in the registry.
Refute any "clean" claim that rests on something in notChecked or on a brief "gap".
Then say what the plan MISSED — anything in the repo that will break and is not in the list.
Finally judge the estimate: too low, about right, or too high, and why.`,
    { label: `challenge:${t.dir}`, phase: 'Challenge', schema: CHALLENGE_SCHEMA, effort: 'high' },
  ) : null,
)

// ---------- Phase 6: synthesize (genuine barrier: needs every target at once) ----------
phase('Synthesize')
const pairs = work.map((t, i) => ({ target: t, challenge: results[i] })).filter(p => p.challenge)

const rollup = await agent(
  `${RULES}

Every target has now been researched, assessed, and adversarially challenged.

Repo shape: ${disco.shape} · ${work.length} targets · drift on ${disco.driftCount || 0}
${skipped.length ? `Targets with no declared runtime (reported, not upgraded): ${skipped.map(t => t.dir).join(', ')}` : ''}

Challenge results:
${JSON.stringify(pairs).slice(0, 20000)}

Produce the final report:
1. Discovery table: repo, lang, current -> target, EOL status, drift. Call out drift as a defect.
2. CVE delta per target — lead with high/critical runtime CVEs removed by the upgrade.
3. Blockers that SURVIVED the challenge, with evidence. Separately list what was refuted and why,
   so nobody re-raises it.
4. Shared blockers across targets — fix once, apply everywhere.
5. Sequencing: cheapest/lowest-risk target first as the pilot, highest blast radius last.
   Name which target is the pilot and say what it validates.
6. Honest totals: estimate, and what you deliberately left out.
Respect the ${POLICY.toUpperCase()} policy and the ${MODE.toUpperCase()} mode in how you frame it.`,
  { label: 'rollup', phase: 'Synthesize', effort: 'high' },
)

return {
  shape: disco.shape,
  policy: POLICY,
  mode: MODE,
  targetsFound: disco.targets.length,
  targetsAssessed: work.length,
  skipped: skipped.map(t => t.dir),
  driftCount: disco.driftCount || 0,
  perTarget: pairs,
  report: rollup,
}
