#!/usr/bin/env node
// File the upgrade work as tickets, in whichever tracker the user picks.
//
//   node issue.mjs detect  [dir]
//   node issue.mjs render  --plan plan.json [--format md|csv|json]
//   node issue.mjs create  --plan plan.json --tool <t> [--apply] [--project P]
//
// Trackers: jira (jira-cli) · jira-mcp · az-boards · gh-issue · glab-issue
//           linear · tea-issue · csv · markdown
//
// Nothing is filed without --apply. Without --tool it refuses and lists the
// options. CSV and Markdown contact nothing at all.
import { resolve, join, existsSync, readJson, emit, die } from './lib/io.mjs';
import { have, run } from './lib/sh.mjs';
import { ISSUE_PROVIDERS, hostOf, slugOf, availability, pickSuggestion } from './lib/providers.mjs';
import { writeFileSync, mkdirSync } from 'node:fs';

const argv = process.argv.slice(2);
const cmd = argv[0] || die('usage: issue.mjs <detect|render|create> [options]', 2);
const flag = n => { const i = argv.indexOf('--' + n); return i >= 0 ? argv[i + 1] : null; };
const has = n => argv.includes('--' + n);
const DIR = resolve(argv[1] && !argv[1].startsWith('--') ? argv[1] : '.');

function remoteHost() {
  const url = run('git', ['remote', 'get-url', 'origin'], { cwd: DIR, timeout: 20000 }).stdout.trim();
  return { url, host: hostOf(url), slug: slugOf(url) };
}

if (cmd === 'detect') {
  const r = remoteHost();
  emit({
    dir: DIR, remote: r,
    available: availability(ISSUE_PROVIDERS, r.host),
    suggestion: pickSuggestion(ISSUE_PROVIDERS, r.host),
    choiceIsYours: 'Code review and issue tracking are separate choices. Plenty of teams review on '
                 + 'GitHub and track in Jira, or ship from Azure Repos into Azure Boards. '
                 + 'Nothing is filed without --tool and --apply.',
  });
  process.exit(0);
}

// ───────── build the tickets from the plan ─────────
const planPath = flag('plan') || die('--plan <plan.json> is required', 2);
const plan = readJson(resolve(planPath)) || die(`cannot read ${planPath}`, 2);
const plans = (plan.plans || []).filter(p => !p.error);
if (!plans.length) die('the plan contains no actionable targets');

const esc = s => String(s ?? '');
function describe(p) {
  const L = [];
  L.push(`${p.lang} ${p.current} -> ${p.target}`, '');
  if (p.eol?.isEol) L.push(`${p.lang} ${p.current} is END OF LIFE (since ${p.eol.date}). Target supported to ${p.eol.targetEol}.`, '');
  if (p.cve?.gateCapable) L.push(`Runtime CVEs: ${p.cve.currentBlocking} -> ${p.cve.targetBlocking} (${p.cve.removed} closed)`, '');
  else if (p.cve?.note) L.push(`Runtime CVEs: not gateable for this runtime. ${String(p.cve.note).slice(0, 150)}`, '');
  if (p.dependencyAdvisories?.critical != null)
    L.push(`Dependency advisories: ${p.dependencyAdvisories.critical} critical, ${p.dependencyAdvisories.high} high`, '');
  if (p.cyclesCrossed) L.push(`Release cycles crossed: ${p.cyclesCrossed}${p.editionJump ? ' (EDITION boundary — plan as a port)' : ''}`, '');
  if (p.stepwise) L.push(`WARNING: ${p.stepwise}`, '');
  if (p.frameworks?.tracked?.length)
    L.push('Frameworks: ' + p.frameworks.tracked.map(f => `${f.product} ${f.cycle}${f.isEol ? ` (EOL ${f.eol})` : ''}`).join(', '), '');
  if (p.blockers?.length) {
    L.push('', 'BLOCKERS');
    for (const b of p.blockers) L.push(`- [${b.severity}] ${b.item} — ${b.detail}${b.fix ? ` -> ${b.fix}` : ''}`);
  }
  if (p.nativeNoise?.length) L.push('', `Checked and NOT blockers (ABI-stable): ${p.nativeNoise.join(', ')}`);
  if (p.sourceScan?.findings)
    L.push('', `Source scan: ${p.sourceScan.findings} finding(s) over ${p.sourceScan.filesScanned} files `
             + `(${p.sourceScan.autofixable ?? 0} mechanically fixable, ${p.sourceScan.needsAHuman ?? 0} need a human)`);
  if (p.steps?.length) {
    L.push('', 'STEPS');
    for (const s of p.steps) L.push(`${s.n}. ${s.title}`, `   why: ${s.why}`, `   exit: ${s.exit}`);
  }
  if (p.rollback) L.push('', 'ROLLBACK', `Trigger: ${p.rollback.trigger}`, ...p.rollback.procedure.map(x => `- ${x}`));
  if (p.risk) L.push('', `RISK: ${p.risk.level}`, ...p.risk.signals.map(s => `- ${s}`));
  return L.join('\n');
}

