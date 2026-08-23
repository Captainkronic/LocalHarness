import { build } from 'esbuild'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
const ROOT = '/Users/adam/LocalHarness'
const dir = await mkdtemp(join(tmpdir(), 'lh-w-'))
await writeFile(join(dir,'e.ts'), `export { writtenFilesLine } from '${ROOT}/src/main/llm/prompt'\n`)
const outfile = join(dir,'b.mjs')
await build({entryPoints:[join(dir,'e.ts')],outfile,bundle:true,banner:{js:"import{createRequire as __cr}from'node:module';const require=__cr(import.meta.url);"},format:'esm',platform:'node',target:'node22',logLevel:'silent',alias:{'@shared':join(ROOT,'src/shared'),'@main':join(ROOT,'src/main')}})
const { writtenFilesLine } = await import(pathToFileURL(outfile).href)
const msgs = [{ id:'a', role:'assistant', content:'', toolCalls:[{ id:'c1', name:'write_file', arguments: JSON.stringify({path:'index.html', content:'export const a=1\n'+'x'.repeat(2000)}), status:'ok', result:'Wrote index.html (120 lines) 3.1 kB on disk, verified.' }] }]
console.log(JSON.stringify(writtenFilesLine(msgs)))
