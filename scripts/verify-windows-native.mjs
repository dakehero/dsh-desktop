/** Exercise the native Electron ABI and ConPTY. DSH_SPEECH_SMOKE=1 also runs SenseVoice and VAD inference. */
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const worker = process.argv[2] === '--worker'
const args = process.argv.slice(worker ? 3 : 2)
const workspace = resolve(args[0] ?? 'dsh-plugin-desktop-beta')
const app = args[1] === undefined ? undefined : resolve(args[1])
const manifest = JSON.parse(readFileSync(join(workspace, 'package.json'), 'utf8'))
const payload = app === undefined ? workspace : join(app, 'resources', 'app.asar')
// Node prepares assets from the workspace; only the Electron worker can resolve app.asar.
const requirePayload = createRequire(join(worker ? payload : workspace, 'package.json'))
const voiceEntry = requirePayload.resolve('@deepseek-ai/dsh-experimental-speech-to-text-sensevoice')
const assertPackaged = path => {
  if (app === undefined) return
  const pathInside = relative(app, path)
  assert.ok(!pathInside.startsWith('..') && !isAbsolute(pathInside), `Packaged smoke resolved a development dependency: ${path}`)
}
if (worker) assertPackaged(voiceEntry)
const voice = createRequire(voiceEntry)
const speechSmoke = process.env.DSH_SPEECH_SMOKE === '1'
const assets = speechSmoke ? JSON.parse(readFileSync(join(dirname(dirname(voiceEntry)), 'runtime', 'assets.json'), 'utf8')) : undefined
const cache = process.env.DSH_NATIVE_SMOKE_CACHE ?? join(tmpdir(), 'dsh-windows-native-smoke')

