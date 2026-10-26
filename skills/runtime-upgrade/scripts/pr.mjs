#!/usr/bin/env node
// Open a pull/merge request for an upgrade branch — using whichever tool the
// user actually has and wants. This script NEVER picks for them and NEVER
// pushes without --push.
//
//   node pr.mjs detect  <dir>                 what can this machine do?
//   node pr.mjs body    <dir> --plan P.json   render the PR description
//   node pr.mjs open    <dir> --tool gh|glab|tea|push|patch [--push] [--draft]
//
// Tools, in no particular order of preference:
//   gh     GitHub CLI          glab   GitLab CLI
//   tea    Gitea/Forgejo CLI   push   push the branch and print the compare URL
//   patch  write a .patch file and change nothing remote
import { resolve, join, existsSync, readJson, emit, die } from './lib/io.mjs';
import { have, run } from './lib/sh.mjs';
import { writeFileSync } from 'node:fs';

const argv = process.argv.slice(2);
const cmd = argv[0];
const DIR = resolve(argv[1] && !argv[1].startsWith('--') ? argv[1] : '.');
const flag = n => { const i = argv.indexOf('--' + n); return i >= 0 ? argv[i + 1] : null; };
const has = n => argv.includes('--' + n);
if (!cmd) die('usage: pr.mjs <detect|body|open> <dir> [options]', 2);
if (!existsSync(DIR)) die(`no such directory: ${DIR}`);

const git = (...a) => run('git', a, { cwd: DIR, timeout: 60000 });

function remoteInfo() {
  const url = git('remote', 'get-url', 'origin').stdout.trim();
  if (!url) return { url: null, host: null, slug: null };
  const m = url.match(/(?:git@|https?:\/\/)([^/:]+)[/:]([^/]+\/[^/]+?)(?:\.git)?$/);
  return { url, host: m?.[1] || null, slug: m?.[2] || null };
}

const TOOLS = [
  { id: 'gh',    bin: 'gh',   label: 'GitHub CLI',        hosts: [/github\.com$/],
    note: 'opens a real PR; needs `gh auth login`' },
  { id: 'glab',  bin: 'glab', label: 'GitLab CLI',        hosts: [/gitlab/],
    note: 'opens a merge request; needs `glab auth login`' },
  { id: 'tea',   bin: 'tea',  label: 'Gitea/Forgejo CLI', hosts: [/gitea|forgejo|codeberg/],
    note: 'opens a PR on Gitea-family hosts; needs `tea login add`' },
  { id: 'push',  bin: 'git',  label: 'git push + compare URL', hosts: [/.*/],
    note: 'pushes the branch and prints the URL to open the PR by hand — works on any host' },
  { id: 'patch', bin: 'git',  label: 'patch file',        hosts: [/.*/],
    note: 'writes a .patch and touches no remote at all — right for air-gapped or review-first flows' },
];

function detect() {
  const r = remoteInfo();
  const branch = git('rev-parse', '--abbrev-ref', 'HEAD').stdout.trim();
  const base = ['main', 'master', 'develop', 'trunk']
    .find(b => git('rev-parse', '--verify', `origin/${b}`).ok || git('rev-parse', '--verify', b).ok) || 'main';
  const ahead = git('rev-list', '--count', `${base}..HEAD`).stdout.trim();
  return {
    dir: DIR, branch, base, commitsAhead: Number(ahead) || 0, remote: r,
    available: TOOLS.map(t => ({
      id: t.id, label: t.label, installed: have(t.bin),
      suitsHost: r.host ? t.hosts.some(h => h.test(r.host)) : t.id === 'patch',
      note: t.note,
    })),
    // a recommendation, never a decision
    suggestion: (() => {
      const fit = TOOLS.find(t => have(t.bin) && r.host && t.hosts.some(h => h.test(r.host)) && t.id !== 'push' && t.id !== 'patch');
      return fit ? fit.id : (r.url ? 'push' : 'patch');
    })(),
    choiceIsYours: 'Nothing is opened or pushed unless you pass --tool and --push. '
                 + 'Pick whichever of these fits your workflow; the plan and the diff are identical either way.',
  };
}

