/**
 * Starter ideas for the Image workflow.
 *
 * These are IDEAS, not briefs. An earlier version of this file wrote full
 * photographic specifications — "135mm at f/2, shot on Portra 400, focus
 * stacked" — which is a fine prompt and a terrible suggestion: it answers every
 * question before you have had one, and it only ever suggests photography. What
 * belongs on an empty screen is the thing you had not thought of, said plainly
 * enough that you can take it somewhere yourself. Adding the craft detail is
 * the workflow's own job, and it explains what it added while it does it.
 *
 * So the range matters more than the depth. A hand should be able to deal a
 * photograph, a cartoon, an abstract pattern and a birthday card, because the
 * renderer does all of those and a page of camera settings implies it does not.
 *
 * It is a grammar rather than a list: a few hundred fragments compose into
 * hundreds of thousands of ideas, and `imagePromptSpaceSize()` counts the space
 * exactly, so "thousands" is arithmetic rather than a claim. Vocabulary is
 * scoped to the family that uses it, so a photograph never asks for pixel art
 * and a logo never asks for golden hour.
 *
 * Everything here describes a picture to MAKE. Nothing refers to a previous
 * image or a change to one — this workflow generates, and an edit suggestion on
 * an empty state points at a render that does not exist. There is a test.
 */

/* ------------------------------------------------------------------ */
/* Photographic — plain subjects, light direction                      */
/* ------------------------------------------------------------------ */

const PHOTO_SUBJECTS = [
  'a golden retriever asleep in a sunbeam', 'a bowl of ramen', 'an old bicycle against a wall',
  'a lighthouse in a storm', 'a cat on a windowsill', 'a plate of fresh strawberries',
  'a busy market street', 'a cabin in the snow', 'a violin on a chair',
  'a cup of coffee and a paperback', 'a hot air balloon over fields',
  'a fox in a garden at night', 'a fishing boat coming in', 'a wildflower meadow',
  'a stack of old suitcases', 'a horse in morning mist', 'a rope bridge in a forest',
  'a lemon tree in a courtyard', 'a train crossing a viaduct', 'a jar of honey on a table',
  'a red umbrella in a crowd', 'a barn owl on a fence post', 'a pier at low tide',
  'a bakery window at dawn', 'a hammock between two palm trees',
  'a rainy street seen through a bus window', 'a chess board mid-game',
  'a sheepdog watching a flock', 'a diner counter at midnight', 'a canoe on a still lake',
  'a puppy in a cardboard box', 'a row of colourful front doors',
  'a steaming mug on a frosty morning', 'a child jumping in a puddle',
  'an old typewriter', 'a field of sunflowers', 'a cat stretching on a rug',
  'a pile of autumn leaves', 'a sailboat on the horizon', 'a bowl of fresh eggs',
  'a swing hanging from an oak tree', 'a fishmonger at work', 'a snowy park bench',
  'a bunch of carrots pulled from the ground', 'a vintage camera on a shelf',
  'a cobbled lane after rain', 'a dog shaking off water', 'a wooden pier at sunrise',
  'a greengrocer stall', 'a pair of muddy boots by a door', 'a bee on lavender',
  'a busy café terrace', 'a stack of pancakes on a windowsill',
  'a rowing boat tied up', 'a sleeping baby elephant', 'a windmill in a flat landscape',
  'a spiral staircase from below', 'a heron on a riverbank', 'a bookshelf packed tight',
  'a tram turning a corner'
]

const PHOTO_PLACES = [
  'in Tokyo', 'in a small Italian village', 'on the Scottish coast', 'in Marrakech',
  'in a New York diner', 'in an Icelandic valley', 'in a Paris courtyard',
  'on a Greek island', 'in the Norwegian fjords', 'in a Kyoto garden',
  'in the Australian outback', 'in a Dutch tulip field', 'in a Swiss mountain village',
  'on the Oregon coast', 'in a Lisbon side street',
  'in Havana', 'in a Welsh valley', 'in Seoul', 'in a Cornish harbour',
  'in Istanbul', 'in a Bavarian forest', 'in Mexico City', 'in the Yorkshire dales',
  'in Copenhagen', 'in a Tuscan olive grove'
]

