import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

// Builds the pinned dsh-context submodule with its own toolchain. Every
// staging path (make upstream, pnpm run build, the dist:* chains) funnels
// through here, so a fresh checkout produces upstream/dsh-context/lib before
// installDesktopPackages() tries to copy it. The stamp keeps incremental
// builds no-ops until the pinned gitlink moves.
const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const contextDir = join(root, 'upstream', 'dsh-context')
const libEntry = join(contextDir, 'lib', 'index.js')
// Keep the stamp out of .stage: staging wipes that tree on every run, which
// would reinstall and rebuild the submodule each launch and dist cycle.
const stamp = join(root, '.cache', 'dsh-context-compile.stamp')

function currentRevision() {
  const result = spawnSync('git', ['-C', contextDir, 'rev-parse', 'HEAD'], { encoding: 'utf8' })
  // A release layout (the Nix assembly substitutes the npm tarball) has no
  // .git; the caller treats null as "prebuilt, nothing to build".
  if (result.status !== 0) return null
  return result.stdout.trim()
}

// pnpm >= 11.20 re-verify their own engine identity whenever the running
// binary differs from the project's packageManager pin, and the scoped
// @pnpm/exe packages never published releases for the upstream's pnpm 11.9
// line — so an ambient newer pnpm aborts before installing anything. Run the
// install and the build through the pinned version itself via dlx; it sees
// a matching pin and never delegates.
function pinnedPnpmVersion() {
  const manifest = JSON.parse(readFileSync(join(contextDir, 'package.json'), 'utf8'))
  const match = /^pnpm@(\S+)$/.exec(manifest.packageManager ?? '')
  return match?.[1] ?? null
}

function run(command, args) {
  const result = spawnSync(command, args, {
    cwd: contextDir,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  })
  if (result.error !== undefined || result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed in upstream/dsh-context`)
  }
}

function runPnpm(args) {
  const version = pinnedPnpmVersion()
  run('pnpm', version === null ? args : ['dlx', `pnpm@${version}`, ...args])
}

function buildContext(label) {
  // --ignore-workspace keeps this an isolated install of the submodule's own
  // pinned lockfile; without it pnpm may resolve the parent workspace
  // instead and skip the submodule's toolchain entirely.
  runPnpm(['install', '--frozen-lockfile', '--ignore-scripts', '--ignore-workspace'])
  runPnpm(['run', 'build'])
  mkdirSync(dirname(stamp), { recursive: true })
  writeFileSync(stamp, `${label}\n`)
  console.log(`Built upstream/dsh-context at ${label}`)
}

const revision = currentRevision()
let stamped
try {
  stamped = readFileSync(stamp, 'utf8').trim()
} catch {
  stamped = undefined
}
// Never process.exit() here: scripts/build.mjs imports this module, and an
// early exit would kill the whole root build and leave dist/ stale.
if (revision === null) {
  // Release layout: the sandboxed Nix build cannot run pnpm at all, so the
  // assembly substitutes the prebuilt npm release.
  if (!existsSync(libEntry)) {
    if (!existsSync(join(contextDir, 'package.json'))) {
      throw new Error('upstream/dsh-context has no git checkout and no prebuilt lib/index.js')
    }
    // Submodule working tree without .git (Docker .dockerignore excludes it).
    buildContext('source-without-git')
  }
} else if (stamped !== revision || !existsSync(libEntry)) {
  buildContext(revision)
}
