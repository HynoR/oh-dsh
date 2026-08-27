import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

test('Web Docker image packages this checkout through the dist:web scripts', () => {
  const dockerfile = readFileSync(join(root, 'docker', 'Dockerfile'), 'utf8')
  const compose = readFileSync(join(root, 'docker', 'compose.yaml'), 'utf8')
  const dockerignore = readFileSync(join(root, '.dockerignore'), 'utf8')
  const prepare = readFileSync(join(root, 'scripts', 'prepare-web-upstreams.mjs'), 'utf8')
  const buildWeb = readFileSync(join(root, 'scripts', 'build-web.mjs'), 'utf8')
  const ensureContext = readFileSync(join(root, 'scripts', 'ensure-upstream-context.mjs'), 'utf8')
  const nix = readFileSync(join(root, 'nix', 'oh-dsh.nix'), 'utf8')
  const gitlink = spawnSync(
    'git',
    ['rev-parse', 'HEAD:upstream/DSH-better-sidebar'],
    { cwd: root, encoding: 'utf8' },
  )
  assert.equal(gitlink.status, 0, gitlink.stderr)
  const betterSidebarRev = gitlink.stdout.trim()

  assert.match(dockerfile, /FROM node:24-bookworm AS builder/)
  assert.match(dockerfile, /node scripts\/prepare-web-upstreams\.mjs/)
  assert.match(dockerfile, /pnpm run stage:dsh -- --surface web/)
  assert.match(dockerfile, /OH_DSH_WEB_PACKAGE_DIR=\/opt\/oh-dsh node scripts\/build-web\.mjs/)
  assert.doesNotMatch(dockerfile, /git submodule update/)
  assert.doesNotMatch(dockerfile, /FROM --platform/)
  assert.doesNotMatch(dockerfile, /install\.sh --surface web/)
  assert.doesNotMatch(dockerfile, /OH_DSH_VERSION/)
  assert.doesNotMatch(dockerfile, /cannot run natively on macOS/)

  assert.match(buildWeb, /OH_DSH_WEB_PACKAGE_DIR/)
  assert.match(buildWeb, /writeReleaseArchives/)

  assert.match(compose, /dockerfile: docker\/Dockerfile/)
  assert.doesNotMatch(compose, /OH_DSH_VERSION/)
  assert.doesNotMatch(compose, /GH_TOKEN/)
  assert.doesNotMatch(compose, /^\s+platform:/m)
  assert.doesNotMatch(compose, /linux\/amd64/)
  assert.doesNotMatch(dockerfile, /linux\/amd64/)

  assert.match(dockerignore, /^\.git$/m)
  assert.match(dockerignore, /^\.stage$/m)
  assert.match(dockerignore, /^node_modules$/m)
  assert.doesNotMatch(dockerignore, /Keep \.git/)

  assert.doesNotMatch(ensureContext, /source-without-git/)

  assert.match(prepare, /dsh-context-0\.31\.1\.tgz/)
  assert.match(prepare, /dsh-auth-0\.1\.0\.tgz/)
  assert.match(prepare, /dsh-tui-0\.9\.2\.tgz/)
  assert.match(prepare, new RegExp(betterSidebarRev))
  assert.match(nix, /dsh-context-0\.31\.1\.tgz/)
  assert.match(nix, /dsh-auth-0\.1\.0\.tgz/)
  assert.match(nix, /dsh-tui-0\.9\.2\.tgz/)
  assert.match(nix, new RegExp(betterSidebarRev))
})