const PHOTO_MOOD = [
  '', ' at sunset', ' in the rain', ' on a foggy morning', ' at night',
  ' in golden afternoon light', ' in the snow', ' at first light',
  ' under a stormy sky', ' on a bright summer day', ' in black and white',
  ' shot from above', ' in soft window light',
  ' in early spring', ' on a windy day', ' under a full moon',
  ' with long shadows', ' on an overcast afternoon', ' in high summer',
  ' just before a thunderstorm'
]

/* ------------------------------------------------------------------ */
/* Drawn and illustrated                                               */
/* ------------------------------------------------------------------ */

const DRAWN_SUBJECTS = [
  'a friendly robot watering plants', 'a cat wearing a tiny hat',
  'a whale swimming through clouds', 'a hedgehog having tea',
  'a dragon curled around a lighthouse', 'a bear riding a bicycle',
  'a fox in a raincoat', 'an owl reading by candlelight',
  'a rocket built out of kitchen things', 'a snail with a mushroom for a shell',
  'a family of ducks crossing a road', 'a wizard who has lost his hat',
  'a penguin running a coffee stand', 'a tortoise carrying a garden on its back',
  'a mouse sailing in a walnut shell', 'a giraffe peering over a fence',
  'a cloud that has been caught in a tree', 'a lion with a very small crown',
  'a badger running a post office', 'a pigeon wearing headphones',
  'a rabbit tending a vegetable patch', 'an elephant balancing a teacup',
  'a crocodile in a knitted jumper', 'a squirrel with an acorn far too big',
  'a frog conducting an orchestra', 'a sloth taking its time on a scooter',
  'a walrus running a barber shop', 'a chicken piloting a paper plane',
  'a bear librarian', 'a llama in sunglasses', 'a hippo doing ballet',
  'a raccoon picking a lock', 'a moose stuck in a doorway',
  'a group of mice building a bridge', 'a swan reading the newspaper',
  'a monkey selling bananas from a cart', 'an octopus juggling teacups',
  'a puffin delivering letters', 'a goat on a very small mountain',
  'a tiger napping in a hammock', 'a seal balancing a beach ball',
  'a dog running a lemonade stand', 'a wolf howling at a lightbulb',
  'a camel crossing a snowy street', 'a peacock at a fancy party'
]

const DRAWN_STYLE = [
  'as a watercolour', 'as a simple flat cartoon', 'as a pencil sketch',
  'in cut-paper collage', 'as pixel art', 'in a childrens book style',
  'as a chalk drawing', 'in bold marker lines', 'as a rubber stamp print',
  'in soft pastels', 'as a stained glass window', 'in a comic book style',
  'as an embroidery design', 'in claymation style',
  'as a linocut print', 'in a retro poster style', 'as a felt-tip doodle',
  'as a screen print', 'in a storybook watercolour style', 'as a paper cut-out puppet',
  'in a woodcut style', 'as a neon sign', 'in a risograph print style',
  'as a mosaic', 'in a Japanese ink style', 'as a knitted pattern'
]

/* ------------------------------------------------------------------ */
/* Things people actually need made                                    */
/* ------------------------------------------------------------------ */

const CARD_OCCASIONS = [
  'a birthday card for a 3 year old boy', 'a birthday card for a 90th',
  'a thank you card', 'a get well soon card', 'a new baby card',
  'a save the date for an autumn wedding', 'a housewarming card',
  'a card for someone starting a new job', 'a retirement card',
  'a card for a first day at school', 'an anniversary card',
  'a sorry-I-forgot card', 'a good luck card for an exam',
  'a congratulations card for passing a driving test',
  'a birthday card for a 5 year old girl', 'a birthday card for a teenager',
  'a Mothers Day card', 'a Fathers Day card', 'a valentines card',
  'a christmas card', 'a card for a new home', 'a leaving card for a colleague',
  'a card for a golden wedding anniversary', 'a card to cheer someone up',
  'a birthday card for a dog owner', 'a card for a graduation',
  'a card welcoming someone back', 'a card for a 40th birthday',
  'an invitation to a garden party', 'an invitation to a childrens party'
]

