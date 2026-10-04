/**
 * What `tools/golden-images` is allowed to reuse.
 *
 * The OCR corpus is a second golden set over the same seed, and two rules from this
 * package have to hold in both or the two sets disagree about what the right answer is:
 *
 * - `truthFor` derives the expected title and primary credit from the seed's own join
 *   phrases rather than by splitting a rendered string.
 * - `isUsable` drops the rows that make bad ground truth no matter how they are drawn —
 *   already-annotated titles above all.
 *
 * Re-deriving either of those in the image generator would be keeping two copies of a
 * subtle rule in step forever, which is the exact failure `truth.ts` was written to
 * avoid. The PRNG is shared for the same reason: one tested implementation of "fixed
 * seed, same output" rather than two.
 *
 * Nothing about *text rendering* is exported. Image documents share no shapes with
 * pasted text, and a renderer reaching across would be the start of one corpus quietly
 * constraining the other.
 */

export { Rng } from './rng.js'
export { loadSeed, type CreditedArtist, type SeedRow } from './seed.js'
export {
  featuredArtists,
  hasFeature,
  isUsable,
  primaryArtist,
  truthFor,
  type Truth,
} from './truth.js'
