export const meta = {
  name: 'dep-behaviour-check',
  description: 'After a dependency upgrade, prove each changed package still behaves the same — by running it, not by type-checking it',
  whenToUse: 'After `remediate --deps latest`. Pass args: {lang, dir, before} where before is a copy of the lockfile taken BEFORE the upgrade. Optional: {top: 6, judge: true}',
  phases: [
    { title: 'Survey',  detail: 'depverify: what moved, how this repo uses it, what could catch a regression' },
    { title: 'Probe',   detail: 'one agent per package: write a probe from the REAL call sites, run it on old and new' },
    { title: 'Judge',   detail: 'adversarial check that each probe would actually have caught a regression' },
    { title: 'Report',  detail: 'rollup: confirmed-safe, changed-behaviour, and probes that proved nothing' },
  ],
}

const SK = '~/.claude/skills/runtime-upgrade/scripts'
const A = (typeof args === 'object' && args) ? args : {}
const LANG = A.lang || 'node'
const DIR = A.dir
const BEFORE = A.before
const TOP = Number(A.top || 6)
const JUDGE = A.judge !== false

if (!DIR || !BEFORE) {
  log('need {lang, dir, before}: `before` is a copy of the lockfile taken BEFORE the upgrade')
  return { error: 'missing args', needed: ['dir', 'before'] }
}

const PREMISE = `
A type checker only ever catches SHAPE changes — a renamed export, a changed signature,
a different return type. It CANNOT catch the same call returning a different ANSWER:
an unstable sort, a timezone rule, a rounding change, a different hash, a changed
default. No static tool catches that, in any language. In an untyped project nothing
catches even the shape change.

So the only proof that an upgraded dependency still behaves the same is to RUN it, the
way this repository actually uses it, on BOTH versions, and compare the output.

Repo: ${DIR}   Language: ${LANG}
Scripts: ${SK}
`

const PROBE_SCHEMA = {
  type: 'object',
  required: ['package', 'from', 'to', 'outcome', 'probeRan'],
  properties: {
    package: { type: 'string' }, from: { type: 'string' }, to: { type: 'string' },
    probeRan: { type: 'boolean', description: 'did the probe actually execute on BOTH versions?' },
    whyNot: { type: 'string', description: 'if it did not run, exactly what stopped it' },
    apiExercised: { type: 'array', items: { type: 'string' },
      description: 'the specific functions/methods exercised, taken from real call sites in this repo' },
    outcome: { type: 'string', enum: ['identical', 'changed', 'could-not-run', 'inconclusive'] },
    differences: { type: 'array', items: {
      type: 'object', required: ['call', 'before', 'after'],
      properties: { call: { type: 'string' }, before: { type: 'string' }, after: { type: 'string' },
                    wouldTypeCheckerCatch: { type: 'boolean' } } } },
    probeSource: { type: 'string', description: 'the probe actually run, verbatim' },
    confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
  },
}

const VERDICT_SCHEMA = {
  type: 'object',
  required: ['package', 'probeIsMeaningful', 'reasoning'],
  properties: {
    package: { type: 'string' },
    probeIsMeaningful: { type: 'boolean' },
    reasoning: { type: 'string' },
    weaknesses: { type: 'array', items: { type: 'string' } },
    wouldCatchARegression: { type: 'boolean',
      description: 'if the package HAD changed behaviour, would this probe have noticed?' },
  },
}

// ───────── survey ─────────
phase('Survey')
const survey = await agent(
  `${PREMISE}

Run:  node ${SK}/depverify.mjs ${LANG} ${DIR} --before ${BEFORE} --top ${TOP}

Report its probePlan verbatim: for each package, the name, from/to versions, the bump level,
how many files import it, whether it is statically checked, and the top call sites.
Also report the project's type-checking story and the counts summary.
If probePlan is empty, say so plainly and stop.`,
  { label: 'depverify', phase: 'Survey' },
)