const epic = {
  kind: 'epic',
  title: `Runtime upgrade across ${plans.length} target(s)`,
  body: [
    `${plans.length} target(s). Total estimate: ${plan.totalEstimatePoints ?? '?'} points.`,
    '',
    ...plans.map(p => `- ${p.dir} (${p.lang}) ${p.current} -> ${p.target} — ${p.verdict}, risk ${p.risk?.level}, ${p.estimatePoints} pts`),
    '',
    plan.sequencing
      ? `Sequencing: ${plan.sequencing.order.join(' -> ')}\nPilot: ${plan.sequencing.pilot} — ${plan.sequencing.pilotRationale}`
      : '',
  ].join('\n'),
  labels: ['runtime-upgrade', 'security'],
  points: null,
};
const tickets = [epic, ...plans.map(p => ({
  kind: 'task',
  title: `[${p.name || p.dir}] ${p.lang} ${p.current} -> ${p.target}`,
  body: describe(p),
  labels: ['runtime-upgrade', p.lang, ...(p.eol?.isEol ? ['eol'] : []), ...(p.risk?.level === 'high' ? ['high-risk'] : [])],
  points: p.estimatePoints,
  priority: p.risk?.level === 'high' ? 'High' : p.risk?.level === 'medium' ? 'Medium' : 'Low',
  dir: p.dir,
}))];

if (cmd === 'render') {
  const fmt = flag('format') || 'md';
  if (fmt === 'json') { emit({ tickets }); process.exit(0); }
  if (fmt === 'csv') {
    const Q = String.fromCharCode(34);
    const q = v => Q + String(v ?? '').split(Q).join(Q + Q) + Q;
    const rows = [['Summary', 'Issue Type', 'Priority', 'Labels', 'Story Points', 'Description']];
    for (const t of tickets)
      rows.push([t.title, t.kind === 'epic' ? 'Epic' : 'Task', t.priority || '',
                 (t.labels || []).join(' '), t.points ?? '', t.body]);
    process.stdout.write(rows.map(r => r.map(q).join(',')).join('\n') + '\n');
    process.exit(0);
  }
  process.stdout.write(tickets.map(t =>
    `# ${t.title}\n\n**Type:** ${t.kind} · **Priority:** ${t.priority || '-'} · `
    + `**Labels:** ${(t.labels || []).join(', ')}${t.points ? ` · **Points:** ${t.points}` : ''}\n\n${t.body}\n`
  ).join('\n---\n\n'));
  process.exit(0);
}

if (cmd !== 'create') die(`unknown command: ${cmd}`, 2);

const tool = flag('tool');
if (!tool) {
  const r = remoteHost();
  emit({
    error: 'no --tool given', ticketsReady: tickets.length,
    available: availability(ISSUE_PROVIDERS, r.host),
    howToChoose: ISSUE_PROVIDERS.map(t => `--tool ${t.id}  — ${t.label}`
      + (t.note ? `: ${t.note}` : t.auth ? ` (needs: ${t.auth})` : '')),
  });
  process.exit(2);
}
const P = ISSUE_PROVIDERS.find(x => x.id === tool)
  || die(`unknown tool: ${tool}. known: ${ISSUE_PROVIDERS.map(x => x.id).join(', ')}`, 2);

