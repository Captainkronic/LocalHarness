/**
 * The starter prompts for the Image workflow.
 *
 * Seven fixed suggestions turned the empty state into the same three-line
 * poster every time, which is a poor advertisement for a workflow whose whole
 * range is "anything you can describe". This deals a fresh trio on every visit.
 *
 * It is a grammar rather than a list of literal strings, for two reasons. A few
 * hundred fragments compose into six figures of distinct prompts, where the
 * same weight of hand-written lines would give a few hundred. And a grammar can
 * be checked: `imagePromptSpaceSize()` counts the space exactly, so "thousands"
 * is arithmetic rather than a claim.
 *
 * The one thing a grammar gets wrong is coherence — slot it together carelessly
 * and you get "isometric flat-vector portrait at 85mm f/1.4". So vocabulary is
 * scoped to the family that uses it: LENSES only ever reaches a template that
 * is photographing something, PALETTES only ever reaches one that is drawn.
 * Nothing is shared across families that would not survive the crossover.
 *
 * Everything here describes a picture to MAKE. Nothing refers to a previous
 * image, a change, or "the last one" — this workflow generates, and an edit
 * suggestion in it sends the user somewhere the tool cannot follow. There is a
 * test that enforces exactly that.
 */

/* ------------------------------------------------------------------ */
/* Vocabulary — photographic                                           */
/* ------------------------------------------------------------------ */

const HOUR = [
  'first light', 'a grey overcast noon', 'late golden hour', 'the blue hour',
  'harsh midday sun', 'dusk, just after the sun has gone', 'a foggy morning',
  'midnight under sodium streetlight', 'a bright hazy afternoon',
  'the last ten minutes before a storm'
]

const LENS = [
  '14mm ultra-wide', '24mm', '35mm', '50mm', '85mm at f/1.4', '135mm at f/2',
  '200mm compressed telephoto', '100mm macro', 'a tilt-shift 45mm',
  'a wide 28mm held low'
]

const FILM = [
  'shot on Portra 400', 'on Ektachrome, slightly cool',
  'pushed Tri-X, heavy grain', 'digital, clean and neutral',
  'on expired film with a magenta shift', 'large-format, edge-to-edge sharp',
  'on a disposable camera with flash', 'Cinestill, halated highlights'
]

const LIGHTING = [
  'a single softbox from camera left', 'hard sun through venetian blinds',
  'bounced daylight from a north window', 'practical lamps only, no fill',
  'backlit, subject mostly in silhouette', 'a ring light close in',
  'firelight from below', 'overcast light, no shadows to speak of',
  'a shaft of light through a high window', 'neon spill from a shopfront'
]

const WEATHER = [
  'in steady rain', 'in thin snow', 'under low cloud', 'in sea fog',
  'in dry heat haze', 'after rain, everything still wet', 'in a dust storm',
  'under a clear hard sky'
]

/* ------------------------------------------------------------------ */
/* Vocabulary — drawn and rendered                                     */
/* ------------------------------------------------------------------ */

const MEDIUM = [
  'gouache on cold-press paper', 'a two-colour risograph print',
  'linocut with visible carving marks', 'watercolour with a wet edge',
  'ink and wash', 'coloured pencil on toned paper', 'oil on board, thick paint',
  'cut-paper collage', 'scratchboard, white on black', 'silkscreen, three passes',
  'charcoal, smudged', 'egg tempera'
]

const PALETTE = [
  'a two-colour palette of ochre and deep teal', 'muted earth tones',
  'high-contrast black, white and one red', 'faded pastels',
  'cold blues with a single warm accent', 'a full saturated primary palette',
  'sepia and cream only', 'acid green against charcoal',
  'dusty pink, sand and rust', 'monochrome blue'
]

const ILLUS_STYLE = [
  'in the flat style of mid-century travel posters',
  'like a 1970s science textbook diagram',
  'in the manner of a botanical plate',
  'as a woodblock print',
  'like a childrens picture book spread',
  'in the style of a vintage seed packet',
  'as a technical cutaway drawing',
  'like a hand-painted film poster'
]

const RENDER_3D = [
  'clay render, soft studio light', 'low-poly with flat shading',
  'photoreal 3D with subsurface scattering', 'chrome and frosted glass',
  'felt and knitted wool materials', 'brushed aluminium and walnut',
  'translucent resin lit from within', 'matte plastic, toy-like'
]

