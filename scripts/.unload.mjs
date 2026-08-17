import { build } from 'esbuild'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
const ROOT = '/Users/adam/LocalHarness'
const dir = await mkdtemp(join(tmpdir(), 'lh-un-'))
await writeFile(join(dir,'e.ts'), `export { LmStudioControl } from '${ROOT}/src/main/llm/control'\n`)
const shim = join(dir,'s.mjs')
await writeFile(shim, `import{tmpdir}from'node:os'\nexport const app={getPath:()=>tmpdir(),getVersion:()=>'0'}\nexport default{app}\n`)
const out = join(dir,'b.mjs')
await build({entryPoints:[join(dir,'e.ts')],outfile:out,bundle:true,format:'esm',platform:'node',target:'node22',logLevel:'silent',
  alias:{'@shared':join(ROOT,'src/shared'),'@main':join(ROOT,'src/main'),electron:shim}})
const { LmStudioControl } = await import(pathToFileURL(out).href)
const wait = (ms) => new Promise(r => setTimeout(r, ms))
const c = new LmStudioControl({
  getSettings: () => ({ nativeApiUrl: 'http://adams-mac-studio.tailc7bb1e.ts.net:1234' }),
  onLog: () => {}, onState: () => {}
})
c.start()
for (let i = 0; i < 30 && c.state().status !== 'connected'; i++) await wait(500)
if (c.state().status !== 'connected') { console.error('not connected'); process.exit(1) }
const loaded = await c.listLoaded()
console.log('resident:', loaded.map(m => m.identifier ?? m.modelKey).join(', ') || '(none)')
for (const m of loaded) {
  const id = m.identifier ?? m.modelKey
  process.stdout.write(`unloading ${id} ... `)
  const r = await c.unload(id)
  console.log(r?.ok === false ? `FAILED ${r.error}` : 'ok')
}
console.log('after:', (await c.listLoaded()).map(m => m.identifier ?? m.modelKey).join(', ') || '(none)')
await rm(dir,{recursive:true,force:true})
process.exit(0)
