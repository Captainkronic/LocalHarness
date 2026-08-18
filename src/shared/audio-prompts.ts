/**
 * Starter ideas for the Audio workflow.
 *
 * Same principle as the Image starters: these are IDEAS, not parameter sets.
 * The workflow's own job is turning "something to cook dinner to" into a tag
 * list with a tempo and a key, and it explains what it chose while it does it —
 * so a suggestion that arrives pre-tagged skips the part that teaches.
 *
 * Weighted towards music, because that is what this workflow is mostly for, but
 * not exclusively: it also does sound effects, ambiences and short stings, and a
 * screen showing only songs implies it does not. The test asserts that split
 * rather than trusting it.
 *
 * One thing shapes the content that is specific to audio. There is no
 * audio-to-audio path in this stack — nothing can be altered in place, only
 * composed again — so a starter that says "the same but slower" is worse than
 * useless on an empty screen: it names a previous take that does not exist AND
 * implies an edit the tool cannot do. Every idea here is a thing to make from
 * nothing. There is a test for that too.
 */

/* ------------------------------------------------------------------ */
/* Songs — what they are about, and what they are for                  */
/* ------------------------------------------------------------------ */

const SONG_ABOUT = [
  'missing the last train home', 'a long drive at night', 'moving out of your first flat',
  'a friend you have not called in years', 'the end of a good summer',
  'waiting for test results', 'learning to swim as an adult',
  'the corner shop that closed down', 'someone who always ran late',
  'a town you were glad to leave', 'the first cold morning of the year',
  'a dog that waited by the door', 'getting the band back together badly',
  'an argument nobody won', 'the last day of a job you loved',
  'a letter never sent', 'coming home to an empty house',
  'a wedding where it rained', 'the quiet after a big party',
  'a promise made at fifteen', 'someone leaving on the early ferry',
  'the summer everything changed', 'a photograph found in a book'
]

const SONG_FOR = [
  'to work to', 'for a road trip', 'for washing up on a Sunday',
  'for a title sequence', 'for a coffee shop playlist', 'for a workout',
  'for falling asleep to', 'for a birthday video', 'for a wedding first dance',
  'for a rainy afternoon', 'for a montage of someone learning something',
  'for the credits of a small documentary', 'for a shop at closing time',
  'for a long walk', 'for a slow morning'
]

const GENRES = [
  'lo-fi hip hop', 'folk', 'synthwave', 'bossa nova', 'drum and bass',
  'gospel', 'ambient', 'alt country', 'shoegaze', 'funk', 'trip hop',
  'bluegrass', 'a jazz trio', 'garage rock', 'reggae', 'disco',
  'chamber pop', 'afrobeat', 'deep house', 'punk', 'soul', 'dub',
  'a brass band', 'klezmer', 'post rock', 'city pop', 'motown',
  'a string quartet', 'gqom', 'surf rock'
]

const MOODS = [
  'hopeful', 'melancholy', 'triumphant', 'restless', 'sleepy', 'tense',
  'warm', 'lonely', 'playful', 'defiant', 'wistful', 'urgent',
  'unbothered', 'menacing', 'tender', 'giddy'
]

const LED_BY = [
  'led by a Rhodes', 'with a brass section', 'just voice and guitar',
  'with strings underneath', 'built on a walking bass', 'with a wonky synth lead',
  'with fingerpicked acoustic', 'with a church organ', 'with hand percussion',
  'with a lone trumpet', 'with a detuned piano', 'with layered harmonies',
  'with an accordion', 'with a slide guitar', 'with muted horns',
  'with a pipe organ and not much else'
]

const TEMPO = [
  '', ', slow and spacious', ', around 70bpm', ', around 90bpm',
  ', around 120bpm', ', fast and driving', ', half time', ', unhurried'
]

const VOICE = [
  'instrumental', 'with a female vocal', 'with a male vocal',
  'with close harmonies', 'with a spoken word verse', 'with a choir',
  'with a whispered vocal', 'with a crowd singing along'
]

const LENGTHS = [
  'A 30-second', 'A one-minute', 'A short', 'A two-minute', 'A 45-second'
]

/* ------------------------------------------------------------------ */
/* Loops and beds                                                      */
/* ------------------------------------------------------------------ */

