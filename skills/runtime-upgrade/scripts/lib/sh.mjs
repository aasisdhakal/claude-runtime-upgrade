// Safe command execution. Captures output regardless of exit code —
// `npm audit` and `pnpm audit` EXIT NON-ZERO when advisories exist, and
// treating that as failure is how you end up with two JSON documents.
import { execFileSync, spawnSync } from 'node:child_process';

export function have(cmd) {
  const probe = process.platform === 'win32' ? 'where' : 'command';
  const args = process.platform === 'win32' ? [cmd] : ['-v', cmd];
  try {
    const r = spawnSync(probe, args, { stdio: 'ignore', shell: process.platform !== 'win32' });
    return r.status === 0;
  } catch { return false; }
}

/** Run a command; return {ok, stdout, stderr, status}. Never throws. */
export function run(cmd, args = [], { cwd, timeout = 120000, env } = {}) {
  try {
    const r = spawnSync(cmd, args, {
      cwd, timeout, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
      env: { ...process.env, ...env },
    });
    return {
      ok: r.status === 0,
      status: r.status,
      stdout: r.stdout || '',
      stderr: r.stderr || '',
      error: r.error ? String(r.error.message) : null,
    };
  } catch (e) {
    return { ok: false, status: null, stdout: '', stderr: '', error: String(e.message || e) };
  }
}

/** Run and parse stdout as JSON, ignoring exit status. */
export function runJson(cmd, args, opts) {
  const r = run(cmd, args, opts);
  if (!r.stdout.trim()) return { data: null, ...r };
  try { return { data: JSON.parse(r.stdout), ...r }; }
  catch {
    // some tools emit NDJSON — take the first complete document
    const first = r.stdout.trim().split('\n')[0];
    try { return { data: JSON.parse(first), ...r }; }
    catch (e) { return { data: null, ...r, parseError: String(e.message) }; }
  }
}
