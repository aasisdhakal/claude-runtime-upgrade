// Where work goes: code review (PRs/MRs) and issue trackers.
//
// The registry is data, not branching logic, so adding a provider is one entry.
// Nothing here picks for the user — `detect` reports what is installed and what
// suits the remote, and every caller requires an explicit choice.
import { have, run } from './sh.mjs';

/** Identify the forge from a git remote URL. */
export function hostOf(url) {
  if (!url) return null;
  const m = String(url).match(/(?:git@|https?:\/\/)(?:[^@]*@)?([^/:]+)/);
  const h = m?.[1]?.toLowerCase() || null;
  if (!h) return null;
  if (/github\.com$/.test(h)) return 'github';
  if (/gitlab/.test(h)) return 'gitlab';
  if (/bitbucket\.org$/.test(h)) return 'bitbucket';
  if (/dev\.azure\.com$|visualstudio\.com$/.test(h)) return 'azure';
  if (/gitea|forgejo|codeberg/.test(h)) return 'gitea';
  return h;                                    // self-hosted: report it verbatim
}

/** owner/repo (or project/repo) from a remote URL, best effort. */
export function slugOf(url) {
  if (!url) return null;
  const m = String(url).match(/(?:git@|https?:\/\/)[^/:]+[/:](.+?)(?:\.git)?$/);
  return m?.[1] || null;
}

// ───────────────────────── code review ─────────────────────────
export const PR_PROVIDERS = [
  { id: 'gh', bin: 'gh', label: 'GitHub CLI', hosts: ['github'],
    auth: 'gh auth login',
    args: c => ['pr', 'create', '--base', c.base, '--head', c.branch,
                '--title', c.title, '--body', c.body, ...(c.draft ? ['--draft'] : [])] },
  { id: 'glab', bin: 'glab', label: 'GitLab CLI', hosts: ['gitlab'],
    auth: 'glab auth login',
    args: c => ['mr', 'create', '--target-branch', c.base, '--source-branch', c.branch,
                '--title', c.title, '--description', c.body, ...(c.draft ? ['--draft'] : [])] },
  { id: 'az', bin: 'az', label: 'Azure DevOps CLI', hosts: ['azure'],
    auth: 'az login && az devops configure --defaults organization=<org> project=<project>',
    args: c => ['repos', 'pr', 'create', '--source-branch', c.branch, '--target-branch', c.base,
                '--title', c.title, '--description', c.body,
                ...(c.repo ? ['--repository', c.repo] : []),
                ...(c.workItems ? ['--work-items', c.workItems] : []),
                ...(c.draft ? ['--draft', 'true'] : [])] },
  { id: 'tea', bin: 'tea', label: 'Gitea/Forgejo CLI', hosts: ['gitea'],
    auth: 'tea login add',
    args: c => ['pr', 'create', '--base', c.base, '--head', c.branch,
                '--title', c.title, '--description', c.body] },
  { id: 'bb', bin: 'bb', label: 'Bitbucket CLI', hosts: ['bitbucket'],
    auth: 'bb auth login',
    args: c => ['pr', 'create', '--source', c.branch, '--destination', c.base,
                '--title', c.title, '--description', c.body] },
  { id: 'push', bin: 'git', label: 'git push + compare URL', hosts: ['*'],
    auth: null, args: null,
    note: 'pushes the branch and prints the URL to open the request by hand — works on any host' },
  { id: 'patch', bin: 'git', label: 'patch file', hosts: ['*'],
    auth: null, args: null,
    note: 'writes a .patch and the description; contacts no remote at all' },
];

/** Where to open a PR by hand, per forge. */
export function compareUrl(host, slug, base, branch) {
  if (!slug) return null;
  switch (host) {
    case 'github':    return `https://github.com/${slug}/compare/${base}...${branch}`;
    case 'gitlab':    return `https://gitlab.com/${slug}/-/merge_requests/new?merge_request[source_branch]=${branch}`;
    case 'bitbucket': return `https://bitbucket.org/${slug}/pull-requests/new?source=${branch}&dest=${base}`;
    case 'azure':     return `https://dev.azure.com/${slug}/pullrequestcreate?sourceRef=${branch}&targetRef=${base}`;
    case 'gitea':     return null;
    default:          return null;
  }
}