// ───────── probe + judge, pipelined per package ─────────
const results = await pipeline(
  Array.from({ length: TOP }, (_, i) => i),

  (i) => agent(
    `${PREMISE}

From this probe plan, take entry #${i + 1} (1-indexed, highest priority first). If there is no
entry #${i + 1}, return outcome "could-not-run" with whyNot "no such entry" and stop.

${String(survey).slice(0, 6000)}

Your job is to find out whether that package still BEHAVES the same. Concretely:

1. Open the call sites the plan names. Read how this repo ACTUALLY uses the package —
   which functions, with which argument shapes, in which order. Do not invent usage;
   a probe of an API this repo never calls proves nothing.

2. Write a small probe that exercises exactly those calls and PRINTS a deterministic
   result for each — the returned value, its type, and its shape. Avoid timestamps,
   randomness, locale-dependent formatting and iteration order unless THAT is what you
   are testing; otherwise the diff is noise.

3. Run it on BOTH versions with the deterministic runner — do NOT hand-roll the
   install, and never modify ${DIR}:

     node ${SK}/probe.mjs <lang> <package> <from> <to> --probe <your probe file>

   It installs each version into its OWN scratch dir (installing over the top leaves
   the old version's transitive deps behind and measures a tree that never existed),
   runs your probe against both, scrubs the scratch paths, and diffs line by line.
   It reads the version actually resolved, so a silently-different resolution shows up.
   Exit 1 means the behaviour changed. Supported: node, python, php, ruby.

   Make the probe print ONE LABELLED LINE PER CALL — the diff is line-level and
   unlabelled output is unreadable. Print the RESULT, not just that it did not throw.

   If the runner reports could-not-run, report that honestly in whyNot. Do NOT guess
   at the output, and do not fall back to reading the package changelog and calling
   it a probe — a changelog is a claim, this phase exists to produce evidence.

4. Diff the two captures. For every difference, record the call, the before value, the
   after value, and whether a TYPE CHECKER would have caught it (it would not, unless
   the TYPE changed — be honest about this, it is the point of the exercise).

Return probeSource verbatim so the judge can assess it.
Set outcome: identical | changed | could-not-run | inconclusive.
Never report "identical" for a probe that did not actually run on both versions.`,
    { label: `probe:${i + 1}`, phase: 'Probe', schema: PROBE_SCHEMA },
  ),

  (probe) => (JUDGE && probe && probe.probeRan) ? agent(
    `${PREMISE}

Adversarially judge this probe. Your job is to decide whether it would ACTUALLY have
caught a behaviour regression — not whether it ran.

${JSON.stringify(probe).slice(0, 7000)}

Check specifically:
- Does it exercise the API surface this repo really uses, or a trivial subset?
- Would a changed return VALUE (same type) have shown up in the output it prints?
- Does it print enough to distinguish a changed result from an unchanged one, or does it
  only check "did not throw"? A probe that only proves absence of a crash is near-worthless.
- Is the output deterministic, or would it differ run-to-run regardless of the upgrade?
- If outcome is "identical", is that trustworthy, or did the probe simply not look hard enough?

Default to probeIsMeaningful:false when uncertain. A probe that proves nothing is worse
than no probe, because it creates false confidence.`,
    { label: `judge:${probe.package}`, phase: 'Judge', schema: VERDICT_SCHEMA, effort: 'high' },
  ).then(v => ({ ...probe, judge: v })) : probe,
)

// ───────── rollup ─────────
phase('Report')
const done = results.filter(Boolean)
const ran = done.filter(p => p.probeRan)
const changed = ran.filter(p => p.outcome === 'changed')
const identical = ran.filter(p => p.outcome === 'identical')
const weak = done.filter(p => p.judge && !p.judge.probeIsMeaningful)

const report = await agent(
  `${PREMISE}

Every package has now been probed and adversarially judged.

${JSON.stringify(done).slice(0, 20000)}

Write the report:
1. **Behaviour CHANGED** — per package: the exact call, before vs after, and whether a type
   checker would have caught it. These are the findings; lead with them.
2. **Confirmed unchanged** — but only where the judge agreed the probe was meaningful. A
   probe the judge rejected does NOT belong here.
3. **Proved nothing** — probes that ran but the judge found weak, and probes that could not
   run, each with the reason. Be blunt: this is where false confidence would come from.
4. **What a type checker would have caught** — state honestly how many of the findings a
   type checker could have caught on its own, and how many it could not. That ratio is the
   argument for doing this at all.
5. The single most important thing for a human to look at.`,
  { label: 'rollup', phase: 'Report', effort: 'high' },
)

return {
  dir: DIR, lang: LANG,
  probed: done.length, ran: ran.length,
  behaviourChanged: changed.length,
  confirmedUnchanged: identical.filter(p => !p.judge || p.judge.probeIsMeaningful).length,
  provedNothing: weak.length + done.filter(p => !p.probeRan).length,
  perPackage: done,
  report,
}
