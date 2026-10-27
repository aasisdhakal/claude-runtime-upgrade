// Framework EOL. The runtime is often NOT the real blocker — on one real repo the
// Node bump was the smaller half and the framework major was the actual work.
// endoflife.date tracks 41 of the frameworks people actually run, so checking
// them costs one extra request against a feed we already use.
//
// Deliberately NOT tracked upstream (say so rather than guess): nestjs, fastapi,
// flask, quarkus, ember, tailwindcss, flutter, kafka, maven, npm.
import { fetchJson } from './io.mjs';
import { compare } from './semver.mjs';

/** dependency name (per ecosystem) -> endoflife.date product */
export const FRAMEWORK_MAP = {
  node: {
    'next': 'nextjs', 'nuxt': 'nuxt', '@angular/core': 'angular', 'react': 'react',
    'vue': 'vue', 'svelte': 'svelte', 'express': 'express', 'electron': 'electron',
    'react-native': 'react-native', 'bootstrap': 'bootstrap', 'jquery': 'jquery',
  },
  php: {
    'laravel/framework': 'laravel', 'symfony/symfony': 'symfony',
    'symfony/framework-bundle': 'symfony', 'drupal/core': 'drupal',
    'drupal/core-recommended': 'drupal', 'typo3/cms-core': 'typo3',
    'magento/product-community-edition': 'magento', 'joomla/cms': 'joomla',
  },
  python: { 'django': 'django', 'Django': 'django' },
  ruby: { 'rails': 'rails' },
  java: { 'spring-boot': 'spring-boot', 'spring-boot-starter-parent': 'spring-boot',
          'spring-core': 'spring-framework', 'micronaut': 'micronaut' },
  dotnet: {},
  go: {}, rust: {},
};

/** Frameworks we are asked about often but endoflife.date does not track. */
export const UNTRACKED = {
  '@nestjs/core': 'NestJS', 'fastapi': 'FastAPI', 'flask': 'Flask',
  'io.quarkus': 'Quarkus', 'ember-source': 'Ember', 'tailwindcss': 'Tailwind CSS',
};

/** Pull framework names+versions out of an already-scanned target's manifest deps. */
export function detectFrameworks(lang, deps = {}) {
  const map = FRAMEWORK_MAP[lang] || {};
  const found = [], untracked = [];
  for (const [name, range] of Object.entries(deps)) {
    if (map[name]) found.push({ dep: name, product: map[name], declared: String(range) });
    else if (UNTRACKED[name]) untracked.push({ dep: name, label: UNTRACKED[name] });
  }
  return { found, untracked };
}

/** Resolve EOL status for each detected framework. */
export async function frameworkEol(found, today = new Date().toISOString().slice(0, 10)) {
  const out = [];
  for (const f of found) {
    const r = await fetchJson(`https://endoflife.date/api/${f.product}.json`);
    if (!r.data) { out.push({ ...f, error: r.error || 'unavailable' }); continue; }
    const major = (String(f.declared).match(/(\d+(?:\.\d+)?)/) || [])[1] || '';
    const cycle = r.data.find(c => String(c.cycle) === major)
               || r.data.find(c => major.startsWith(String(c.cycle)));
    const newest = r.data
      .filter(c => c.eol === false || (typeof c.eol === 'string' && c.eol > today))
      .sort((a, b) => compare(String(a.cycle), String(b.cycle))).pop();
    out.push({
      ...f,
      cycle: cycle ? String(cycle.cycle) : null,
      latestInLine: cycle?.latest ?? null,
      eol: typeof cycle?.eol === 'string' ? cycle.eol : null,
      isEol: !!(typeof cycle?.eol === 'string' && cycle.eol < today),
      supportEnds: typeof cycle?.support === 'string' ? cycle.support : null,
      newestSupported: newest ? { cycle: String(newest.cycle), latest: newest.latest, eol: newest.eol } : null,
    });
  }
  return out;
}
