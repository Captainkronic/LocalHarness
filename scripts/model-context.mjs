import { build } from 'esbuild'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
const ROOT = '/Users/adam/LocalHarness'
const dir = await mkdtemp(join(tmpdir(), 'lh-reload-'))
await writeFile(join(dir, 'e.ts'),
  `export { LmStudioControl } from '${ROOT}/src/main/llm/control'
   export { SettingsStore } from '${ROOT}/src/main/store/settings'\n`)
const shim = join(dir, 'shim.mjs')
await writeFile(shim, `export const app={getPath:()=>process.env.LH_USERDATA,getVersion:()=>'0.1.0'}\nexport default {app}\n`)
process.env.LH_USERDATA = join(process.env.HOME, 'Library/Application Support/localharness')
const out = join(dir, 'b.mjs')
await build({ entryPoints:[join(dir,'e.ts')], outfile:out, bundle:true, format:'esm', platform:'node',
  target:'node22', logLevel:'silent',
  alias:{ '@shared': join(ROOT,'src/shared'), '@main': join(ROOT,'src/main'), electron: shim } })
const M = await import(pathToFileURL(out).href)
const settings = new M.SettingsStore(process.env.LH_USERDATA)
const control = new M.LmStudioControl({ getSettings:()=>settings.get(), onState:()=>{}, onProgress:()=>{},
  onLog:(l,s,m)=>{ if(l==='error') console.log('  '+m) } })
control.start()
for (let i=0;i<40 && control.state().status!=='connected';i++) await new Promise(r=>setTimeout(r,250))
console.log('control:', control.state().status)
const ctx = Number(process.argv[2] || 98304)
const model = process.argv[3] || 'qwen/qwen3.8-27b'
let st = await control.refresh()
for (const m of st.loaded) { console.log('unloading', m.modelKey); await control.unload(m.identifier).catch(()=>{}) }
for (let i=0;i<60;i++){ st = await control.refresh(); if (!st.loaded.length) break; await new Promise(r=>setTimeout(r,1000)) }
console.log('loading', model, 'at', ctx)
const r = await control.load(model, { contextLength: ctx })
console.log('result:', JSON.stringify(r))
st = await control.refresh()
console.log('now loaded:', st.loaded.map(m=>`${m.modelKey} ctx=${m.contextLength}`).join(', ') || 'none')
process.exit(r.ok ? 0 : 1)