/* ------------------------------------------------------------------ */
/* Vocabulary — subjects, by family                                    */
/* ------------------------------------------------------------------ */

const PLACES = [
  'a rain-soaked Tokyo alley', 'a Nevada truck stop', 'a Lisbon tram stop',
  'an empty municipal swimming pool', 'a Hong Kong wet market',
  'a Cornish fishing harbour', 'a Soviet-era bus shelter',
  'a rooftop water tank in Queens', 'an Icelandic petrol station',
  'a Mumbai laundry yard', 'a snowbound Finnish bus stop',
  'a New Orleans corner store', 'a Marrakech dye pit',
  'the loading bay behind a theatre', 'a Berlin U-Bahn platform',
  'a shuttered seaside arcade', 'a Kyoto side street of small bars',
  'a Detroit auto plant floor', 'an Alpine funicular station',
  'a Bangkok canal walkway',
  'a Naples backstreet strung with washing', 'a Reykjavik swimming pool at dawn',
  'a Chicago El platform in winter', 'a Havana barbershop', 'a Seoul night market',
  'a Welsh slate quarry village', 'an Istanbul spice hall', 'a Buenos Aires milonga',
  'a Newfoundland dock in fog', 'a Rajasthan stepwell', 'a Prague tram depot',
  'a Sicilian fish auction', 'a Vancouver container port', 'an Edinburgh close'
]

const LANDSCAPES = [
  'a basalt sea stack', 'wheat fields under a huge sky', 'a tidal salt marsh',
  'a glacial moraine', 'terraced rice paddies', 'a burnt eucalyptus forest',
  'chalk cliffs', 'a braided river delta', 'sand dunes with a single track across them',
  'an alpine tarn', 'mangrove roots at low tide', 'a limestone karst valley',
  'the edge of a caldera', 'boreal forest after fire', 'a frozen reservoir',
  'a slot canyon', 'peat bog with standing water', 'a scree slope above a lake',
  'flooded forest', 'a shingle spit', 'volcanic black sand', 'an oxbow lake from above',
  'salt flats cracked into hexagons', 'a hanging valley', 'ancient olive terraces'
]

const PEOPLE = [
  'a lighthouse keeper', 'a violin maker at her bench', 'a night-shift baker',
  'an elderly beekeeper', 'a teenage skateboarder catching her breath',
  'a fishmonger mid-sentence', 'a retired boxer', 'a market gardener',
  'a chess player deep in thought', 'a welder lifting her mask',
  'a street barber and his customer', 'a librarian on a rolling ladder',
  'a ferry pilot', 'a potter centring clay', 'a cellist tuning',
  'a farrier shoeing a horse', 'a glassblower at the furnace',
  'a lock keeper', 'a puppeteer backstage', 'a bell ringer',
  'a wildland firefighter after a shift', 'a sign painter lettering a window',
  'a bookbinder sewing a spine', 'a shepherd counting a flock', 'a lifeguard off season',
  'a piano tuner listening', 'a diver checking her gauges', 'a stonemason cutting lettering'
]

const OBJECTS = [
  'a single ripe fig, split open', 'a worn leather boot',
  'a stack of vintage cameras', 'a bowl of lemons and a paring knife',
  'an unmade bed in morning light', 'a brass pocket watch, open',
  'a chipped enamel coffee pot', 'a folded newspaper and cold tea',
  'a cracked terracotta pot with a cutting in it', 'a coil of ship rope',
  'a typewriter with a half-finished page', 'a plate of oysters on ice',
  'a bundle of dried lavender', 'a pair of well-used secateurs',
  'a bicycle leaning on a wall',
  'a jar of buttons spilled', 'a dented tin lunchbox', 'a fountain pen and blotting paper',
  'a half-knitted jumper with the needles still in', 'a bowl of walnuts and a nutcracker',
  'a well-thumbed paperback face down', 'a set of dentists tools laid out',
  'a globe with the varnish crazed', 'a single tulip past its best', 'a boxed chess set mid-game'
]