const CARD_THEME = [
  'with dinosaurs', 'with wildflowers', 'with a hot air balloon',
  'with cats in party hats', 'in gold and navy', 'with a rainbow',
  'with a very small dog', 'in soft pastels', 'with rockets and stars',
  'with a giant slice of cake', 'in a hand-lettered style',
  'with woodland animals', 'with sailing boats', 'with tropical leaves',
  'with balloons', 'with a big friendly monster', 'with hedgehogs',
  'with mountains and pine trees', 'in bright primary colours',
  'with a cup of tea and biscuits', 'with paper aeroplanes',
  'with stars and moons', 'with cactuses', 'with vintage cars',
  'with bees and honeycomb', 'with a very tall cake'
]

const BRANDS = [
  'a coffee shop called Ember', 'a bookshop called Marginalia',
  'a bakery called Second Rise', 'a bike repair shop', 'a plant nursery',
  'a jazz bar called The Blue Room', 'a hiking club', 'a pottery studio',
  'an ice cream van', 'a dog grooming service', 'a board game café',
  'a swimming club', 'a hot sauce company', 'a stargazing society',
  'a ramen bar called Slurp', 'a climbing gym', 'a vintage record shop',
  'a soap maker', 'a surf school', 'a family dentist', 'a taco truck',
  'an independent cinema', 'a knitting supply shop', 'a rescue dog charity',
  'a mushroom foraging tour', 'a village pub called The Crooked Oak',
  'a skate shop', 'a florist called Stem'
]

const DESIGN_JOBS = [
  'a logo', 'a poster', 'a shop sign', 'a business card', 'a tote bag design',
  'an enamel pin', 'a menu header', 'a sticker', 'a t-shirt print',
  'a matchbox label', 'a coffee cup sleeve', 'a van livery',
  'a book cover', 'an album cover', 'a bookmark', 'a beer label',
  'a jam jar label', 'a badge', 'a shopfront awning', 'a keyring design',
  'a mug design', 'a wrapping paper design'
]

const POSTER_EVENTS = [
  'a summer music festival', 'a village fete', 'a film noir season',
  'a farmers market', 'a charity fun run', 'a science fair',
  'an open mic night', 'a winter craft fair', 'a school play',
  'a beekeeping workshop', 'a night at the observatory', 'a chilli cook-off',
  'a jazz night', 'a dog show', 'a plant swap', 'a cycling race',
  'a bonfire night', 'a poetry reading', 'a food truck rally',
  'a christmas market', 'a life drawing class', 'a beach clean-up',
  'a table tennis tournament', 'a folk festival'
]

/* ------------------------------------------------------------------ */
/* Abstract and pattern                                                */
/* ------------------------------------------------------------------ */

const ABSTRACT = [
  'waves of blue and gold', 'overlapping circles', 'a slow gradient from dusk to dawn',
  'torn paper edges', 'ink spreading in water', 'soft folded fabric',
  'sharp geometric shapes', 'scattered confetti', 'concentric ripples',
  'drifting smoke', 'cracked glaze', 'looping ribbons', 'shifting sand ridges',
  'a tangle of thin lines', 'stacked translucent panes',
  'nested arches', 'a grid slowly falling apart', 'melting stripes',
  'blooming ink flowers', 'stacked pebbles', 'frosted glass shapes',
  'a spiral of small dots', 'crumpled foil', 'woven threads',
  'floating soap bubbles', 'layered paper cutouts', 'a starburst of lines'
]

const ABSTRACT_COLOUR = [
  'in pastel colours', 'in black and white', 'in warm reds and oranges',
  'in deep sea blues', 'in a single shade of green', 'in bright primaries',
  'in dusty pinks and browns', 'in metallic gold and cream',
  'in neon on black', 'in muted earth tones',
  'in soft lilac and grey', 'in autumn colours', 'in teal and coral',
  'in monochrome blue', 'in sunset oranges and purples', 'in forest greens and browns'
]

const PATTERN_USES = [
  'wrapping paper', 'a phone wallpaper', 'a fabric print', 'wallpaper for a nursery',
  'a tile design', 'a book cover background', 'a scarf print', 'a notebook cover',
  'a duvet cover', 'a set of coasters', 'a laptop skin', 'a lunchbox design',
  'a tea towel', 'a jigsaw puzzle'
]

