#!/usr/bin/env node
/**
 * Checks the guard that stops a typed-out tool call being read aloud.
 *
 * The regex has to be narrow. Too loose and it silences real sentences — the
 * user asks a question and JARVIS says nothing, which is worse than the noise
 * it was meant to prevent. So the negatives here matter more than the
 * positives, and they are drawn from things the model has actually said.
 */
const RE = /^[a-z][a-z0-9_]*(__[a-z][a-z0-9_]*)?[({[][\s\S]*[)}\]]$/i
const isTypedToolCall = (t) => RE.test(t.trim())

/** Real outputs observed from gemma-4-e4b during probing. */
const SHOULD_CATCH = [
  'get_weather{}',
  'fastfacts_get_weather{}',
  'fastfacts__get_weather{}',
  'get_news()',
  'fastfacts_get_news()',
  'search_emails({"query": "is:unread"})',
  'get_weather{"location": "London"}',
  '  get_news()  ',
  'GET_NEWS()'
]

/** Things a voice assistant genuinely says. None may be silenced. */
const SHOULD_SPEAK = [
  'You have ten unread messages, sir.',
  'It is seventy-two degrees and partly cloudy on the Upper East Side.',
  'I can check the weather (and the news) if you like.',
  'Shall I read them?',
  'The Yankees won four to three.',
  'I cannot delete emails; you would need to do that in Chat.',
  'That is get_weather, if you were wondering what it is called.',
  'Right (as you say), sir.',
  'good morning',
  'Checking now.',
  '',
  'Well?',
  'I found three: one from Kate, two from Google.',
  'The forecast (light drizzle) holds through this evening.'
]

let fail = 0
for (const t of SHOULD_CATCH) {
  const ok = isTypedToolCall(t)
  if (!ok) fail++
  console.log(`  ${ok ? '\x1b[32mok  \x1b[0m' : '\x1b[31mMISS\x1b[0m'} catches  ${JSON.stringify(t)}`)
}
for (const t of SHOULD_SPEAK) {
  const ok = !isTypedToolCall(t)
  if (!ok) fail++
  console.log(`  ${ok ? '\x1b[32mok  \x1b[0m' : '\x1b[31mSILENCED\x1b[0m'} speaks   ${JSON.stringify(t)}`)
}
console.log(fail === 0 ? '\n\x1b[32mall typed-call checks passed\x1b[0m\n' : `\n\x1b[31m${fail} failed\x1b[0m\n`)
process.exit(fail === 0 ? 0 : 1)
