import { join, existsSync, readText, readdirSync, rel } from '../lib/io.mjs';
import { classifyDeclared } from '../lib/semver.mjs';

export const id = 'java';
export const label = 'Java';
export const manifests = ['pom.xml', 'build.gradle', 'build.gradle.kts'];
/**
 * endoflife.date has NO "java" product — the JDK is tracked per distribution.
 * Default to Amazon Corretto; override with RU_JAVA_DISTRO.
 */
export const eolProduct = process.env.RU_JAVA_DISTRO || 'amazon-corretto';
export const eolAliases = ['amazon-corretto', 'oracle-jdk', 'openjdk-builds-from-oracle',
  'graalvm-ce', 'microsoft-build-of-openjdk', 'redhat-build-of-openjdk'];
export const osvEcosystem = 'Maven';
export const gateCapable = false;
export const gateNote =
  'The JDK has no single curated CVE feed — each distribution (Corretto, Temurin, Oracle, ' +
  'Red Hat) ships its own advisories, and endoflife.date tracks them separately. Gate on ' +
  'EOL/support status for YOUR distribution plus OWASP dependency-check; treat runtime CVEs ' +
  'as advisory. Set RU_JAVA_DISTRO to match the JDK you actually ship.';
export const cveSource = { url: null, note: 'none unified — per-distribution advisories (Corretto/Temurin/Oracle CPU)' };
export const ciKey = /\b(?:java|jdk)[-_]?version/i;
export const imageRe = /\b(eclipse-temurin|amazoncorretto|openjdk|ibm-semeru|graalvm|sapmachine)[:@]([^\s"']+)/gi;

export function scan({ dir, root, dockerImages, ciText }) {
  const pom = readText(join(dir, 'pom.xml')) || '';
  let gradle = readText(join(dir, 'build.gradle')) || readText(join(dir, 'build.gradle.kts')) || '';
  const declared = {
    mavenRelease:  (pom.match(/<maven\.compiler\.release>\s*(\d+)/) || [])[1] || '',
    mavenSource:   (pom.match(/<maven\.compiler\.source>\s*(\d+)/) || [])[1] || '',
    javaVersionProp: (pom.match(/<java\.version>\s*([\d.]+)/) || [])[1] || '',
    gradleToolchain: (gradle.match(/languageVersion\s*(?:=|\.set\()\s*JavaLanguageVersion\.of\((\d+)/) || [])[1] || '',
    gradleCompat:  (gradle.match(/(?:sourceCompatibility|targetCompatibility)\s*=?\s*["']?(?:JavaVersion\.VERSION_)?([\d._]+)/) || [])[1]?.replace(/_/g, '.') || '',
    sdkmanrc:      (readText(join(dir, '.sdkmanrc')) || '').match(/^java=(\S+)/mi)?.[1] || '',
    javaVersionFile: (readText(join(dir, '.java-version')) || '').trim(),
    toolVersions:  (readText(join(dir, '.tool-versions')) || '').match(/^java\s+(\S+)/mi)?.[1] || '',
    dockerfile:    dockerImages.filter(s => /^(eclipse-temurin|amazoncorretto|openjdk|ibm-semeru|graalvm|sapmachine)/i.test(s)).join(' | '),
    ci:            ciText,
  };
  // Java majors are bare integers (17, 21, 25) — "1.8" style means 8.
  const norm = v => { const s = String(v); const m = s.match(/^1\.(\d+)/) || s.match(/(\d+)/); return m ? m[1] : ''; };
  const { pins, floors } = classifyDeclared(declared);
  const pinMajors = [...new Set(Object.values(pins).map(norm).filter(Boolean))];
  const floorMajors = [...new Set(Object.values(floors).map(norm).filter(Boolean))];
  const majors = [...new Set([...pinMajors, ...floorMajors])];
  const build = existsSync(join(dir, 'pom.xml')) ? 'maven' : 'gradle';
  const name = (pom.match(/<artifactId>\s*([^<\s]+)/) || [])[1] || dir.split('/').pop();
  return {
    lang: id, name, dir: rel(root, dir),
    manifest: rel(root, join(dir, build === 'maven' ? 'pom.xml' : 'build.gradle')),
    declared, build,
    lockfile: existsSync(join(dir, 'gradle.lockfile')) ? 'gradle.lockfile' : '',
    declaredMajors: majors.join(','),
    pinnedMajors: pinMajors.join(','), floorMajors: floorMajors.join(','),
    drift: pinMajors.length > 1,
    deps: build === 'maven' ? (pom.match(/<dependency>/g) || []).length
                            : (gradle.match(/^\s*(implementation|api|compileOnly|runtimeOnly)\s/gm) || []).length,
    devDeps: (pom.match(/<scope>\s*test\s*<\/scope>/g) || []).length,
    abiNote: 'bytecode major version is the compatibility axis, not a binary ABI. `--release N` pins it; a newer JDK can still emit older bytecode.',
    eolProduct,
  };
}