// CLI-less routes write files and contact nothing
if (P.id === 'csv' || P.id === 'markdown') {
  const out = resolve(flag('out') || join(DIR, P.id === 'csv' ? 'upgrade-tickets.csv' : 'upgrade-tickets'));
  if (P.id === 'csv') {
    const Q = String.fromCharCode(34);
    const q = v => Q + String(v ?? '').split(Q).join(Q + Q) + Q;
    const rows = [['Summary', 'Issue Type', 'Priority', 'Labels', 'Story Points', 'Description']];
    for (const t of tickets)
      rows.push([t.title, t.kind === 'epic' ? 'Epic' : 'Task', t.priority || '',
                 (t.labels || []).join(' '), t.points ?? '', t.body]);
    writeFileSync(out, rows.map(r => r.map(q).join(',')).join('\n') + '\n');
    emit({ tool: P.id, wrote: [out], filed: false,
           note: 'importable by Jira, Azure Boards, Linear and GitHub. No remote was contacted.' });
  } else {
    mkdirSync(out, { recursive: true });
    const files = tickets.map((t, i) => {
      const f = join(out, `${String(i).padStart(2, '0')}-${t.kind}-${(t.dir || 'epic').replace(/[^\w.-]/g, '-')}.md`);
      writeFileSync(f, `# ${t.title}\n\n${t.body}\n`);
      return f;
    });
    emit({ tool: P.id, wrote: files, filed: false, note: 'no remote was contacted' });
  }
  process.exit(0);
}

if (P.id === 'jira-mcp') {
  emit({
    tool: P.id, filed: false, tickets,
    note: 'This route has no CLI. The assistant should call the Atlassian connector\'s '
        + 'createJiraIssue once per ticket above, parenting each task to the epic it creates first.',
  });
  process.exit(0);
}

if (!have(P.bin)) {
  emit({ tool: P.id, filed: false, cliInstalled: false,
         setup: `install ${P.bin}, then: ${P.auth}`,
         wouldRun: tickets.map(t => `${P.bin} ${P.args({ ...t, type: t.kind === 'epic' ? 'Epic' : 'Task',
           project: flag('project'), team: flag('team'), assignee: flag('assignee') }).join(' ')}`.slice(0, 220)),
         alternatives: ['--tool csv', '--tool markdown', '--tool jira-mcp'],
         note: `${P.bin} is not installed. The commands above are what would run; csv and markdown need nothing.` });
  process.exit(0);
}

if (!has('apply')) {
  emit({ tool: P.id, filed: false, ticketCount: tickets.length,
         wouldRun: tickets.map(t => `${P.bin} ${P.args({ ...t, type: t.kind === 'epic' ? 'Epic' : 'Task',
           project: flag('project'), team: flag('team'), assignee: flag('assignee') }).join(' ')}`.slice(0, 220)),
         note: 'dry run — re-run with --apply to file these' });
  process.exit(0);
}

const results = [];
for (const t of tickets) {
  const args = P.args({ ...t, type: t.kind === 'epic' ? 'Epic' : 'Task',
                        project: flag('project'), team: flag('team'), assignee: flag('assignee') });
  const r = run(P.bin, args, { cwd: DIR, timeout: 120000 });
  results.push({ title: t.title, ok: r.ok,
                 ref: (r.stdout.match(/[A-Z][A-Z0-9]+-\d+|https?:\/\/\S+|\b\d{3,}\b/) || [])[0] || null,
                 output: (r.stdout || r.stderr).slice(0, 400) });
  if (!r.ok) break;                       // stop on the first failure rather than half-filing
}
emit({ tool: P.id, filed: results.filter(r => r.ok).length, attempted: results.length,
       results, stoppedEarly: results.some(r => !r.ok) });
process.exit(results.every(r => r.ok) ? 0 : 1);
