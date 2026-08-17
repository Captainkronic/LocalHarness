import { build } from 'esbuild'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
const ROOT = '/Users/adam/LocalHarness'
const dir = await mkdtemp(join(tmpdir(), 'lh-tl-'))
await writeFile(join(dir,'e.ts'), `export { buildMessages, countConversationTokens } from '${ROOT}/src/main/llm/prompt'\n`)
const shim = join(dir,'s.mjs')
await writeFile(shim, `import{tmpdir}from'node:os'\nexport const app={getPath:()=>tmpdir(),getVersion:()=>'0'}\nexport default{app}\n`)
const out = join(dir,'b.mjs')
await build({entryPoints:[join(dir,'e.ts')],outfile:out,bundle:true,format:'esm',platform:'node',target:'node22',logLevel:'silent',
  alias:{'@shared':join(ROOT,'src/shared'),'@main':join(ROOT,'src/main'),electron:shim}})
const { buildMessages, countConversationTokens } = await import(pathToFileURL(out).href)
const now = Date.now()
const messages = [
  { id:'u0', role:'user', content:'My favourite colour is vermilion.', createdAt: now },
  { id:'a0', role:'assistant', content:'Noted.', createdAt: now },
  { id:'a1', role:'assistant', content:'checking', createdAt: now,
    toolCalls:[{ id:'c1', name:'search_emails', arguments:'{}', origin:'mcp', status:'ok', result:'x' }] },
  { id:'t1', role:'tool', toolCallId:'c1', content:'MAIL '+'y'.repeat(3000), createdAt: now }
]
for (let i=0;i<40;i++){
  messages.push({ id:`u${i+1}`, role:'user', content:`filler ${i} `+'z'.repeat(800), createdAt: now })
  messages.push({ id:`a${i+2}`, role:'assistant', content:`answer ${i} `+'w'.repeat(800), createdAt: now })
}
messages.push({ id:'uz', role:'user', content:'What is 2 + 2? Answer with the number only.', createdAt: now })
const conv = { id:'c', title:'t', workflowId:'chat', messages, createdAt:now, updatedAt:now }
const SYS='You are terse.'
const raw = countConversationTokens(buildMessages(conv, SYS, false))
const BUDGET = 2000
let info=null
const trimmed = buildMessages(conv, SYS, false, { budget: BUDGET, onTrim:(i)=>{info=i} })
const cost = countConversationTokens(trimmed)
console.log(`  ${raw} tok -> ${cost} tok (budget ${BUDGET}); dropped ${info.messages} msgs`)
const toolIdx = trimmed.findIndex(m=>m.role==='tool')
console.log(`  tool message survived? ${toolIdx>=0 ? 'yes at '+toolIdx : 'no (dropped with its call, correct)'}`)
const MODEL = process.argv[2]
const r = await fetch('http://127.0.0.1:1235/v1/chat/completions', {
  method:'POST', headers:{'content-type':'application/json'},
  body: JSON.stringify({ model: MODEL, messages: trimmed, max_tokens: 24, temperature: 0 })
})
if (!r.ok) { console.log(`  \x1b[31mREJECTED ${r.status}\x1b[0m ${(await r.text()).slice(0,240)}`); process.exit(1) }
const b = await r.json()
console.log(`  \x1b[32maccepted\x1b[0m prompt_tokens=${b.usage?.prompt_tokens} reply=${JSON.stringify((b.choices?.[0]?.message?.content??'').trim().slice(0,40))}`)
await rm(dir,{recursive:true,force:true})
