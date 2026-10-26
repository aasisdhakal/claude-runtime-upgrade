import { join, existsSync, readText, readdirSync, rel } from '../lib/io.mjs';

export const id = 'ruby';
export const label = 'Ruby';
export const manifests = ['Gemfile', 'Gemfile.lock'];
export const eolProduct = 'ruby';
export const osvEcosystem = 'RubyGems';
export const gateCapable = false;
export const gateNote =
  'No curated, version-ranged CVE database exists for the Ruby interpreter (OSV returns 0 ' +
  'for it). Gate on EOL/support status and `bundler-audit` findings; treat runtime CVEs as ' +
  'advisory and triage against ruby-lang.org security announcements.';
export const cveSource = { url: null, note: 'none — ruby-lang.org security announcements, manual triage' };
export const ciKey = /\bruby[-_]?version/i;
export const imageRe = /\b(ruby|jruby)[:@]([^\s"']+)/gi;

export function scan({ dir, root, dockerImages, ciText }) {
  const gemfile = readText(join(dir, 'Gemfile')) || '';
  const lock = readText(join(dir, 'Gemfile.lock')) || '';
  let gemspec = '';
  try { for (const f of readdirSync(dir)) if (f.endsWith('.gemspec')) { gemspec = readText(join(dir, f)) || ''; break; } } catch {}
  const declared = {
    gemfileRuby:   (gemfile.match(/^\s*ruby\s+["']([^"']+)/m) || [])[1] || '',
    rubyVersion:   (readText(join(dir, '.ruby-version')) || '').trim().replace(/^ruby-/, ''),
    gemspecRuby:   (gemspec.match(/required_ruby_version\s*=\s*["']([^"']+)/) || [])[1] || '',
    lockRuby:      (lock.match(/^RUBY VERSION\s*\n\s*ruby\s+(\S+)/m) || [])[1] || '',
    toolVersions:  (readText(join(dir, '.tool-versions')) || '').match(/^ruby\s+(\S+)/mi)?.[1] || '',
    dockerfile:    dockerImages.filter(s => /^(ruby|jruby)[:@]/i.test(s)).join(' | '),
    ci:            ciText,
  };
  const majors = [...new Set(Object.values(declared)
    .map(v => (String(v).match(/(\d+\.\d+)/) || [])[1]).filter(Boolean))];
  return {
    lang: id, name: dir.split('/').pop(), dir: rel(root, dir), manifest: rel(root, join(dir, 'Gemfile')),
    declared, lockfile: existsSync(join(dir, 'Gemfile.lock')) ? 'Gemfile.lock' : '',
    declaredMajors: majors.join(','), drift: majors.length > 1,
    deps: (gemfile.match(/^\s*gem\s+["']/gm) || []).length, devDeps: 0,
    // C extensions relink against the interpreter ABI; a new MINOR needs a rebuild.
    abiNote: 'native gems (C extensions) must be rebuilt for a new Ruby MINOR; check Gemfile.lock PLATFORMS',
    lockPlatforms: (lock.match(/^PLATFORMS\s*\n((?:\s{2}\S+\n)+)/m) || [])[1]?.trim().split(/\s+/).join(',') || '',
  };
}
