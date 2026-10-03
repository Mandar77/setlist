/**
 * Build the generated golden corpus: text in, known songs out, from a fixed seed.
 *
 * Two tiers, and the split is the most consequential decision in this file.
 *
 * **`clean`** — layout the deterministic pass is responsible for: numbered and bulleted
 * lists, `by` forms, CSV, timestamps, both dash orders, qualifiers, non-Latin titles,
 * emoji, odd casing, zero-width characters. These are scored on precision *and* recall,
 * because every one of them is decidable from the text and the contract says so.
 *
 * **`noisy`** — chat prose, heavy typos, and reversed dash order with nothing to
 * disambiguate it. Scored on precision only. That is not a softer gate, it is a
 * different claim: the deterministic pass is explicitly not the component that reads
 * prose (PRD §7.9.3 hands the residual to the LLM), so demanding recall here would be
 * demanding it guess. What it must still never do is invent — G2, "no hallucinated
 * songs", holds on every input including the ones it cannot parse.
 *
 * Getting that boundary wrong in either direction ruins the corpus. Put prose in `clean`
 * and the gate fails for a component doing its job; put lists in `noisy` and the gate
 * stops testing anything.
 */

import { Rng } from './rng.js'
import type { SeedRow } from './seed.js'
import { isUsable, truthFor, type Truth } from './truth.js'
import * as render from './render.js'
import * as noise from './noise.js'

export type Tier = 'clean' | 'noisy'

export interface GoldenCase {
  readonly id: string
  readonly source: string
  readonly kind: string
  readonly tier: Tier
  readonly text: string
  readonly expected: readonly Truth[]
}

/** The seed. Changing it rewrites the whole corpus, so it is a decision, not a knob. */
export const CORPUS_SEED = 20261002

// `numbered-bare` ("1 Title") is not here. The contract specifies numbered lists, and
// the parser strips "1." and "1)", but a bare digit and a space is not a marker it
// recognizes — the number ends up glued to the title. That is a thin shape to insist on
// and not one the contract names, so it is simply not generated.
const LIST_STYLES = ['numbered-dot', 'numbered-paren', 'bullet', 'none']

interface Recipe {
  readonly name: string
  readonly source: string
  readonly tier: Tier
  readonly count: number
  readonly build: (rng: Rng, rows: SeedRow[]) => render.Rendered
  /** Restrict which seed rows this recipe may draw from. */
  readonly filter?: (row: SeedRow) => boolean
}