const LOOP_USES = [
  'a focus timer', 'a podcast bed', 'a game menu screen', 'a waiting room',
  'a shop soundtrack', 'a meditation app', 'a cooking video',
  'a train announcement jingle bed', 'a museum exhibit', 'a hold line',
  'a puzzle game', 'a weather segment'
]

const LOOP_CHAR = [
  'that never quite resolves', 'with nothing that grabs your attention',
  'that loops seamlessly', 'that gets slightly warmer each bar',
  'built from one repeated phrase', 'with a lot of space in it',
  'that stays out of the way', 'with a slow swell and release'
]

/* ------------------------------------------------------------------ */
/* Sound effects — event and acoustics                                 */
/* ------------------------------------------------------------------ */

const SFX_EVENTS = [
  'a heavy oak door closing', 'a match striking', 'footsteps on gravel',
  'a kettle coming to the boil', 'a sword being drawn', 'coins dropped on wood',
  'a bicycle bell', 'a window being forced open', 'a cork leaving a bottle',
  'a rope creaking under weight', 'a camera shutter', 'a bag of ice tipped out',
  'a heavy book dropped on a desk', 'a zip being pulled slowly',
  'a chair dragged across a floor', 'an old lift arriving',
  'a typewriter carriage return', 'a bowling ball down a lane',
  'a fridge door with a magnetic seal', 'someone running up wooden stairs',
  'a glass bottle rolling', 'a lighter failing three times then catching',
  'a tent zip in the dark', 'a metal gate clanging shut',
  'a bottle of fizzy drink opening', 'a heavy chain being dragged',
  'a wooden spoon in a mixing bowl', 'a bike chain slipping',
  'an umbrella opening in wind', 'a suitcase wheeled over paving',
  'a stack of plates set down', 'a boot pulled out of mud',
  'a curtain drawn along a rail', 'a floorboard giving under weight',
  'a letterbox flapping shut', 'an old key turning in a stiff lock'
]

const SFX_SPACE = [
  'in a stone hall', 'in a small kitchen', 'outdoors in wind',
  'in an empty warehouse', 'close mic and very dry', 'down a long corridor',
  'in a carpeted room', 'in a tiled bathroom', 'across a car park at night',
  'inside a car',
  'in a stairwell', 'in an attic', 'in a cellar',
  'from the next room', 'in a busy street', 'in a cave'
]

/* ------------------------------------------------------------------ */
/* Ambiences                                                           */
/* ------------------------------------------------------------------ */

const AMBIENCES = [
  'rain on a tent', 'a busy café', 'a forest at dawn', 'a laundrette',
  'an airport gate at 5am', 'a harbour with rigging clinking',
  'a train carriage between stations', 'a summer garden at night',
  'a library at closing time', 'a swimming pool from the shallow end',
  'a market before it opens', 'a hospital corridor at night',
  'a pub garden in the evening', 'a workshop with someone sanding',
  'a beach in winter', 'a school corridor between lessons',
  'a boat at anchor', 'a cinema before the film starts',
  'a fairground winding down', 'a bus station at midnight',
  'a greenhouse in heavy rain', 'a rowing club at dawn', 'a bowling alley',
  'a cathedral between services', 'a campsite before anyone wakes',
  'a ferry crossing in fog', 'an allotment on a still evening',
  'a hotel lobby at 3am', 'a snowy street with no traffic',
  'a canal towpath', 'a rooftop above a city', 'a village hall before a meeting',
  'a garage with the door open', 'a night bus', 'a quarry in the wind',
  'a chapel with rain outside', 'a departure lounge', 'a stable at feeding time'
]

const AMBIENCE_LENGTH = [
  '', ' — a minute of it, no events', ' — thirty seconds, looping',
  ' with one distant sound halfway through', ' as a background bed',
  ' with distant traffic underneath', ' just before something happens',
  ' with one person moving about', ' recorded from a doorway',
  ' with weather coming in', ' and nothing else at all',
  ' fading in from silence'
]

/* ------------------------------------------------------------------ */
/* Short functional sounds                                             */
/* ------------------------------------------------------------------ */