/* ------------------------------------------------------------------ */
/* Places to be, imagined                                              */
/* ------------------------------------------------------------------ */

const IMAGINED_PLACES = [
  'a cosy bookshop on a rainy afternoon', 'a treehouse village in a redwood forest',
  'a floating market above the clouds', 'a library inside a hollow mountain',
  'a lighthouse keepers kitchen', 'a train station on the moon',
  'an underwater greenhouse', 'a bakery run entirely by cats',
  'a garden growing on a rooftop in winter', 'a workshop full of half-built clocks',
  'a tiny island with one tree and one house', 'a night market on a frozen lake',
  'a cathedral made of coral', 'a bus stop at the edge of a desert',
  'a hotel built into a waterfall',
  'a post office at the bottom of the sea', 'a village built into a cliff face',
  'a greenhouse on a moving train', 'a bookshop that is bigger inside',
  'a lighthouse made of stacked books', 'a bakery on the back of a whale',
  'a city where everyone travels by hot air balloon',
  'a laundrette on the edge of space', 'a forest of glass trees',
  'a clock tower that has grown roots', 'an island shaped like a sleeping cat',
  'a train that runs along the sea floor', 'a hotel for migrating birds',
  'a market where the stalls are boats'
]

const ROOMS = [
  'a cosy reading nook', 'a cluttered artists studio', 'a mid-century kitchen',
  'a greenhouse in winter', 'a childs bedroom full of space posters',
  'a tiny cabin interior', 'a record shop', 'an old bookshop',
  'a potting shed', 'a jazz club after closing',
  'a workshop full of tools', 'a bright modern kitchen', 'a childs playroom',
  'a tailors shop', 'a village library', 'a garden shed in summer',
  'a cosy pub snug', 'an artists attic', 'a florist shop', 'a tea room'
]

/* ------------------------------------------------------------------ */
/* Characters and worlds                                               */
/* ------------------------------------------------------------------ */

const CHARACTERS = [
  'a retired space pilot', 'a young inventor with too many pockets',
  'a friendly swamp monster', 'a knight who is afraid of horses',
  'a lighthouse keeper and her dog', 'a market trader selling maps',
  'a robot learning to garden', 'a witch running a bakery',
  'a deep sea diver meeting something enormous', 'a chef in a floating kitchen',
  'a librarian who guards one very dangerous book', 'a courier crossing a desert',
  'a very small giant', 'a detective who is also a cat',
  'a gardener who talks to bees', 'a pirate who gets seasick',
  'an astronaut on their first day', 'a baker who bakes at midnight',
  'a mapmaker who has never travelled', 'a mechanic with a robot arm',
  'a shepherd with a very clever dog', 'a clockmaker running late',
  'a postman on a mountain route', 'a chef who cooks only soup',
  'a diver who collects lost things', 'a musician playing to nobody',
  'a beekeeper in a spacesuit', 'a knight on a very small pony'
]

const CHARACTER_STYLE = [
  'as a character design sheet', 'in a Studio Ghibli feeling',
  'as a comic book panel', 'as a friendly cartoon',
  'in a painted fantasy style', 'as a simple vector mascot',
  'in a retro sci-fi paperback style', 'as a claymation figure',
  'as a pixel art sprite', 'as a wooden puppet',
  'in a watercolour storybook style', 'as a linocut print',
  'in a bold graphic novel style', 'as a plush toy', 'as a paper doll',
  'in a 1950s cartoon style'
]

const CHARACTER_SETTING = [
  '', ' at work', ' on a rainy day', ' in a cluttered workshop',
  ' halfway up a mountain', ' waiting for a bus', ' surrounded by cats',
  ' on a small boat', ' in a busy market', ' at the end of a long day',
  ' in a snowstorm', ' packing for a trip'
]

/* ------------------------------------------------------------------ */
/* Isometric, 3D and diagrams                                          */
/* ------------------------------------------------------------------ */

