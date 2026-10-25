// Builds the loadable extension into dist/ (and optionally a store zip with --zip).
import { build } from 'esbuild'
import { cp, rm, mkdir, readFile, readdir } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// fileURLToPath, not `new URL().pathname`: that yields "/C:/…" on Windows and keeps
// %20 escapes, so path.join produced "C:\C:\…" and the build died in mkdir.
const root = path.dirname(fileURLToPath(import.meta.url))
const src = path.join(root, 'src')
const dist = path.join(root, 'dist')

await rm(dist, { recursive: true, force: true })
await mkdir(dist, { recursive: true })
// ESM sources that must not be copied raw: they import bare npm specifiers, so only the
// esbuild bundles below can load them.
const bundled = ['offscreen/offscreen.js', 'offscreen/worker.js', 'offscreen/kokoro-core.js', 'offscreen/paradee-core.js', 'offscreen/paradee-download.js', 'offscreen/paradee-worker.js', 'options/installer.js'].map((f) => path.join(src, f))
await cp(src, dist, { recursive: true, filter: (p) => !bundled.includes(p) })

await build({
  entryPoints: {
    'offscreen/offscreen': path.join(src, 'offscreen', 'offscreen.js'),
    'offscreen/worker': path.join(src, 'offscreen', 'worker.js'),
    'offscreen/paradee-worker': path.join(src, 'offscreen', 'paradee-worker.js'),
    'options/installer': path.join(src, 'options', 'installer.js'),
  },
  outdir: dist,
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: 'chrome120',
  minify: true,
  logLevel: 'info',
  define: { 'process.env.NODE_ENV': '"production"' },
})

const ort = path.join(root, 'node_modules', 'onnxruntime-web', 'dist')
await mkdir(path.join(dist, 'ort'), { recursive: true })
for (const f of ['ort-wasm-simd-threaded.mjs', 'ort-wasm-simd-threaded.wasm']) {
  await cp(path.join(ort, f), path.join(dist, 'ort', f))
}

if (process.argv.includes('--zip')) {
  const { version } = JSON.parse(await readFile(path.join(src, 'manifest.json'), 'utf8'))
  const out = path.join(root, `hearline-${version}.zip`)
  await rm(out, { force: true })
  if (process.platform === 'win32') {
    // No zip on Windows; PowerShell's Compress-Archive writes the same store layout.
    execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command',
      `Compress-Archive -Force -Path '${dist}\\*' -DestinationPath '${out}'`])
  } else {
    execFileSync('zip', ['-qr', out, '.'], { cwd: dist })
  }
  console.log('wrote', out)
}
console.log('built', dist, (await readdir(dist)).join(', '))