// ───────────────────────── issue trackers ─────────────────────────
// Deliberately separate from PR_PROVIDERS: plenty of teams review code on
// GitHub and track work in Jira, or ship from Azure Repos into Azure Boards.
export const ISSUE_PROVIDERS = [
  { id: 'jira', bin: 'jira', label: 'Jira (jira-cli)',
    auth: 'jira init',
    args: c => ['issue', 'create', '--no-input',
                '-t', c.type || 'Task', '-s', c.title, '-b', c.body,
                ...(c.project ? ['-p', c.project] : []),
                ...(c.priority ? ['-y', c.priority] : []),
                ...(c.labels || []).flatMap(l => ['-l', l]),
                ...(c.parent ? ['-P', c.parent] : [])] },
  { id: 'jira-mcp', bin: null, label: 'Jira (Atlassian MCP)',
    auth: 'connect the Atlassian connector in Claude',
    args: null,
    note: 'no CLI needed — the assistant calls createJiraIssue directly' },
  { id: 'az-boards', bin: 'az', label: 'Azure Boards',
    auth: 'az login && az devops configure --defaults organization=<org> project=<project>',
    args: c => ['boards', 'work-item', 'create', '--title', c.title,
                '--type', c.type || 'Task', '--description', c.body,
                ...(c.project ? ['--project', c.project] : []),
                ...(c.area ? ['--area', c.area] : []),
                ...(c.assignee ? ['--assigned-to', c.assignee] : [])] },
  { id: 'gh-issue', bin: 'gh', label: 'GitHub Issues',
    auth: 'gh auth login',
    args: c => ['issue', 'create', '--title', c.title, '--body', c.body,
                ...(c.labels || []).flatMap(l => ['--label', l]),
                ...(c.assignee ? ['--assignee', c.assignee] : [])] },
  { id: 'glab-issue', bin: 'glab', label: 'GitLab Issues',
    auth: 'glab auth login',
    args: c => ['issue', 'create', '--title', c.title, '--description', c.body,
                ...(c.labels?.length ? ['--label', c.labels.join(',')] : []),
                ...(c.assignee ? ['--assignee', c.assignee] : [])] },
  { id: 'linear', bin: 'linear', label: 'Linear CLI',
    auth: 'linear auth',
    args: c => ['issue', 'create', '--title', c.title, '--description', c.body,
                ...(c.team ? ['--team', c.team] : [])] },
  { id: 'tea-issue', bin: 'tea', label: 'Gitea/Forgejo Issues',
    auth: 'tea login add',
    args: c => ['issue', 'create', '--title', c.title, '--description', c.body] },
  { id: 'csv', bin: null, label: 'CSV for bulk import',
    auth: null, args: null,
    note: 'Jira, Azure Boards, Linear and GitHub all import CSV — right when the CLI is not set up or the volume is large' },
  { id: 'markdown', bin: null, label: 'Markdown files',
    auth: null, args: null,
    note: 'one file per ticket; paste anywhere, or review before anything is filed' },
];

/** What this machine can actually do, with no choice made. */
export function availability(providers, host) {
  return providers.map(p => ({
    id: p.id, label: p.label,
    installed: p.bin ? have(p.bin) : true,          // CLI-less routes are always available
    needsCli: p.bin,
    suitsHost: !p.hosts ? null : p.hosts.includes('*') || (host ? p.hosts.includes(host) : false),
    auth: p.auth,
    note: p.note || null,
  }));
}

export function pickSuggestion(providers, host) {
  // 1. an installed CLI that matches the forge
  const fit = providers.find(p => p.bin && have(p.bin) && p.hosts && !p.hosts.includes('*')
                                  && host && p.hosts.includes(host));
  if (fit) return fit.id;
  // 2. any installed CLI that can actually file something
  const anyCli = providers.find(p => p.bin && have(p.bin) && p.args);
  if (anyCli) return anyCli.id;
  // 3. a universal route that needs no CLI — never return null, there is
  //    always something the user can do
  const universal = providers.find(p => p.hosts?.includes('*') && (!p.bin || have(p.bin)));
  return universal?.id ?? providers.find(p => !p.bin)?.id ?? null;
}