const ISO_SUBJECTS = [
  'a tiny coffee shop', 'a home office', 'a fire station', 'a rooftop garden',
  'a recording studio', 'a corner shop', 'a train carriage', 'a bakery kitchen',
  'a lighthouse', 'a campsite', 'a bookshop', 'a greenhouse',
  'a flower shop', 'a barbershop', 'a music shop', 'a pizza place',
  'a vet surgery', 'a workshop', 'a tiny apartment', 'a lifeboat station'
]

const THREE_D_LOOK = [
  'as a tiny isometric scene', 'as a soft clay model', 'in low-poly 3D',
  'as a paper craft model', 'as a cutaway diagram', 'as a miniature diorama',
  'as a felt model', 'as a wooden toy', 'as a tiny model village'
]

/* ------------------------------------------------------------------ */
/* Food                                                                */
/* ------------------------------------------------------------------ */

const DISHES = [
  'a stack of pancakes with syrup', 'a bowl of pho', 'a slice of lemon tart',
  'a roast dinner', 'a plate of tacos', 'a cheese board',
  'a bowl of cherries', 'a birthday cake with candles lit',
  'fresh bread torn open', 'a bowl of tomato soup and toast',
  'a tray of cinnamon buns', 'an ice cream cone melting',
  'a bowl of noodles', 'a full english breakfast', 'a plate of dumplings',
  'a fruit tart', 'a bowl of curry and rice', 'a sandwich cut in half',
  'a doughnut with sprinkles', 'a pot of stew', 'a bowl of porridge and berries',
  'a slice of pizza being lifted'
]

const FOOD_TREATMENT = [
  'photographed from above', 'in soft daylight', 'as a watercolour',
  'as a recipe card illustration', 'close up and steaming',
  'on a dark background', 'as a flat cartoon', 'on a checked tablecloth',
  'as a menu illustration', 'in bright colours on white',
  'as a pencil drawing', 'with steam rising'
]

/* ------------------------------------------------------------------ */
/* Templates                                                           */
/* ------------------------------------------------------------------ */

type Part = string | readonly string[]

interface Template {
  /** `simple` is a bare idea; `rich` gives it one line of direction. */
  size: 'simple' | 'rich'
  parts: readonly Part[]
}