const STINGS = [
  'a notification chime', 'a podcast intro sting', 'a logo sound',
  'a game level-up sound', 'an alarm that is not annoying',
  'a send-message blip', 'an error sound that is not harsh',
  'a coin pickup sound', 'a door unlock confirmation',
  'a countdown to zero', 'a correct-answer chime', 'a save-complete sound',
  'a message-sent whoosh', 'a camera shutter UI sound', 'a menu-open sound',
  'a battery-low warning', 'a scan-complete beep', 'a page-turn sound',
  'a timer finishing', 'a lock-screen click', 'a purchase-confirmed sound',
  'a boot-up sound for an old computer', 'a swipe-to-dismiss sound',
  'a gentle wake-up alarm', 'a quest-accepted flourish', 'a typing confirmation tick'
]

const STING_CHAR = [
  'warm and friendly', 'three notes and done', 'wooden and soft',
  'bright but not shrill', 'in under a second', 'with a little bounce',
  'plain and neutral', 'slightly retro',
  'glassy and clean', 'like a marimba', 'with a soft tail',
  'very short and dry', 'like a bell struck once', 'rounded and low',
  'with a rising pitch', 'muted and discreet', 'plucked', 'breathy'
]

/* ------------------------------------------------------------------ */
/* Cinematic cues                                                      */
/* ------------------------------------------------------------------ */

const CUES = [
  'a riser into a soft piano landing', 'a tension bed under a chase',
  'end credits music', 'the moment a secret is revealed',
  'a slow build to nothing at all', 'a heartbeat getting faster',
  'the calm after something terrible', 'an establishing shot of a city',
  'a chase that turns comic', 'a door closing on a whole era',
  'a sunrise after a long night', 'a countdown that fails'
]

/** Optional trailing detail. The empty string is a real member — a bare
 *  "A song about a long drive at night" should still come up. */
const MAYBE_SPACE = ['', ...SFX_SPACE.map((x) => `, ${x}`)]
const MAYBE_STING_CHAR = ['', ...STING_CHAR.map((x) => `, ${x}`)]
const MAYBE_MOOD = ['', ...MOODS.map((x) => `, ${x}`)]
const MAYBE_LOOP_CHAR = ['', ...LOOP_CHAR.map((x) => ` ${x}`)]

/* ------------------------------------------------------------------ */
/* Templates                                                           */
/* ------------------------------------------------------------------ */

type Part = string | readonly string[]

interface Template {
  size: 'simple' | 'rich'
  parts: readonly Part[]
}

const TEMPLATES: readonly Template[] = [
  /* -- songs: the bulk of it ---------------------------------------- */
  { size: 'simple', parts: ['A song about ', SONG_ABOUT, TEMPO] },
  { size: 'simple', parts: [LENGTHS, ' song about ', SONG_ABOUT, TEMPO] },
  { size: 'rich', parts: [LENGTHS, ' song about ', SONG_ABOUT, ', ', VOICE] },
  { size: 'rich', parts: ['A song about ', SONG_ABOUT, ' — ', GENRES, TEMPO] },
  { size: 'rich', parts: [GENRES, ', ', MOODS, ', about ', SONG_ABOUT] },
  { size: 'simple', parts: ['Something ', MOODS, ' ', SONG_FOR, TEMPO] },
  { size: 'simple', parts: ['Something ', SONG_FOR, ', ', GENRES] },
  { size: 'rich', parts: ['Something ', SONG_FOR, ' — ', GENRES, ', ', LED_BY, TEMPO] },
  { size: 'simple', parts: [GENRES, ', ', LED_BY, TEMPO] },
  { size: 'rich', parts: [GENRES, ', ', MOODS, ', ', LED_BY, TEMPO] },
  { size: 'simple', parts: ['An instrumental ', SONG_FOR, TEMPO] },
  { size: 'rich', parts: ['An instrumental ', SONG_FOR, ': ', GENRES, ', ', LED_BY] },
  { size: 'rich', parts: [LENGTHS, ' ', GENRES, ' track, ', MOODS, ', ', VOICE, TEMPO] },

  /* -- loops and beds ------------------------------------------------ */
  { size: 'simple', parts: ['A loop for ', LOOP_USES, MAYBE_LOOP_CHAR] },
  { size: 'rich', parts: ['A loop for ', LOOP_USES, ' ', LOOP_CHAR] },
  { size: 'rich', parts: [GENRES, ' bed for ', LOOP_USES, ' ', LOOP_CHAR] },

  /* -- sound effects -------------------------------------------------- */
  { size: 'simple', parts: ['The sound of ', SFX_EVENTS, MAYBE_SPACE] },
  { size: 'rich', parts: ['The sound of ', SFX_EVENTS, ', ', SFX_SPACE] },

  { size: 'rich', parts: ['The sound of ', SFX_EVENTS, ', ', SFX_SPACE, ' — ', MOODS] },

  /* -- ambiences ------------------------------------------------------
     Labelled, unlike the effects above. Both start from a place, and without
     the lead-in "the sound of a laundrette" is ambiguous between a room tone
     and a single event — which is a real difference to the renderer. It also
     makes the family identifiable without a list of place names that goes out
     of date the moment one is added. */
  { size: 'simple', parts: ['Ambience: ', AMBIENCES, AMBIENCE_LENGTH] },
  { size: 'rich', parts: ['Ambience: ', AMBIENCES, AMBIENCE_LENGTH] },
  { size: 'rich', parts: ['Ambience: ', AMBIENCES, ', ', MOODS, AMBIENCE_LENGTH] },

  /* -- short functional sounds ---------------------------------------- */
  { size: 'simple', parts: ['A short sound: ', STINGS, MAYBE_STING_CHAR] },
  { size: 'rich', parts: ['A short sound: ', STINGS, ', ', STING_CHAR] },
  { size: 'rich', parts: ['A short sound: ', STINGS, ', ', STING_CHAR, ', for ', LOOP_USES] },

  /* -- cinematic cues -------------------------------------------------- */
  { size: 'simple', parts: ['Music for ', CUES, MAYBE_MOOD] },
  { size: 'rich', parts: ['Music for ', CUES, ' — ', MOODS, ', ', LED_BY] }
] as const

