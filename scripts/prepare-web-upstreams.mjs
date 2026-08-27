import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
} from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

// Fill Web-stage upstream inputs when git submodules are empty (Docker
// context). Skip any tree that already has its ready file so a checkout
// with submodules initialized does not re-download. Pins match
// nix/oh-dsh.nix (npm releases for context/auth/TUI presets; GitHub source
// for Better Sidebar, which Oh-DSH compiles).

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const cache = join(root, '.cache', 'web-upstreams')

const CONTEXT_RELEASE = {
  url: 'https://registry.npmjs.org/dsh-context/-/dsh-context-0.31.1.tgz',
  sha512: 'AJMWAtYWMWj7ondprNWbLutXX9VpONEP2Vk6t1Gh5ZdzuHTc1u0pGGI2qRRKdjZBjVy3x9TgF5jgW2Mx1T89pg==',
}
const AUTH_RELEASE = {
  url: 'https://registry.npmjs.org/@deepseek-harness-tui/dsh-auth/-/dsh-auth-0.1.0.tgz',
  sha512: 'vggwtl0+fuZ9Xuwq9NC5MznT3ZpBfnqGTBgPUfEaqoTPXrxI0S+jcNcO3ou9Akn23cUAZikgmS7zHMVr+ZlXbw==',
}
const TUI_RELEASE = {
  url: 'https://registry.npmjs.org/@deepseek-harness-tui/dsh-tui/-/dsh-tui-0.9.2.tgz',
  sha512: 'LsjNnQ790sAGNllrNt3L8B1rdePcwRvwqSlQJ97uTh5skPaUkV9W41oqEYw1g19DZ6CEQ/8T3kKsI9pmQ8AynQ==',
}
const BETTER_SIDEBAR = {
  url: 'https://github.com/omdsh-dev/DSH-better-sidebar/archive/d9b8f15d9eab018742f97d67e54b2398504894cd.tar.gz',
  rev: 'd9b8f15d9eab018742f97d67e54b2398504894cd',
}

function run(command, args) {
  const result = spawnSync(command, args, { stdio: 'inherit' })
  if (result.error !== undefined) throw result.error
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed with status ${String(result.status)}`)
  }
}

function download(url, target) {
  mkdirSync(dirname(target), { recursive: true })
  const temporary = `${target}.download-${String(process.pid)}`
  rmSync(temporary, { force: true })
  run('curl', [
    '--fail',
    '--location',
    '--silent',
    '--show-error',
    '--user-agent',
    'oh-dsh-prepare-web-upstreams',
    url,
    '--output',
    temporary,
  ])
  rmSync(target, { force: true })
  renameSync(temporary, target)
}

function verifySha512(archive, expected) {
  const actual = createHash('sha512').update(readFileSync(archive)).digest('base64')
  if (actual !== expected) {
    throw new Error(`checksum mismatch for ${archive}: expected ${expected}, received ${actual}`)
  }
}

function extractNpm(archive, dest) {
  const extraction = `${dest}.extract-${String(process.pid)}`
  rmSync(extraction, { recursive: true, force: true })
  mkdirSync(extraction, { recursive: true })
  run('tar', ['-xzf', archive, '-C', extraction, '--strip-components=1'])
  rmSync(dest, { recursive: true, force: true })
  mkdirSync(dirname(dest), { recursive: true })
  renameSync(extraction, dest)
}

function cachedArchive(name) {
  return join(cache, name)
}

function ensureNpmTree(spec, archiveName, dest, readyRelative) {
  const ready = join(dest, readyRelative)
  if (existsSync(ready)) return
  const archive = cachedArchive(archiveName)
  if (!existsSync(archive)) download(spec.url, archive)
  verifySha512(archive, spec.sha512)
  extractNpm(archive, dest)
  if (!existsSync(ready)) {
    throw new Error(`unpacked ${spec.url} without ${readyRelative}`)
  }
  console.log(`Prepared ${readyRelative} from ${spec.url}`)
}

function ensureLiangshenPreset() {
  const dest = join(root, 'upstream', 'dsh-TUI', 'presets', 'liangshen')
  if (existsSync(dest)) return
  const archive = cachedArchive('dsh-tui-0.9.2.tgz')
  if (!existsSync(archive)) download(TUI_RELEASE.url, archive)
  verifySha512(archive, TUI_RELEASE.sha512)
  const extraction = join(cache, `dsh-tui-extract-${String(process.pid)}`)
  rmSync(extraction, { recursive: true, force: true })
  mkdirSync(extraction, { recursive: true })
  run('tar', ['-xzf', archive, '-C', extraction, '--strip-components=1'])
  const source = join(extraction, 'presets', 'liangshen')
  if (!existsSync(source)) {
    throw new Error(`unpacked ${TUI_RELEASE.url} without presets/liangshen`)
  }
  mkdirSync(dirname(dest), { recursive: true })
  rmSync(dest, { recursive: true, force: true })
  cpSync(source, dest, { recursive: true })
  rmSync(extraction, { recursive: true, force: true })
  console.log(`Prepared presets/liangshen from ${TUI_RELEASE.url}`)
}

function ensureBetterSidebar() {
  const dest = join(root, 'upstream', 'DSH-better-sidebar')
  const ready = join(dest, 'src', 'index.ts')
  if (existsSync(ready)) return
  const archive = cachedArchive(`DSH-better-sidebar-${BETTER_SIDEBAR.rev}.tar.gz`)
  if (!existsSync(archive)) download(BETTER_SIDEBAR.url, archive)
  extractNpm(archive, dest)
  if (!existsSync(ready)) {
    throw new Error(`unpacked ${BETTER_SIDEBAR.url} without src/index.ts`)
  }
  console.log(`Prepared DSH-better-sidebar at ${BETTER_SIDEBAR.rev}`)
}

mkdirSync(cache, { recursive: true })
ensureNpmTree(
  CONTEXT_RELEASE,
  'dsh-context-0.31.1.tgz',
  join(root, 'upstream', 'dsh-context'),
  'lib/index.js',
)
ensureNpmTree(
  AUTH_RELEASE,
  'dsh-auth-0.1.0.tgz',
  join(root, 'upstream', 'dsh-TUI', 'dsh-auth'),
  'lib/index.js',
)
ensureLiangshenPreset()
ensureBetterSidebar()