const TEMPLATES: readonly Template[] = [
  /* -- photographic -------------------------------------------------- */
  { size: 'simple', parts: [PHOTO_SUBJECTS, PHOTO_MOOD] },
  { size: 'simple', parts: [PHOTO_SUBJECTS, ' ', PHOTO_PLACES] },
  { size: 'rich', parts: [PHOTO_SUBJECTS, ' ', PHOTO_PLACES, PHOTO_MOOD] },
  { size: 'simple', parts: ['A street scene ', PHOTO_PLACES, PHOTO_MOOD] },
  { size: 'rich', parts: ['A photo of ', DISHES, ', ', FOOD_TREATMENT] },
  { size: 'simple', parts: [DISHES, ', ', FOOD_TREATMENT] },

  /* -- drawn and illustrated ---------------------------------------- */
  { size: 'simple', parts: [DRAWN_SUBJECTS] },
  { size: 'rich', parts: ['Draw ', DRAWN_SUBJECTS, ', ', DRAWN_STYLE] },
  { size: 'simple', parts: [DRAWN_SUBJECTS, ', ', DRAWN_STYLE] },
  { size: 'rich', parts: [IMAGINED_PLACES, ', ', DRAWN_STYLE] },

  /* -- cards and occasions ------------------------------------------ */
  { size: 'simple', parts: ['Draw me ', CARD_OCCASIONS] },
  { size: 'rich', parts: ['Draw me ', CARD_OCCASIONS, ', ', CARD_THEME] },
  { size: 'rich', parts: ['Design ', CARD_OCCASIONS, ' ', CARD_THEME, ', ', DRAWN_STYLE] },

  { size: 'simple', parts: ['Draw me ', CARD_OCCASIONS, ' ', CARD_THEME] },

  /* -- design jobs --------------------------------------------------- */
  { size: 'simple', parts: ['Design ', DESIGN_JOBS, ' for ', BRANDS] },
  { size: 'rich', parts: ['Design ', DESIGN_JOBS, ' for ', BRANDS, ', ', ABSTRACT_COLOUR] },
  { size: 'simple', parts: ['A poster for ', POSTER_EVENTS] },
  { size: 'rich', parts: ['A poster for ', POSTER_EVENTS, ', ', ABSTRACT_COLOUR] },
  { size: 'rich', parts: ['A poster for ', POSTER_EVENTS, ', ', DRAWN_STYLE] },

  /* -- abstract and pattern ----------------------------------------- */
  { size: 'simple', parts: ['Something abstract: ', ABSTRACT, ' ', ABSTRACT_COLOUR] },
  { size: 'simple', parts: [ABSTRACT, ' ', ABSTRACT_COLOUR] },
  { size: 'rich', parts: ['A repeating pattern of ', ABSTRACT, ' ', ABSTRACT_COLOUR,
                          ', for ', PATTERN_USES] },
  { size: 'rich', parts: ['A design for ', PATTERN_USES, ': ', ABSTRACT, ' ', ABSTRACT_COLOUR] },

  { size: 'simple', parts: ['A design for ', PATTERN_USES, ': ', ABSTRACT] },

  /* -- places and rooms --------------------------------------------- */
  { size: 'simple', parts: [IMAGINED_PLACES] },
  { size: 'rich', parts: [IMAGINED_PLACES, PHOTO_MOOD] },
  { size: 'simple', parts: [ROOMS, PHOTO_MOOD] },
  { size: 'rich', parts: [ROOMS, ', ', DRAWN_STYLE] },

  /* -- characters ---------------------------------------------------- */
  { size: 'simple', parts: [CHARACTERS, CHARACTER_SETTING] },
  { size: 'rich', parts: [CHARACTERS, CHARACTER_SETTING, ', ', CHARACTER_STYLE] },
  { size: 'rich', parts: ['Design a character: ', CHARACTERS, CHARACTER_SETTING, ', ', CHARACTER_STYLE] },

  { size: 'simple', parts: ['Design a character: ', CHARACTERS, CHARACTER_SETTING] },

  /* -- isometric and 3D ---------------------------------------------- */
  { size: 'simple', parts: [ISO_SUBJECTS, ' ', THREE_D_LOOK] },
  { size: 'rich', parts: [ISO_SUBJECTS, ' ', THREE_D_LOOK, ', ', ABSTRACT_COLOUR] }
] as const

/* ------------------------------------------------------------------ */
/* Assembly                                                            */
/* ------------------------------------------------------------------ */

/** How many distinct strings a template can produce. */
function combosOf(t: Template): number {
  return t.parts.reduce((n, p) => (typeof p === 'string' ? n : n * p.length), 1)
}

/**
 * Choose a template, weighted so the tiny ones do not dominate the repeats.
 *
 * Picking uniformly looked right and was not: "A poster for a dog show" has 24
 * possible fillings and the photographic template has over a thousand, yet both
 * came up equally often, so nearly every repeat a user saw came from the small
 * templates. Measured, that put a duplicate in 74% of forty-visit runs.
 *
 * Weighting by the SQUARE ROOT of the space rather than the space itself is the
 * compromise that matters here. Straight proportional weighting fixes repeats
 * and flattens the variety — the handful of large photographic templates would
 * crowd out cards, logos and abstracts, which is the opposite of the point.
 * Square root pulls the extremes together while keeping every kind visible.
 */
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

/**
 * How many distinct ideas the grammar can produce. Exact, not an estimate.
 *
 * Pass a size to count just that pool. The `simple` figure is the one that
 * governs how often a repeat is actually seen, because every hand is dealt at
 * least one short line.
 */
export function imagePromptSpaceSize(size?: Template['size']): number {
  return TEMPLATES.filter((t) => size === undefined || t.size === size)
    .reduce((total, t) => total + combosOf(t), 0)
}

/** Every template at its first choice — for tests and inspection. */
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
 * `n` starter ideas, deliberately mixed: at least one bare idea and at least
 * one with a line of direction on it. A hand of three that are all the same
 * shape reads as one suggestion repeated, and the contrast is itself useful —
 * it shows there is no required amount of detail.
 */
export function randomImagePrompts(n: number, rand: () => number = Math.random): string[] {
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