/* ------------------------------------------------------------------ */
/* Assembly                                                            */
/* ------------------------------------------------------------------ */

function combosOf(t: Template): number {
  return t.parts.reduce((n, p) => (typeof p === 'string' ? n : n * p.length), 1)
}

/** Weighted by the square root of the space — see image-prompts.ts for why. */
function pickTemplate(pool: readonly Template[], rand: () => number): Template {
  let total = 0
  const weights = pool.map((t) => {
    const w = Math.sqrt(combosOf(t))
    total += w
    return w
  })
  let r = rand() * total
  for (let i = 0; i < pool.length; i++) {
    r -= weights[i]
    if (r <= 0) return pool[i]
  }
  return pool[pool.length - 1]
}

function renderTemplate(t: Template, pick: (n: number) => number): string {
  let out = ''
  for (const part of t.parts) {
    out += typeof part === 'string' ? part : part[pick(part.length)]
  }
  return out.charAt(0).toUpperCase() + out.slice(1)
}

/** How many distinct ideas the grammar can produce. Exact, not an estimate. */
export function audioPromptSpaceSize(size?: Template['size']): number {
  return TEMPLATES.filter((t) => size === undefined || t.size === size)
    .reduce((total, t) => total + combosOf(t), 0)
}

/** Every template at its first choice — for tests and inspection. */
export function audioPromptSamples(): string[] {
  return TEMPLATES.map((t) => renderTemplate(t, () => 0))
}

/** `n` starter ideas, mixing a bare idea with one carrying a little direction. */
export function randomAudioPrompts(n: number, rand: () => number = Math.random): string[] {
  const pick = (len: number): number => Math.floor(rand() * len)
  const simple = TEMPLATES.filter((t) => t.size === 'simple')
  const rich = TEMPLATES.filter((t) => t.size === 'rich')

  const wanted: Template[] = []
  if (n >= 2) {
    wanted.push(pickTemplate(simple, rand), pickTemplate(rich, rand))
  }
  while (wanted.length < n) {
    wanted.push(pickTemplate(TEMPLATES, rand))
  }

  for (let i = wanted.length - 1; i > 0; i--) {
    const j = pick(i + 1)
    ;[wanted[i], wanted[j]] = [wanted[j], wanted[i]]
  }

  const out: string[] = []
  const seen = new Set<string>()
  for (const t of wanted) {
    for (let attempt = 0; attempt < 8; attempt++) {
      const s = renderTemplate(t, pick)
      if (!seen.has(s)) {
        seen.add(s)
        out.push(s)
        break
      }
    }
  }
  return out
}
