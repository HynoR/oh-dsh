import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

test('Web Docker image stages this checkout instead of a GitHub release', () => {
  const dockerfile = readFileSync(join(root, 'docker', 'Dockerfile'), 'utf8')
  const compose = readFileSync(join(root, 'docker', 'compose.yaml'), 'utf8')
  const dockerignore = readFileSync(join(root, '.dockerignore'), 'utf8')

  assert.match(dockerfile, /FROM --platform=linux\/amd64 node:24-bookworm AS builder/)
  assert.match(dockerfile, /pnpm run stage:dsh -- --surface web/)
  assert.match(dockerfile, /cp -a \.stage\/dsh-runtime/)
  assert.doesNotMatch(dockerfile, /install\.sh --surface web/)
  assert.doesNotMatch(dockerfile, /OH_DSH_VERSION/)
  assert.doesNotMatch(dockerfile, /cannot run natively on macOS/)

  assert.match(compose, /platform: linux\/amd64/)
  assert.match(compose, /dockerfile: docker\/Dockerfile/)
  assert.doesNotMatch(compose, /OH_DSH_VERSION/)
  assert.doesNotMatch(compose, /GH_TOKEN/)

  assert.doesNotMatch(dockerignore, /^\*$/m)
  assert.match(dockerignore, /^\.stage$/m)
  assert.match(dockerignore, /^node_modules$/m)
})