function body() {
  const planPath = flag('plan');
  const plan = planPath ? readJson(resolve(planPath)) : null;
  const p = plan?.plans?.[0];
  const d = detect();
  const L = [];
  if (p) {
    L.push(`## ${p.lang} ${p.current} → ${p.target}`, '');
    if (p.eol?.isEol) L.push(`**${p.lang} ${p.current} is end-of-life** (since ${p.eol.date}). The target is supported until ${p.eol.targetEol}.`, '');
    if (p.cve?.gateCapable) L.push(`**Runtime CVEs:** ${p.cve.currentBlocking} → ${p.cve.targetBlocking} (${p.cve.removed} closed by this change)`, '');
    if (p.cyclesCrossed) L.push(`**Release cycles crossed:** ${p.cyclesCrossed}${p.editionJump ? ' — this crosses a language EDITION boundary' : ''}`, '');
    if (p.stepwise) L.push('', `> ⚠ ${p.stepwise}`, '');
    if (p.blockers?.length) {
      L.push('', '### Blockers', '');
      for (const b of p.blockers) L.push(`- \`${b.severity}\` **${b.item}** — ${b.detail}`);
    }
    if (p.nativeNoise?.length) L.push('', `*Checked and NOT blockers (ABI-stable): ${p.nativeNoise.join(', ')}*`);
    if (p.sourceScan?.findings) L.push('', `### Source scan`, '',
      `${p.sourceScan.findings} finding(s) across ${p.sourceScan.filesScanned} files: ${JSON.stringify(p.sourceScan.bySeverity)}`);
    if (p.testStrategy) {
      L.push('', '### How to verify', '');
      for (const x of p.testStrategy.ladder) L.push(`- ${x}`);
      L.push('', `Make deprecations fatal: \`${p.testStrategy.deprecationsFatal}\``);
    }
    if (p.rollback) L.push('', '### Rollback', '', `**Trigger:** ${p.rollback.trigger}`, '',
      ...p.rollback.procedure.map(x => `- ${x}`));
    if (p.risk) L.push('', `### Risk: ${p.risk.level}`, '', ...p.risk.signals.map(s => `- ${s}`));
  } else {
    L.push('## Runtime upgrade', '', 'Generated without a plan file — pass `--plan <plan.json>` for the full rationale.');
  }
  L.push('', '---', '',
    `Files changed on \`${d.branch}\`:`, '',
    '```', git('diff', '--stat', `${d.base}..HEAD`).stdout.trim() || '(none)', '```', '',
    '*Prepared by the `runtime-upgrade` skill. Every change above is reproducible: '
    + 'run `plan.mjs` for the analysis and `remediate.mjs` for the edits.*');
  return L.join('\n');
}

if (cmd === 'detect') { emit(detect()); process.exit(0); }
if (cmd === 'body')   { process.stdout.write(body() + '\n'); process.exit(0); }

if (cmd === 'open') {
  const tool = flag('tool');
  const d = detect();
  if (!tool) {
    emit({ ...d, error: 'no --tool given', howToChoose: TOOLS.map(t => `--tool ${t.id}  — ${t.label}: ${t.note}`) });
    process.exit(2);
  }
  const t = TOOLS.find(x => x.id === tool) || die(`unknown tool: ${tool}. known: ${TOOLS.map(x => x.id).join(', ')}`, 2);
  if (!have(t.bin)) die(`${t.bin} is not installed — pick another --tool (see: pr.mjs detect ${DIR})`);
  if (!d.commitsAhead) die(`branch ${d.branch} has no commits ahead of ${d.base} — nothing to open a PR for`);

  const title = flag('title') || `Upgrade runtime on ${d.branch.replace(/^runtime\//, '')}`;
  const text = body();

  if (t.id === 'patch') {
    const out = resolve(flag('out') || join(DIR, `${d.branch.replace(/\//g, '-')}.patch`));
    const patch = git('format-patch', `${d.base}..HEAD`, '--stdout').stdout;
    writeFileSync(out, patch);
    writeFileSync(out.replace(/\.patch$/, '.md'), text);
    emit({ tool: t.id, wrote: [out, out.replace(/\.patch$/, '.md')], pushed: false,
           note: 'nothing was pushed and no remote was contacted' });
    process.exit(0);
  }

  if (!has('push')) {
    emit({ tool: t.id, branch: d.branch, base: d.base, wouldRun: describe(t, d, title),
           pushed: false, opened: false,
           note: 'dry run — re-run with --push to actually push the branch and open the request' });
    process.exit(0);
  }

  const pushed = run('git', ['push', '-u', 'origin', d.branch], { cwd: DIR, timeout: 180000 });
  if (!pushed.ok) die(`git push failed: ${(pushed.stderr || pushed.stdout).trim().slice(0, 300)}`);

  if (t.id === 'push') {
    const compare = d.remote.host && d.remote.slug
      ? `https://${d.remote.host}/${d.remote.slug}/compare/${d.base}...${d.branch}`
      : null;
    emit({ tool: t.id, pushed: true, opened: false, branch: d.branch, compareUrl: compare,
           body: text, note: 'branch pushed; open the request yourself at the URL above' });
    process.exit(0);
  }

  const args = t.id === 'gh'
    ? ['pr', 'create', '--base', d.base, '--head', d.branch, '--title', title, '--body', text, ...(has('draft') ? ['--draft'] : [])]
    : t.id === 'glab'
    ? ['mr', 'create', '--target-branch', d.base, '--source-branch', d.branch, '--title', title, '--description', text, ...(has('draft') ? ['--draft'] : [])]
    : ['pr', 'create', '--base', d.base, '--head', d.branch, '--title', title, '--description', text];
  const r = run(t.bin, args, { cwd: DIR, timeout: 180000 });
  emit({ tool: t.id, pushed: true, opened: r.ok, url: (r.stdout.match(/https?:\/\/\S+/) || [])[0] || null,
         output: (r.stdout || r.stderr).slice(0, 2000) });
  process.exit(r.ok ? 0 : 1);
}

function describe(t, d, title) {
  if (t.id === 'push') return `git push -u origin ${d.branch}`;
  if (t.id === 'gh')   return `git push -u origin ${d.branch} && gh pr create --base ${d.base} --title "${title}" --body <generated>`;
  if (t.id === 'glab') return `git push -u origin ${d.branch} && glab mr create --target-branch ${d.base} --title "${title}"`;
  return `git push -u origin ${d.branch} && tea pr create --base ${d.base} --title "${title}"`;
}

die(`unknown command: ${cmd}`, 2);