const CREATURES = [
  'a barn owl mid-flight', 'a hare in a ploughed field', 'an octopus changing colour',
  'a herd of reindeer crossing a road', 'a hummingbird at a feeder',
  'a fox on a suburban street at 3am', 'a pod of dolphins under a boat',
  'a stag in morning mist', 'a colony of gannets on a cliff',
  'a sleeping bulldog', 'a heron stalking a shallow', 'a swarm of starlings',
  'a raven on a fencepost', 'a basking shark at the surface', 'a hedgehog crossing a lawn',
  'a flock of sheep filling a lane', 'a kingfisher on a branch', 'a tortoise in long grass',
  'a moth on a lit window', 'a horse shaking off rain'
]

const INTERIORS = [
  'a book-lined study with a cold fireplace', 'a mid-century kitchen, all formica',
  'a monastery refectory', 'a tailor’s workroom', 'a ships galley',
  'a record shop basement', 'a Victorian glasshouse', 'a submarine control room',
  'an observatory dome at night', 'a launderette at midnight',
  'a hotel corridor with too much carpet', 'a village post office',
  'a lighthouse lamp room', 'a school gym set for exams', 'a greasy spoon at 6am',
  'a cathedral crypt', 'a fabric warehouse', 'a puppet workshop',
  'a nuclear bunker canteen', 'a seed library'
]

const IMAGINED = [
  'a lighthouse on a floating island', 'a cathedral grown from coral',
  'a whale skeleton being used as a market hall',
  'a library where the shelves are hedgerows',
  'a train station built inside a hollow tree',
  'a city where every roof is a garden',
  'an observatory carried on the back of a walking machine',
  'a diving bell descending past a sunken cathedral',
  'a windmill farm on the rings of a gas giant',
  'a monastery clinging to a rock spire',
  'a bridge that is also a village', 'a greenhouse orbiting a moon',
  'a clocktower keeping time for a valley of sleepers',
  'a market held on the back of a glacier', 'a hotel built into a dam wall',
  'a forest where the trees are radio masts'
]

const FOOD = [
  'a bowl of ramen with the steam still rising', 'a rough country loaf, torn',
  'a wedge of blue cheese and a knife', 'a plate of grilled sardines',
  'a slice of burnt Basque cheesecake', 'a bowl of cherries with the stems on',
  'a mille-feuille, one slice cut', 'a tagine, lid just lifted',
  'a stack of pancakes with butter melting',
  'a wheel of tomme cut open', 'a bowl of pho with herbs alongside',
  'a tray of cannoli', 'a whole roast chicken resting', 'a bowl of congee with scallion',
  'a summer pudding turned out', 'a plate of jamon carved thin'
]

const SUBJECTS_GRAPHIC = [
  'a coffee roaster', 'a mountain rescue team', 'a small-batch distillery',
  'a marine biology lab', 'a bicycle repair shop', 'a jazz record label',
  'a seed bank', 'an observatory', 'a ferry company', 'a bookbindery',
  'a mushroom farm', 'a lighthouse preservation trust'
]

const MACHINES = [
  'a home lab rack', 'a linotype machine', 'a 1960s reel-to-reel deck',
  'an espresso machine, cut away', 'a mechanical watch movement',
  'a wind turbine nacelle', 'a lunar lander', 'a pipe organ console',
  'a hand-built motorcycle engine', 'a telephone exchange switchboard',
  'a loom mid-weave', 'a printing press', 'a diesel locomotive cab',
  'a church clock mechanism', 'a fairground carousel motor', 'a diving bell',
  'a hand-cranked telephone', 'a seed drill'
]

/**
 * Short qualifiers for the one-clause starters.
 *
 * These exist for range, not decoration. Every hand contains one short line, so
 * the short pool is what decides how soon a repeat is seen — and two-slot
 * templates gave only ~8k of them, which shows a duplicate within a day's use.
 * One more small slot multiplies each of those templates by ten and keeps the
 * line short enough to have been typed. The empty string is a real member: a
 * bare "A Lisbon tram stop at first light" should still come up.
 */
const PHOTO_TAIL = [
  '', ', handheld', ', from above', ', shot from low down', ', close in',
  ', wide', ', tripod, long exposure', ', through glass', ', from across the street',
  ', square crop'
]

const DRAWN_TAIL = [
  '', ', flat colour', ', heavy texture', ', loose and quick', ', very fine line work',
  ', high contrast', ', soft edges', ', limited to three colours',
  ', with visible paper grain', ', bold and simplified'
]

