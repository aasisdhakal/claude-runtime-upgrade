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
Skill scripts live at ${SK}/scripts. Read ${SK}/SKILL.md and the matching reference before
judging anything: ${SK}/references/nodejs.md, ${SK}/references/php.md, or
${SK}/references/languages.md for every other language.
CVE policy for this run: ${POLICY.toUpperCase()}.
  - gate   = high/critical runtime CVEs or any critical/high dependency advisory BLOCKS the upgrade.
  - report = surface everything, block nothing; the human decides.
  NOTE: a hard gate on runtime CVEs is only enforceable where research.mjs returns gateCapable:true
  (Node and Go today). For every other language under gate, gate on EOL/support status and the
  ecosystem's dependency advisories, and mark runtime CVEs advisory. Never imply a gate you cannot enforce.
Action mode: ${MODE.toUpperCase()}. ${MODE === 'plan'
  ? 'READ-ONLY. Do not edit, create, or delete any file in the target repo. Emit diffs as text only.'
  : 'You may edit files, but only on a branch named runtime/<lang>-<target>. Commit per phase, only through guard.mjs. Never commit a dependency change without its lockfile.'}
Be concrete: cite file:line and exact versions. Never report a finding you have not verified by running something.
`

// Every language the skill has an adapter for. This list was ['node', 'php']
// long after the skill grew to fifteen, so a Go or Python target was detected,
// then silently filtered out, and the run reported nothing to upgrade.
const LANGS = ['node', 'php', 'go', 'python', 'ruby', 'rust', 'java', 'dotnet',
               'deno', 'bun', 'elixir', 'erlang', 'kotlin', 'scala', 'perl']

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
          lang: { type: 'string', enum: LANGS.concat('unknown') },
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
      description: 'native addons that LOOK scary but are N-API/no-ops — kept out of the blocker list' },
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

let work = disco.targets.filter(t => LANGS.includes(t.lang))
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

Run: node ${SK}/scripts/research.mjs ${t.lang} ${t.currentVersion} ${TARGET}

Report the EOL window, support/maintenance status, the chosen target version, and the CVE delta.
Return the raw JSON plus one paragraph of interpretation. If gateCapable is false, say so explicitly.`,
    { label: `research:${t.dir}`, phase: 'Research' },
  ),

  (research, t) => agent(
    `${RULES}

Target: ${t.lang} in ${ROOT}/${t.dir}, currently ${t.currentVersion}.

Research phase returned:
${String(research).slice(0, 4000)}

Now:
1. Run: node ${SK}/scripts/assess.mjs ${t.lang} ${ROOT}/${t.dir} <the target version from research>
   For Node add RU_ENGINES=1 if the repo has under ~40 direct dependencies.
2. CLASSIFY NATIVE ADDONS CORRECTLY. Only entries with kind "abi-pinned" are real blockers.
   Entries with kind "napi" are ABI-stable no-ops — put them in nativeNoise, never in blockers.
   Getting this backwards is the single most expensive error in this workflow.
3. Find COUPLINGS: a dependency whose only target-compatible release forces a major of something
   else (an ORM, a framework). Prove it by reading the registry peer/engines ranges, do not assume.
   A coupling you cannot prove is not a coupling.
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

For each claimed blocker, verify it independently against the real repo and the ecosystem's
registry (npm, Packagist, PyPI, crates.io, RubyGems, Maven Central, NuGet, the Go proxy, Hex…) —
re-run the scripts, read the installed tree or the lockfile, query the registry.
Refute any blocker that:
  - is actually N-API or otherwise ABI-stable
  - already has a compatible release available (check the registry, not the installed tree)
  - was asserted from manifest ranges rather than the installed tree or registry
Also check the claimed couplings: a coupling is real ONLY if you can show the peer/engines range.
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
