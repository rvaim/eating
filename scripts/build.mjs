import { build } from 'esbuild'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { resolve, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as React from 'react'
import * as JsxRuntime from 'react/jsx-runtime'

const root = fileURLToPath(new URL('../', import.meta.url))
const target = process.argv[2] ?? 'all'
const aliases = Object.fromEntries(['plugin-core', 'plugin-sdk', 'ui-sdk'].map(name => [`@eating/${name}`, resolve(root, `packages/${name}/src/index.ts`)]))
const common = { bundle: true, target: 'es2022', format: 'esm', logLevel: 'warning', alias: aliases }
const requireBanner = "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);"

async function buildSdk() {
  for (const name of ['plugin-core', 'plugin-sdk', 'ui-sdk']) {
    const directory = resolve(root, `packages/${name}`)
    await build({ ...common, platform: 'neutral', packages: 'external', entryPoints: [resolve(directory, 'src/index.ts')], outfile: resolve(directory, 'dist/index.js') })
    const config = { extends: relative(directory, resolve(root, 'tsconfig.json')), compilerOptions: { noEmit: false, emitDeclarationOnly: true, declaration: true, rootDir: 'src', outDir: 'dist', paths: {} }, include: ['src/**/*.ts'], exclude: ['src/**/*.test.ts'] }
    await writeFile(resolve(directory, 'tsconfig.build.json'), JSON.stringify(config, null, 2) + '\n')
    execFileSync(process.execPath, [resolve(root, 'node_modules/typescript/bin/tsc'), '-p', resolve(directory, 'tsconfig.build.json')], { cwd: root, stdio: 'inherit' })
  }
}

async function buildPlugin(source) {
  const directory = resolve(root, source)
  if (!directory.startsWith(resolve(root, 'plugins') + '/')) throw new Error('插件构建入口必须在仓库plugins目录内。')
  const manifest = JSON.parse(await readFile(resolve(directory, 'plugin.json'), 'utf8'))
  const pkg = JSON.parse(await readFile(resolve(directory, 'package.json'), 'utf8'))
  if (pkg.version !== manifest.version) throw new Error('插件包与清单版本必须一致。')
  const output = resolve(directory, 'dist')
  await mkdir(resolve(output, 'ui'), { recursive: true })
  await build({ ...common, platform: 'node', entryPoints: [resolve(directory, 'src/server.ts')], outfile: resolve(output, manifest.backend), banner: { js: requireBanner }, metafile: true }).then(result => {
    for (const path of Object.keys(result.metafile.inputs)) if (/apps\//.test(path)) throw new Error('插件后台不得依赖应用内部源码：' + path)
  })
  await build({ ...common, platform: 'browser', entryPoints: [resolve(directory, 'src/web/entry.tsx')], outfile: resolve(output, manifest.frontend.entry), write: false, jsx: 'automatic', minify: true, metafile: true,
    define: { 'process.env.NODE_ENV': '"production"' }, plugins: [{ name: 'shared-react-runtime', setup(builder) {
      builder.onResolve({ filter: /^react(?:\/jsx-runtime)?$/ }, args => ({ path: args.path === 'react' ? '/_eating/runtime/react.js' : '/_eating/runtime/jsx-runtime.js', external: true }))
    } }],
  }).then(async result => {
    for (const path of Object.keys(result.metafile.inputs)) if (/apps\//.test(path)) throw new Error('插件面板不得依赖应用内部源码：' + path)
    for (const file of result.outputFiles) await writeFile(file.path.endsWith('.css') ? resolve(output, manifest.frontend.style) : resolve(output, manifest.frontend.entry), file.contents)
  })
  const integrity = {}
  for (const name of [manifest.backend, manifest.frontend.entry, manifest.frontend.style]) integrity[name] = createHash('sha256').update(await readFile(resolve(output, name))).digest('hex')
  await writeFile(resolve(output, 'eating-plugin.json'), JSON.stringify({ ...manifest, integrity }, null, 2) + '\n')
  console.log(`插件产物：${relative(root, output)}，${manifest.id}@${manifest.version}，API v${manifest.apiVersion}`)
}

async function buildHost() {
  const host = await build({ ...common, platform: 'node', entryPoints: [resolve(root, 'apps/host/src/main.ts')], outfile: resolve(root, 'apps/host/dist/main.mjs'), banner: { js: requireBanner }, metafile: true })
  for (const path of Object.keys(host.metafile.inputs)) if (relative(root, resolve(process.cwd(), path)).startsWith('plugins/')) throw new Error('Host应用不能静态捆入插件源码：' + path)
  await build({ ...common, platform: 'node', entryPoints: [resolve(root, 'apps/host/src/plugin-cli.ts')], outfile: resolve(root, 'apps/host/dist/plugin-cli.mjs'), banner: { js: requireBanner } })
}

async function buildRuntime() {
  const output = resolve(root, 'dist/_eating/runtime')
  await mkdir(output, { recursive: true })
  for (const [name, value, key] of [['react', React, 'react'], ['jsx-runtime', JsxRuntime, 'jsxRuntime']]) {
    const keys = Object.keys(value).filter(key => key !== 'default' && /^[$A-Z_a-z][$\w]*$/.test(key))
    await writeFile(resolve(output, `${name}.js`), `const runtime = globalThis.__EATING_UI_RUNTIME_V1__?.${key};\nif (!runtime) throw new Error('Eating UI runtime v1 尚未初始化。');\nconst { ${keys.join(', ')} } = runtime;\nexport { ${keys.join(', ')} };\nexport default runtime;\n`)
  }
}

if (target === 'sdk' || target === 'all') await buildSdk()
if (target === 'plugin') await buildPlugin(process.argv[3] ?? 'plugins/communication/qq')
if (target === 'all') {
  await buildPlugin('plugins/communication/qq')
  await buildPlugin('plugins/harness/dsh')
}
if (target === 'host' || target === 'all') await buildHost()
if (target === 'all') {
  execFileSync(process.execPath, [resolve(root, 'node_modules/typescript/bin/tsc'), '--noEmit'], { cwd: root, stdio: 'inherit' })
  execFileSync(process.execPath, [resolve(root, 'node_modules/vite/bin/vite.js'), 'build', '--config', 'apps/web/vite.config.ts'], { cwd: root, stdio: 'inherit' })
  await buildRuntime()
}
if (!['all', 'sdk', 'plugin', 'host'].includes(target)) throw new Error('未知构建目标。')