/* ------------------------------------------------------------------ */
/* Templates                                                           */
/* ------------------------------------------------------------------ */

/** A literal string, or a set to choose one from. */
type Part = string | readonly string[]

interface Template {
  /** `simple` is one clause you could have typed yourself; `rich` is a brief. */
  size: 'simple' | 'rich'
  parts: readonly Part[]
}

const TEMPLATES: readonly Template[] = [
  /* -- photographic, simple ---------------------------------------- */
  { size: 'simple', parts: [PLACES, ' at ', HOUR, PHOTO_TAIL] },
  { size: 'simple', parts: [PLACES, ', ', LENS, PHOTO_TAIL] },
  { size: 'simple', parts: [LANDSCAPES, ' ', WEATHER, PHOTO_TAIL] },
  { size: 'simple', parts: [OBJECTS, ' on a windowsill, ', LIGHTING, PHOTO_TAIL] },
  { size: 'simple', parts: ['Portrait of ', PEOPLE, ', ', LENS, PHOTO_TAIL] },
  { size: 'simple', parts: [CREATURES, ', ', LENS, PHOTO_TAIL] },
  { size: 'simple', parts: [FOOD, ', ', LIGHTING, PHOTO_TAIL] },
  { size: 'simple', parts: [INTERIORS, ' at ', HOUR, PHOTO_TAIL] },

  { size: 'simple', parts: [PEOPLE, ' at ', PLACES, PHOTO_TAIL] },
  { size: 'simple', parts: [OBJECTS, ', ', FILM, PHOTO_TAIL] },
  { size: 'simple', parts: [LANDSCAPES, ' at ', HOUR, PHOTO_TAIL] },
  { size: 'simple', parts: [INTERIORS, ', ', LIGHTING, PHOTO_TAIL] },
  { size: 'simple', parts: [CREATURES, ' ', WEATHER, PHOTO_TAIL] },
  { size: 'simple', parts: [IMAGINED, ', ', MEDIUM, DRAWN_TAIL] },
  { size: 'simple', parts: [PLACES, ' ', WEATHER, ', ', FILM] },
  { size: 'simple', parts: [MACHINES, ', ', ILLUS_STYLE, DRAWN_TAIL] },

  /* -- photographic, rich ------------------------------------------ */
  {
    size: 'rich',
    parts: [
      PLACES, ' at ', HOUR, ', ', WEATHER, '. Shot on ', LENS,
      ', ', FILM, '. ', LIGHTING, '. Nobody in frame except one figure walking away.'
    ]
  },
  {
    size: 'rich',
    parts: [
      'Environmental portrait of ', PEOPLE, ' in their own workspace, ',
      LENS, ', ', LIGHTING, ', ', FILM,
      '. They are looking just off camera, mid-task, hands busy and in focus.'
    ]
  },
  {
    size: 'rich',
    parts: [
      LANDSCAPES, ' at ', HOUR, ', ', WEATHER, '. ', LENS,
      ', ', FILM, '. Include something small for scale — a fence post, a figure, a bird.'
    ]
  },
  {
    size: 'rich',
    parts: [
      'Still life: ', OBJECTS, ' on a scarred wooden table, ', LIGHTING,
      ', ', LENS, '. Deep shadows, one bright highlight, everything else falling away.'
    ]
  },
  {
    size: 'rich',
    parts: [
      'Product shot: ', OBJECTS, ' on ',
      ['polished concrete', 'raw oak', 'black slate', 'a linen cloth', 'brushed steel'],
      ', ', LIGHTING, ', 100mm macro. Clean, commercial, plenty of negative space.'
    ]
  },
  {
    size: 'rich',
    parts: [
      INTERIORS, ' at ', HOUR, '. ', LIGHTING, ', ', LENS, ', ', FILM,
      '. Empty of people but obviously just used — a chair pushed back, a cup still out.'
    ]
  },
  {
    size: 'rich',
    parts: [
      'Wildlife photograph of ', CREATURES, ' at ', HOUR, ', ', WEATHER,
      '. ', LENS, '. Long lens, subject sharp, background dissolved to colour.'
    ]
  },
  {
    size: 'rich',
    parts: [
      'Food photograph: ', FOOD, ', ', LIGHTING, ', ',
      ['shot from directly overhead', 'at a low three-quarter angle', 'straight on at table height'],
      ', 100mm macro. Real crumbs, real steam, nothing styled to death.'
    ]
  },

  /* -- illustration ------------------------------------------------- */
  { size: 'simple', parts: [PLACES, ', ', MEDIUM, DRAWN_TAIL] },
  { size: 'simple', parts: [LANDSCAPES, ' in ', PALETTE, DRAWN_TAIL] },
  { size: 'simple', parts: [CREATURES, ', ', MEDIUM, DRAWN_TAIL] },
  {
    size: 'rich',
    parts: [
      PLACES, ' rendered in ', MEDIUM, ', ', PALETTE, ', ', ILLUS_STYLE,
      '. Flat perspective, confident line, no fussy detail.'
    ]
  },
  {
    size: 'rich',
    parts: [
      CREATURES, ' as ', MEDIUM, ', ', PALETTE,
      '. Anatomically careful but stylised, with visible brush or tool marks.'
    ]
  },
  {
    size: 'rich',
    parts: [
      IMAGINED, ', painted in ', MEDIUM, ', ', PALETTE, ', ', ILLUS_STYLE, '.'
    ]
  },
  {
    size: 'rich',
    parts: [
      'A plate from an imaginary field guide: ', CREATURES,
      ', ', MEDIUM, ', ', PALETTE,
      '. Labelled in a neat hand, with two smaller detail studies in the margin.'
    ]
  },

  /* -- graphic and vector ------------------------------------------ */
  { size: 'simple', parts: ['A minimal logo mark for ', SUBJECTS_GRAPHIC, ', flat vector', DRAWN_TAIL] },
  { size: 'simple', parts: ['A travel poster for ', PLACES, ', ', PALETTE, DRAWN_TAIL] },
  {
    size: 'rich',
    parts: [
      'A minimal logo mark for ', SUBJECTS_GRAPHIC,
      ': single weight, flat vector, ', PALETTE,
      '. Geometric, legible at 16 pixels, no gradients and no text.'
    ]
  },
  {
    size: 'rich',
    parts: [
      'A screen-printed gig poster for a band playing at ', PLACES,
      '. ', PALETTE, ', bold display type, heavy ink texture, ', ILLUS_STYLE, '.'
    ]
  },
  {
    size: 'rich',
    parts: [
      'A mid-century travel poster for ', LANDSCAPES,
      ', ', PALETTE, '. Simplified shapes, flat colour, one strong diagonal.'
    ]
  },

  /* -- 3D, isometric, technical ------------------------------------ */
  { size: 'simple', parts: ['Isometric illustration of ', MACHINES, DRAWN_TAIL] },
  { size: 'simple', parts: [MACHINES, ', ', RENDER_3D, DRAWN_TAIL] },
  {
    size: 'rich',
    parts: [
      'Isometric cutaway of ', MACHINES, ', ', RENDER_3D, ', ', PALETTE,
      '. Every component readable, thin outlines, soft ambient occlusion.'
    ]
  },
  {
    size: 'rich',
    parts: [
      'An exploded technical diagram of ', MACHINES,
      ', ', ILLUS_STYLE, ', ', PALETTE,
      '. Parts floating in order along one axis, thin leader lines, no labels.'
    ]
  },
  {
    size: 'rich',
    parts: [
      'A tiny diorama of ', PLACES, ', ', RENDER_3D,
      '. Tilt-shift so it reads as a model, shallow focus, seen from just above.'
    ]
  },

  /* -- imagined and cinematic -------------------------------------- */
  { size: 'simple', parts: [IMAGINED, ' at ', HOUR, PHOTO_TAIL] },
  {
    size: 'rich',
    parts: [
      IMAGINED, ' at ', HOUR, ', ', WEATHER, '. ', LENS, ', ', FILM,
      '. Treated as documentary rather than fantasy — as though someone simply went and photographed it.'
    ]
  },
  {
    size: 'rich',
    parts: [
      'A film still: ', PEOPLE, ' at ', PLACES, ', ', HOUR, '. ',
      LIGHTING, ', ', LENS, ', ', FILM,
      '. Anamorphic framing, the story happening just outside the frame.'
    ]
  },

  /* -- macro and texture ------------------------------------------- */
  {
    size: 'simple',
    parts: [
      'Extreme macro of ',
      ['frost on a window', 'a moth wing', 'rust blooming on steel',
       'the cut face of a log', 'salt crystals forming', 'a peacock feather',
       'cracked dry mud', 'honeycomb', 'a snail shell', 'lichen on granite'],
      ', ', LIGHTING
    ]
  },
  {
    size: 'rich',
    parts: [
      'Extreme macro of ',
      ['frost on a window', 'a moth wing', 'rust blooming on steel',
       'the cut face of a log', 'salt crystals forming', 'a peacock feather',
       'cracked dry mud', 'honeycomb', 'a snail shell', 'lichen on granite'],
      ', ', LIGHTING, ', 100mm macro at f/8, focus stacked. ',
      'Fills the frame, abstract at first glance, ', PALETTE, '.'
    ]
  }
] as const

