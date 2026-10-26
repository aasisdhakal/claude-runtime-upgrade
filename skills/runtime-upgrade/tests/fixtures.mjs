// Fixture builder. Trees are GENERATED into a temp dir rather than committed:
// the polyrepo case needs real .git directories, which git itself refuses to
// track, and generated fixtures cannot drift out of sync with the assertions.
import { mkdirSync, writeFileSync, rmSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const w = (root, path, body) => {
  const full = join(root, path);
  mkdirSync(full.slice(0, full.lastIndexOf('/')), { recursive: true });
  writeFileSync(full, typeof body === 'string' ? body : JSON.stringify(body, null, 2));
};

export const FIXTURES = {
  'single-node': r => {
    w(r, 'package.json', { name: 'solo', engines: { node: '>=20.11.0' }, dependencies: { axios: '^1.6.0' } });
    w(r, '.nvmrc', 'v20.11.1\n');
    w(r, 'Dockerfile', 'FROM node:20.11.1-alpine3.19 AS build\nRUN npm ci\n');
    w(r, 'package-lock.json', { lockfileVersion: 3 });
  },
  'single-php': r => {
    w(r, 'composer.json', { name: 'vendor/solo', require: { php: '^8.1', 'monolog/monolog': '^3.0' } });
    w(r, '.php-version', '8.1.27\n');
    w(r, 'composer.lock', { platform: { php: '^8.1' }, packages: [] });
  },
  'monorepo-node': r => {
    w(r, 'package.json', { name: 'mono-root', private: true, workspaces: ['packages/*'], engines: { node: '>=22' } });
    w(r, '.nvmrc', 'v22\n');
    w(r, 'pnpm-workspace.yaml', "packages:\n  - 'packages/*'\n");
    w(r, 'packages/alpha/package.json', { name: '@mono/alpha', dependencies: { react: '^18.0.0' } });
    w(r, 'packages/beta/package.json', { name: '@mono/beta', devDependencies: { typescript: '^5.0.0' } });
  },
  'polyrepo': r => {
    for (const n of ['svc-a', 'svc-b']) {
      mkdirSync(join(r, n, '.git'), { recursive: true });
      writeFileSync(join(r, n, '.git', 'HEAD'), 'ref: refs/heads/main\n');
    }
    w(r, 'svc-a/package.json', { name: 'svc-a', engines: { node: '>=18' } });
    w(r, 'svc-b/composer.json', { name: 'vendor/svc-b', require: { php: '^8.2' } });
  },
  'mixed-single': r => {
    w(r, 'package.json', { name: 'laravel-ish', dependencies: { vite: '^5.0.0' } });
    w(r, 'composer.json', { name: 'vendor/app', require: { php: '^8.2', 'laravel/framework': '^11.0' } });
    w(r, 'Dockerfile', 'FROM php:8.2-fpm-alpine\nFROM node:20-alpine AS assets\n');
  },
  'container-only': r => {
    w(r, 'Dockerfile', 'FROM public.ecr.aws/docker/library/node:22-alpine3.21 AS build\nFROM nginx:1.27-alpine\n');
    w(r, 'README.md', '# no manifest, runtime pinned only in the Dockerfile\n');
  },
  'no-manifest': r => {
    w(r, 'README.md', '# nothing to upgrade\n');
    w(r, 'main.go', 'package main\n');
  },
  'drift': r => {
    w(r, 'package.json', { name: 'drifty', engines: { node: '>=20' } });
    w(r, '.nvmrc', 'v18\n');
    w(r, 'Dockerfile', 'FROM node:22-alpine AS a\nFROM node:22-alpine AS b\n');
  },
  'single-go': r => {
    w(r, 'go.mod', 'module github.com/acme/svc\n\ngo 1.21\n\ntoolchain go1.21.5\n\nrequire (\n\tgithub.com/gin-gonic/gin v1.9.1\n\tgithub.com/spf13/cobra v1.8.0\n)\n');
    w(r, 'go.sum', '');
    w(r, 'Dockerfile', 'FROM golang:1.21-alpine AS build\n');
  },
  'single-python': r => {
    w(r, 'pyproject.toml', '[project]\nname = "acme-svc"\nrequires-python = ">=3.9"\ndependencies = ["django>=4.0", "requests>=2.0"]\n');
    w(r, '.python-version', '3.9.18\n');
    w(r, 'Dockerfile', 'FROM python:3.9-slim\n');
    w(r, 'poetry.lock', '');
  },
  'single-ruby': r => {
    w(r, 'Gemfile', "source 'https://rubygems.org'\nruby '3.0.6'\ngem 'rails', '~> 7.0'\ngem 'pg'\n");
    w(r, '.ruby-version', 'ruby-3.0.6\n');
    w(r, 'Gemfile.lock', 'PLATFORMS\n  x86_64-linux\n  ruby\n\nRUBY VERSION\n   ruby 3.0.6p216\n');
  },
  'single-rust': r => {
    w(r, 'Cargo.toml', '[package]\nname = "acme"\nedition = "2021"\nrust-version = "1.70"\n\n[dependencies]\ntokio = "1"\nserde = "1"\n');
    w(r, 'rust-toolchain.toml', '[toolchain]\nchannel = "1.70.0"\n');
    w(r, 'Cargo.lock', '');
  },
  'single-java': r => {
    w(r, 'pom.xml', '<project><artifactId>acme-svc</artifactId>\n<properties><maven.compiler.release>17</maven.compiler.release></properties>\n<dependencies><dependency><groupId>org.springframework</groupId></dependency></dependencies></project>\n');
    w(r, '.sdkmanrc', 'java=17.0.9-tem\n');
    w(r, 'Dockerfile', 'FROM eclipse-temurin:17-jre-alpine\n');
  },
  'single-dotnet': r => {
    w(r, 'Acme.Api.csproj', '<Project Sdk="Microsoft.NET.Sdk">\n<PropertyGroup><TargetFramework>net6.0</TargetFramework></PropertyGroup>\n<ItemGroup><PackageReference Include="Newtonsoft.Json" /></ItemGroup>\n</Project>\n');
    w(r, 'global.json', { sdk: { version: '6.0.418', rollForward: 'latestFeature' } });
    w(r, 'Dockerfile', 'FROM mcr.microsoft.com/dotnet/sdk:6.0 AS build\n');
  },
  // CI accuracy: a Node project whose workflow ALSO pins a python version
  'ci-cross-language': r => {
    w(r, 'package.json', { name: 'cross', engines: { node: '>=20' } });
    w(r, '.github/workflows/ci.yml',
      'jobs:\n  build:\n    steps:\n      - uses: actions/setup-node@v4\n        with:\n          node-version: 20.11.1\n      - uses: actions/setup-python@v5\n        with:\n          python-version: 3.8.10\n');
  },
  // a CI test matrix is deliberate breadth, not disagreement
  'ci-matrix': r => {
    w(r, 'pyproject.toml', '[project]\nname = "matrixed"\nrequires-python = ">=3.9"\n');
    w(r, '.github/workflows/test.yml',
      'jobs:\n  test:\n    strategy:\n      matrix:\n        python: ["3.9", "3.11", "3.12"]\n    steps:\n      - uses: actions/setup-python@v5\n        with:\n          python-version: "3.9"\n      - uses: actions/setup-python@v5\n        with:\n          python-version: "3.11"\n      - uses: actions/setup-python@v5\n        with:\n          python-version: "3.12"\n');
  },
  // templated CI values must be ignored, not parsed as versions
  'ci-templated': r => {
    w(r, 'package.json', { name: 'templated', engines: { node: '>=22' } });
    w(r, '.github/workflows/ci.yml',
      'jobs:\n  b:\n    steps:\n      - uses: actions/setup-node@v4\n        with:\n          node-version: ${{ matrix.node }}\n');
  },
  'frameworks': r => {
    w(r, 'package.json', { name: 'fw-node', engines: { node: '>=20' },
      dependencies: { next: '^14.0.0', react: '^18.2.0', '@nestjs/core': '^10.0.0' } });
    w(r, 'composer.json', { name: 'acme/fw-php', require: { php: '^8.1', 'laravel/framework': '^10.0' } });
  },
  'polyglot': r => {
    // one repo, four runtimes — the shape nobody plans for
    w(r, 'api/go.mod', 'module acme/api\n\ngo 1.22\n');
    w(r, 'web/package.json', { name: 'web', engines: { node: '>=20' } });
    w(r, 'ml/pyproject.toml', '[project]\nname = "ml"\nrequires-python = ">=3.11"\n');
    w(r, 'legacy/composer.json', { name: 'acme/legacy', require: { php: '^8.1' } });
  },
  // node_modules shaped to exercise the ABI-vs-N-API classifier, which is the
  // most expensive thing this skill can get wrong.
  'abi-classify': r => {
    w(r, 'package.json', { name: 'native-host', dependencies: {} });
    w(r, 'package-lock.json', { lockfileVersion: 3 });
    // ABI-pinned: ships NODE_MODULE_VERSION-numbered binaries, no napi declaration
    w(r, 'node_modules/abi-pkg/package.json', { name: 'abi-pkg', version: '7.1.0' });
    w(r, 'node_modules/abi-pkg/lib/thing-linux-x64-glibc-115.node', 'x');
    w(r, 'node_modules/abi-pkg/lib/thing-linux-x64-glibc-108.node', 'x');
    // N-API: declares napi_versions AND has a napi-v3 dir -> ABI-stable, NOT a blocker
    w(r, 'node_modules/napi-pkg/package.json', { name: 'napi-pkg', version: '5.1.1', binary: { napi_versions: [3] } });
    w(r, 'node_modules/napi-pkg/lib/binding/napi-v3/thing.node', 'x');
    // source build: binding.gyp, no prebuilt artifact
    w(r, 'node_modules/src-pkg/package.json', { name: 'src-pkg', version: '0.0.10' });
    w(r, 'node_modules/src-pkg/binding.gyp', '{}');
    // trap: declares napi BUT also ships ABI-numbered files -> ABI evidence must win
    w(r, 'node_modules/trap-pkg/package.json', { name: 'trap-pkg', version: '2.0.0', binary: { napi_versions: [3] } });
    w(r, 'node_modules/trap-pkg/lib/x-darwin-arm64-137.node', 'x');
  },
};

export function build(name) {
  const root = mkdtempSync(join(tmpdir(), `ru-fx-${name}-`));
  FIXTURES[name](root);
  return root;
}
export function destroy(root) { try { rmSync(root, { recursive: true, force: true }); } catch {} }