if (!worker) {
  assert.equal(process.platform, 'win32')
  assert.equal(process.arch, process.env.DSH_EXPECTED_ARCH ?? process.arch)
  if (app !== undefined) {
    const { smokeNextRuntime } = await import(pathToFileURL(join(workspace, 'scripts', 'prepare-runtime.ts')).href)
    assert.deepEqual(smokeNextRuntime(join(app, 'resources', 'runtime'), 'win32'), [process.arch])
    if (process.arch === 'arm64') {
      // Exercise real native DLL imports beyond MAX_PATH even on a short CI checkout path.
      const temporary = mkdtempSync(join(tmpdir(), 'dsh-runtime-longpath-'))
      const pythonTail = join(process.arch, 'primary-runtime', 'dependencies', 'python', 'python.exe')
      const padding = 240 - pythonTail.length - temporary.length - 2
      assert.ok(padding > 0 && padding < 255)
      const alias = join(temporary, 'r'.repeat(padding))
      const inside = relative(temporary, alias)
      assert.ok(inside && !inside.startsWith('..') && !isAbsolute(inside))
      try {
        symlinkSync(resolve(app, 'resources', 'runtime'), alias, 'junction')
        execFileSync(join(alias, pythonTail), ['-I', '-B', '-c',
          'import numpy, pandas, lxml._elementpath as native; from PIL import _imaging; assert len(native.__file__) > 260, native.__file__; print("Windows native DLL import beyond MAX_PATH passed")'], { stdio: 'inherit', timeout: 30_000 })
      } finally {
        const link = lstatSync(alias, { throwIfNoEntry: false })
        if (link !== undefined) { assert.ok(link.isSymbolicLink()); unlinkSync(alias) }
        rmSync(temporary, { recursive: true, force: true })
      }
    }
  }
  if (speechSmoke) {
    mkdirSync(cache, { recursive: true })
    for (const asset of [assets.models.int8, assets.tokens, assets.vad]) {
      const path = join(cache, asset.sha256)
      const valid = () => existsSync(path) && createHash('sha256').update(readFileSync(path)).digest('hex') === asset.sha256
      if (!valid()) {
        console.log(`Downloading the pinned ${asset.name} speech smoke asset`)
        const response = await fetch(asset.url, { signal: AbortSignal.timeout(600_000) })
        assert.ok(response.ok, `SenseVoice model download failed: ${response.status}`)
        const bytes = Buffer.from(await response.arrayBuffer())
        assert.equal(bytes.length, asset.bytes)
        assert.equal(createHash('sha256').update(bytes).digest('hex'), asset.sha256)
        writeFileSync(path, bytes)
      }
    }
  }
  const electron = app === undefined ? createRequire(join(workspace, 'package.json'))('electron') : join(app, `${manifest.build.productName}.exe`)
  const result = spawnSync(electron, [fileURLToPath(import.meta.url), '--worker', workspace, ...(app === undefined ? [] : [app])], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', DSH_EXPECTED_ARCH: process.env.DSH_EXPECTED_ARCH ?? process.arch },
    stdio: 'inherit', timeout: 180_000, windowsHide: true,
  })
  if (result.error) throw result.error
  assert.equal(result.status, 0, 'Native Windows Electron smoke failed')
} else {
  assert.equal(process.platform, 'win32')
  assert.equal(process.arch, process.env.DSH_EXPECTED_ARCH)
  assert.ok(process.versions.electron, 'Native modules must be tested in Electron')
  const koffi = requirePayload('koffi')
  assert.equal(koffi.load('kernel32.dll').func('uint32_t GetCurrentProcessId()')(), process.pid)
  const pty = requirePayload('node-pty')
  await new Promise((resolveSmoke, reject) => {
    let output = '', exited = false
    const terminal = pty.spawn(process.env.ComSpec ?? 'C:\\Windows\\System32\\cmd.exe', ['/d', '/s', '/c', 'echo DSH_NATIVE_PTY_OK'], { cols: 80, rows: 24 })
    const timer = setTimeout(() => { terminal.kill(); reject(new Error(`ConPTY smoke timed out: ${output}`)) }, 20_000)
    const finish = () => {
      if (exited && output.includes('DSH_NATIVE_PTY_OK')) { clearTimeout(timer); resolveSmoke() }
    }
    terminal.onData(data => { output += data; finish() })
    terminal.onExit(({ exitCode }) => { if (exitCode !== 0) { clearTimeout(timer); reject(new Error(`ConPTY exited ${exitCode}`)) } else { exited = true; finish() } })
  })
  if (process.arch === 'arm64') assert.ok(readFileSync(voiceEntry, 'utf8').includes('"win32-arm64"'), 'SenseVoice must permit Windows ARM64')
  const sherpa = voice('sherpa-onnx-node')
  assert.equal(typeof sherpa.OfflineRecognizer, 'function')
  assert.equal(typeof sherpa.Vad, 'function')
  if (speechSmoke) {
    const config = {
      featConfig: { sampleRate: 16000, featureDim: 80 },
      modelConfig: { senseVoice: { model: join(cache, assets.models.int8.sha256), language: 'auto', useInverseTextNormalization: 1 },
        tokens: join(cache, assets.tokens.sha256), numThreads: 2, provider: 'cpu', debug: 0 },
    }
    const recognizer = new sherpa.OfflineRecognizer(config)
    recognizer.setConfig(config)
    const stream = recognizer.createStream()
    stream.acceptWaveform({ sampleRate: 16000, samples: new Float32Array(16000) })
    recognizer.decode(stream)
    assert.equal(typeof recognizer.getResult(stream).text, 'string')
    const vad = new sherpa.Vad({ sileroVad: { model: join(cache, assets.vad.sha256), threshold: 0.5, minSilenceDuration: 0.5,
      minSpeechDuration: 0.25, maxSpeechDuration: 20, windowSize: 512 }, sampleRate: 16000, numThreads: 2, provider: 'cpu', debug: 0 }, 30)
    vad.acceptWaveform(new Float32Array(16000)); vad.flush(); vad.reset()
  }
  if (app !== undefined) for (const path of Object.keys(requirePayload.cache).filter(path => path.endsWith('.node'))) assertPackaged(path)
  console.log(`Native Windows ${process.arch} Electron ${process.versions.electron}: Koffi, ConPTY, Sherpa bindings${speechSmoke ? ', SenseVoice and VAD inference' : ''} passed`)
  // The native engines may retain worker handles; this isolated smoke owns their process lifetime.
  process.exit(0)
}