/* ------------------------------------------------------------------ */
/* Assembly                                                            */
/* ------------------------------------------------------------------ */

function renderTemplate(t: Template, pick: (n: number) => number): string {
  let out = ''
  for (const part of t.parts) {
    out += typeof part === 'string' ? part : part[pick(part.length)]
  }
  // A leading subject arrives lower-case because it is reused mid-sentence
  // elsewhere ("...a film still: a lighthouse keeper at..."). Only the first
  // character is touched, so "a Nevada truck stop" keeps its proper noun.
  return out.charAt(0).toUpperCase() + out.slice(1)
}

/**
 * How many distinct prompts the grammar can produce. Exact, not an estimate.
 *
 * Pass a size to count just that pool. The `simple` figure is the one that
 * governs how often a repeat is actually seen, because every hand is dealt at
 * least one short line — a huge total made mostly of elaborate briefs would
 * still show the same fragments over and over.
 */
export function imagePromptSpaceSize(size?: Template['size']): number {
  return TEMPLATES.filter((t) => size === undefined || t.size === size).reduce((total, t) => {
    const combos = t.parts.reduce(
      (n, p) => (typeof p === 'string' ? n : n * p.length),
      1
    )
    return total + combos
  }, 0)
}

/** Every template rendered with its first choice — for tests and inspection. */
export function imagePromptSamples(): string[] {
  return TEMPLATES.map((t) => renderTemplate(t, () => 0))
}