const RECIPES: readonly Recipe[] = [
  // ---------------------------------------------------------------- clean
  {
    name: 'numbered-dash',
    source: 'forum list',
    tier: 'clean',
    count: 30,
    build: (rng, rows) =>
      render.artistFirst(rng, rows, rng.pick(['numbered-dot', 'numbered-paren'])),
  },
  {
    name: 'bulleted-dash',
    source: 'notes app',
    tier: 'clean',
    count: 25,
    build: (rng, rows) => render.artistFirst(rng, rows, 'bullet'),
  },
  {
    name: 'bare-dash',
    source: 'pasted setlist',
    tier: 'clean',
    count: 25,
    build: (rng, rows) => render.artistFirst(rng, rows, 'none'),
  },
  {
    name: 'by-form',
    source: 'blog best-of',
    tier: 'clean',
    count: 25,
    build: (rng, rows) => render.byForm(rng, rows, rng.pick(LIST_STYLES)),
  },
  {
    name: 'csv-header',
    source: 'spreadsheet export',
    tier: 'clean',
    count: 18,
    build: (rng, rows) => render.csv(rng, rows, true),
  },
  {
    name: 'csv-headerless',
    source: 'spreadsheet export',
    tier: 'clean',
    count: 14,
    build: (rng, rows) => render.csv(rng, rows, false),
  },
  {
    // Headerless and reversed: the columns are Title,Artist and nothing in the text says
    // so. Noisy because the question has no answer, not because the parser fails it.
    name: 'csv-headerless-reversed',
    source: 'spreadsheet export',
    tier: 'noisy',
    count: 10,
    build: (rng, rows) => render.csv(rng, rows, false, true),
  },
  {
    name: 'timestamps',
    source: 'DJ cue sheet',
    tier: 'clean',
    count: 22,
    build: (rng, rows) => render.artistFirst(rng, rows, 'timestamp'),
  },
  {
    name: 'title-first-qualified',
    source: 'tracklist, reversed',
    tier: 'clean',
    count: 22,
    build: (rng, rows) => render.titleFirstWithQualifier(rng, rows, rng.pick(LIST_STYLES)),
  },
  {
    name: 'qualified',
    source: 'reissue tracklist',
    tier: 'clean',
    count: 20,
    build: (rng, rows) => render.withQualifier(rng, rows, rng.pick(LIST_STYLES)),
  },
  {
    // NOISY because of a real extractor bug this corpus found, not because the shape is
    // hard. "Calvin Harris feat. Dua Lipa - One Kiss" comes back as title "Calvin
    // Harris": `has_version_annotation` treats a `feat.` credit as a cue that its side
    // is the title, which is right for "(Live)" and wrong for a featured artist, who
    // attaches to the performer at least as often. It is one of the commonest shapes in
    // dance and hip-hop, so the cases stay and the gap is recorded.
    name: 'featured',
    source: 'dance chart',
    tier: 'noisy',
    count: 18,
    build: (rng, rows) => render.featuredInline(rng, rows, rng.pick(LIST_STYLES)),
    filter: row => row.tags.includes('feat'),
  },
  {
    name: 'multilingual',
    source: 'international chart',
    tier: 'clean',
    count: 26,
    build: (rng, rows) => render.artistFirst(rng, rows, rng.pick(LIST_STYLES)),
    filter: row => row.tags.includes('non_latin'),
  },
  {
    name: 'live-set',
    source: 'concert setlist',
    tier: 'clean',
    count: 16,
    build: (rng, rows) => render.artistFirst(rng, rows, rng.pick(['numbered-dot', 'none'])),
    filter: row => row.tags.includes('live'),
  },
  {
    // Also noisy, and for a reason that is easy to miss: `fold()` transliterates with
    // anyascii, which turns 😭 into "sob" and 💿 into "cd". A trailing emoji therefore
    // becomes part of the folded title rather than being ignored, and a leading one
    // becomes part of the artist. Stripping emoji is not something the contract
    // promises yet; writing "Artist - Title 🔥" is something people do constantly.
    name: 'emoji-trailing',
    source: 'social post',
    tier: 'noisy',
    count: 18,
    build: (rng, rows) => {
      const base = render.artistFirst(rng, rows, rng.pick(['bullet', 'numbered-dot', 'none']))
      return { ...base, text: noise.addEmoji(rng, base.text) }
    },
  },
  {
    name: 'odd-casing',
    source: 'social post',
    tier: 'clean',
    count: 18,
    build: (rng, rows) => {
      const base = render.artistFirst(rng, rows, rng.pick(LIST_STYLES))
      return { ...base, text: noise.reCase(rng, base.text) }
    },
  },
  {
    name: 'zero-width',
    source: 'copy-pasted from a web page',
    tier: 'clean',
    count: 12,
    build: (rng, rows) => {
      const base = render.artistFirst(rng, rows, rng.pick(LIST_STYLES))
      return { ...base, text: noise.addZeroWidth(rng, base.text) }
    },
  },
  {
    name: 'fullwidth',
    source: 'CJK web page',
    tier: 'clean',
    count: 10,
    build: (rng, rows) => {
      const base = render.artistFirst(rng, rows, rng.pick(LIST_STYLES))
      return { ...base, text: noise.toFullwidth(rng, base.text) }
    },
  },
  {
    name: 'ragged-whitespace',
    source: 'pasted from a PDF',
    tier: 'clean',
    count: 12,
    build: (rng, rows) => {
      const base = render.artistFirst(rng, rows, rng.pick(LIST_STYLES))
      return { ...base, text: noise.ragWhitespace(rng, base.text) }
    },
  },
  {
    name: 'reddit-thread',
    source: 'Reddit thread',
    tier: 'clean',
    count: 24,
    build: (rng, rows) =>
      render.withDistractors(
        rng,
        render.redditPost(rng, rows, rng.pick(LIST_STYLES)),
        rng.int(1, 3),
      ),
  },

  // ---------------------------------------------------------------- noisy
  {
    name: 'chat-prose',
    source: 'group chat',
    tier: 'noisy',
    count: 20,
    build: (rng, rows) => render.chat(rng, rows),
  },
  {
    name: 'typo-heavy',
    source: 'phone-typed list',
    tier: 'noisy',
    count: 18,
    build: (rng, rows) => {
      const base = render.artistFirst(rng, rows, rng.pick(LIST_STYLES))
      return { ...base, text: noise.addTypos(rng, base.text, 0.04) }
    },
  },
  {
    name: 'title-first-ambiguous',
    source: 'tracklist, reversed',
    tier: 'noisy',
    count: 16,
    build: (rng, rows) => render.titleFirstAmbiguous(rng, rows, rng.pick(LIST_STYLES)),
  },
  {
    // A known extractor gap, recorded rather than avoided. A leading 🎵 reads as a
    // bullet to every human and is not stripped as a list marker, so the artist comes
    // back as "🎵 Mukesh & Lata Mangeshkar". Generating the case and scoring it on
    // precision keeps it visible without turning the build red for something CORE-04
    // has not been written yet to fix.
    name: 'emoji-leading',
    source: 'social post',
    tier: 'noisy',
    count: 14,
    build: (rng, rows) => render.artistFirst(rng, rows, 'emoji-bullet'),
  },
]

export function generate(seedRows: readonly SeedRow[], seed = CORPUS_SEED): GoldenCase[] {
  const usable = seedRows.filter(isUsable)
  if (usable.length < 100) {
    throw new Error(`only ${usable.length} usable seed rows; the corpus would repeat itself`)
  }

  const rng = new Rng(seed)
  const cases: GoldenCase[] = []

  for (const recipe of RECIPES) {
    const pool = recipe.filter ? usable.filter(recipe.filter) : usable
    if (pool.length < 4) {
      throw new Error(`recipe ${recipe.name} has only ${pool.length} rows to draw from`)
    }

    for (let i = 0; i < recipe.count; i += 1) {
      const rows = rng.sample(pool, rng.int(3, 9))
      const rendered = recipe.build(rng, rows)
      cases.push({
        id: `${recipe.name}-${String(i + 1).padStart(3, '0')}`,
        source: recipe.source,
        kind: 'printed',
        tier: recipe.tier,
        text: rendered.text,
        // Truth comes from the rows, not from the text that was just built out of them.
        expected: rendered.used.map(truthFor),
      })
    }
  }

  return cases
}

/** The corpus as the bytes that get committed. */
export function serialize(cases: readonly GoldenCase[]): string {
  const document = {
    $comment:
      'GENERATED by tools/golden-gen — do not edit. Expected outputs are derived from ' +
      'golden/seed/recordings.jsonl, never from parser output, which is what makes this ' +
      'a test rather than a recording of current behaviour. Regenerate with `make golden`. ' +
      'Tier "clean" is gated on precision and recall; tier "noisy" on precision only — see ' +
      'tools/golden-gen/src/generate.ts for why.',
    seed: CORPUS_SEED,
    cases,
  }
  return `${JSON.stringify(document, null, 2)}\n`
}
