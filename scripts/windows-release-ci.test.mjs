/** Keep release cache dependencies scoped to the platform and payload that consume them. */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { stableSharedSpecs, trackedDesktopSources } from './test-stable-shared.mjs'

const require = createRequire(new URL('../dsh-plugin-desktop-beta/package.json', import.meta.url))
const workflow = require('yaml').parse(readFileSync(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8'))
const { jobs } = workflow
const upstream = 'deepseek-harness/scripts/primary-runtime/lock.json'
const modelPath = workspace => `${workspace}/node_modules/@deepseek-ai/dsh-experimental-speech-to-text-sensevoice/runtime/assets.json`

// Evaluate the cache keys' small expression subset against changed input contents.
// hashFiles uses content hashes, just as Actions does; a missing path contributes nothing.
function cacheKey(template, matrix, files, os = 'Windows', runtime = 'runtime-inputs') {
  const hashFiles = (...paths) => {
    const contents = paths.filter(path => files.has(path)).map(path => files.get(path))
    return contents.length === 0 ? '' : createHash('sha256').update(contents.join('\0')).digest('hex')
  }
  const format = (pattern, ...args) => pattern.replace(/\{(\d+)\}/gu, (_, index) => args[Number(index)])
  const runner = { os, arch: matrix.arch ?? 'x64' }
  return template.replace(/\$\{\{([\s\S]*?)\}\}/gu, (_, expression) => {
    expression = expression.replaceAll('steps.packaging-inputs.outputs.versions', '"versions"')
      .replaceAll('steps.packaging-inputs.outputs.runtime', JSON.stringify(runtime))
    return Function('matrix', 'runner', 'hashFiles', 'format', `return (${expression})`)(matrix, runner, hashFiles, format)
  })
}

const packagingKey = job => job.steps.find(step => step.name === 'Restore primary runtime and Electron Builder downloads').with.key

test('merged builds save changed runtime inputs and reuse them on the next run for every platform', () => {
  assert.ok(workflow.on.push.branches.includes('master'))
  const files = new Map()
  const builds = ['x64', 'arm64'].flatMap(arch => ['dsh-plugin-desktop-beta', 'dsh-desktop-next']
    .map(workspace => ['desktop-windows', { arch, workspace }, 'Windows']))
  builds.push(['desktop-linux', {}, 'Linux'], ['desktop-macos', {}, 'macOS'])
  const identities = new Set()
  for (const [job, matrix, os] of builds) {
    const key = packagingKey(jobs[job])
    const oldKey = cacheKey(key, matrix, files, os, 'old inputs')
    const newKey = cacheKey(key, matrix, files, os, 'new inputs')
    identities.add(oldKey)
    assert.notEqual(oldKey, newKey, `${job} must refresh with the runtime inputs`)
    const restore = jobs[job].steps.find(step => step.name === 'Restore primary runtime and Electron Builder downloads').with['restore-keys']
    for (const prefix of restore.trim().split('\n')) {
      assert.ok(oldKey.startsWith(cacheKey(prefix, matrix, files, os)))
      assert.ok(newKey.startsWith(cacheKey(prefix, matrix, files, os)))
    }
    const steps = jobs[job].steps
    const inputs = steps.findIndex(step => step.id === 'packaging-inputs')
    assert.ok(inputs > steps.findIndex(step => step.run === 'yarn install --immutable'))
    assert.ok(inputs < steps.findIndex(step => step.id === 'packaging-cache'))
    assert.match(steps[inputs].run, /prepare-runtime\.ts["']? --cache-key/u)
    const save = steps.find(step => step.name === 'Save primary runtime and Electron Builder downloads')
    assert.equal(save.with.key, '${{ steps.packaging-cache.outputs.cache-primary-key }}')
    const shouldSave = (event, hit) => Function(`return ${save.if
      .replaceAll('github.event_name', JSON.stringify(event))
      .replaceAll('steps.packaging-cache.outputs.cache-hit', JSON.stringify(hit))}`)()
    assert.equal(shouldSave('push', 'false'), true, 'Prefix restores must save the rebuilt runtime under the new key')
    assert.equal(shouldSave('push', 'true'), false, 'The next exact hit must reuse the saved cache')
    assert.equal(shouldSave('pull_request', 'false'), false)
  }
  assert.equal(identities.size, builds.length, 'Different platforms, architectures and channels must not share prepared runtime caches')
})

test('real runtime and CI digests follow source, dependency and target-lock changes without a format bump', () => {
  const repository = fileURLToPath(new URL('../', import.meta.url))
  const root = mkdtempSync(join(tmpdir(), 'desktop-cache-inputs-'))
  const workspace = 'dsh-desktop-next'
  const sources = ['primary-runtime.ts', 'prepare-runtime.ts', 'prune-python-tests.ts'].map(name => `${workspace}/scripts/${name}`)
  const shared = ['scripts/windows-python-sitecustomize.py', 'yarn.lock']
  const supplement = 'scripts/primary-runtime-win-arm64.json'
  const probe = `
    import { createRequire } from 'node:module';
    import { readFileSync } from 'node:fs';
    import { nextRuntimeCacheKey } from './${workspace}/scripts/prepare-runtime.ts';
    import { primaryRuntimePayloadDigest, readPrimaryRuntimeLock } from './${workspace}/scripts/primary-runtime.ts';
    const require = createRequire(new URL('./${workspace}/package.json', import.meta.url));
    const pnpm = JSON.parse(readFileSync(require.resolve('pnpm'), 'utf8')).version;
    const targets = ['mac-arm64', 'mac-x64', 'win-x64', 'win-arm64', 'linux-x64', 'linux-arm64'];
    const payloads = targets.map(target => primaryRuntimePayloadDigest(target, readPrimaryRuntimeLock(undefined, target), pnpm));
    const keys = [['darwin', 'arm64'], ['win32', 'x64'], ['win32', 'arm64'], ['linux', 'x64'], ['linux', 'arm64']].map(([platform, arch]) => nextRuntimeCacheKey(platform, arch));
    console.log(JSON.stringify({ payloads, keys }));
  `
  const snapshot = (cwd = root) => JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', probe], { cwd, encoding: 'utf8' }))
  try {
    for (const path of [...sources, ...shared, upstream, supplement, `${workspace}/package.json`,
      `${workspace}/scripts/upstream-family.ts`, 'dsh-plugin-desktop/scripts/mac-universal.ts', 'dsh-plugin-desktop/scripts/windows-architecture.ts']) {
      mkdirSync(dirname(join(root, path)), { recursive: true })
      copyFileSync(join(repository, path), join(root, path))
    }
    symlinkSync(join(repository, workspace, 'node_modules'), join(root, workspace, 'node_modules'), 'junction')
    const before = snapshot()
    assert.deepEqual(snapshot(repository), before, 'Checkout location must not affect cache identities')
    const cli = execFileSync(process.execPath, [`${workspace}/scripts/prepare-runtime.ts`, '--cache-key'], { cwd: root, encoding: 'utf8' }).trim()
    assert.match(cli, /^[a-f0-9]{64}$/u)
    assert.ok(before.keys.includes(cli), 'The CI command must use the same runtime input identity')
    assert.equal(existsSync(join(root, workspace, '.desktop-build')), false, 'Cache-key mode must not prepare or modify a runtime')
    for (const path of [...sources, ...shared, upstream, supplement]) {
      const original = readFileSync(join(root, path), 'utf8')
      let changed = `${original}\n${path.endsWith('.ts') ? '//' : '#'} changed build input\n`
      if (path === upstream || path === supplement) {
        const lock = JSON.parse(original)
        if (path === supplement) lock.artifact.pythonSha256 = 'f'.repeat(64)
        else lock.wheels[0].sha256 = 'f'.repeat(64)
        changed = JSON.stringify(lock)
      }
      writeFileSync(join(root, path), changed)
      const after = snapshot()
      for (const field of ['payloads', 'keys']) {
        before[field].forEach((value, index) => {
          const affected = path !== supplement || index === (field === 'payloads' ? 3 : 2)
          assert.equal(after[field][index] !== value, affected, `${path}: ${field}[${index}] must follow the effective inputs`)
        })
      }
      assert.deepEqual(snapshot(), after, 'Unchanged inputs must reuse the new identity on the next build')
      writeFileSync(join(root, path), original)
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('speech caches follow the model manifest and share identical models across channels', () => {
  const key = jobs['desktop-windows'].steps.find(step => step.name === 'Restore hash-verified speech smoke models').with.key
  const beta = 'dsh-plugin-desktop-beta', next = 'dsh-desktop-next'
  const before = new Map([[modelPath(beta), 'model A'], [modelPath(next), 'model A']])
  const after = new Map(before).set(modelPath(beta), 'model B')
  assert.equal(cacheKey(key, { workspace: beta }, before), cacheKey(key, { workspace: next }, before))
  assert.notEqual(cacheKey(key, { workspace: beta }, before), cacheKey(key, { workspace: beta }, after))
  assert.equal(cacheKey(key, { workspace: next }, before), cacheKey(key, { workspace: next }, after))
})

test('the main shared suite covers architecture and updater regressions for every Windows job', () => {
  const specs = new Set(stableSharedSpecs(trackedDesktopSources()))
  for (const name of ['package-win', 'windows-architecture', 'update-checker', 'update-download']) {
    assert.ok(specs.has(`tests/${name}.spec.ts`), `${name} must remain in the shared gate`)
  }
})