/**
 * Which workflows deal a generated hand instead of using their fixed list.
 *
 * Deliberately NOT a field on WorkflowDefinition. That object is sent to the
 * renderer through structured clone, which cannot carry a function — putting
 * one there throws "An object could not be cloned" inside `app:getBootstrap`,
 * and the renderer sits on its splash forever with nothing on screen to say
 * why. Keeping the definition pure data and the behaviour in a lookup keeps
 * that door shut.
 */
export const STARTER_GENERATORS: Partial<Record<string, (n: number) => string[]>> = {
  image: (n) => randomImagePrompts(n)
}

/**
 * `n` starter prompts, deliberately mixed: at least one short enough to have
 * been typed by hand, at least one full brief. A page of three elaborate
 * paragraphs is as monotonous as a page of three fragments, and the contrast is
 * itself informative — it shows how much room there is between the two.
 */
export function randomImagePrompts(n: number, rand: () => number = Math.random): string[] {
  const pick = (len: number): number => Math.floor(rand() * len)
  const simple = TEMPLATES.filter((t) => t.size === 'simple')
  const rich = TEMPLATES.filter((t) => t.size === 'rich')

  const wanted: Template[] = []
  if (n >= 2) {
    wanted.push(simple[pick(simple.length)], rich[pick(rich.length)])
  }
  while (wanted.length < n) {
    wanted.push(TEMPLATES[pick(TEMPLATES.length)])
  }

  // Shuffle so the short one is not always first.
  for (let i = wanted.length - 1; i > 0; i--) {
    const j = pick(i + 1)
    ;[wanted[i], wanted[j]] = [wanted[j], wanted[i]]
  }

  const out: string[] = []
  const seen = new Set<string>()
  for (const t of wanted) {
    // A repeated line in a trio of three is very visible; a few retries is
    // cheaper than deduping across a space this size.
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
