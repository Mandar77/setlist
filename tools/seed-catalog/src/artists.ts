/**
 * The artists the seed is harvested from, chosen rather than found.
 *
 * MBIDs are hardcoded and names are only a comment on them. That is the whole point of a
 * stable identifier: resolving "Daft Punk" by search at harvest time would make the seed
 * depend on MusicBrainz's ranking on the day it ran, and the ranking is not stable. When
 * this list was built, searching "Hikaru Utada" returned **"[Hikaru Utada's son]"** with
 * a score of 100 — a real MusicBrainz entity, top hit, completely wrong. A by-name
 * harvest would have taken it and nobody would have looked.
 *
 * The set is picked to cover what CORE-02 requires the seed to contain, and each entry
 * says which job it is doing. Four things have to appear:
 *
 * * **non-Latin scripts** — not as a token gesture but as a real share of the set, since
 *   the span contract (ADR-007) is about character offsets and NFKC changes length.
 *   Japanese, Korean, Chinese, Cyrillic, Arabic and Greek all appear as an artist's
 *   *primary* name here, not as an alias.
 * * **featured credits** — the dance and hip-hop entries exist for their "feat." joins,
 *   which is a shape the parsers have to split correctly.
 * * **live** — artists with substantial live discographies, so `type=album|live` returns
 *   real live records rather than nothing.
 * * **remasters** — catalogues old enough to have been reissued, which is why the set
 *   leans deliberately old in places.
 *
 * Diacritics are not the same thing as non-Latin and the set treats them separately:
 * Björk, Sigur Rós, Café Tacvba and Youssou N'Dour are Latin script, and they are here
 * because transliteration and fold-to-ASCII are their own failure mode.
 */

export interface SeedArtist {
  readonly mbid: string
  /** MusicBrainz's primary name, for reading this file. The MBID is what is used. */
  readonly name: string
  /** What this entry contributes that the others do not. */
  readonly why: string
}

export const SEED_ARTISTS: readonly SeedArtist[] = [
  // ---- Latin script, deep catalogues with live albums and reissues
  {
    mbid: '056e4f3e-d505-4dad-8ec1-d04f521cbb56',
    name: 'Daft Punk',
    why: 'electronic, short punchy titles, Alive 1997/2007 for live rows',
  },
  {
    mbid: 'a74b1b7f-71a5-4011-9441-d0b5e4122711',
    name: 'Radiohead',
    why: 'titles with punctuation and numerals (15 Step, 2 + 2 = 5)',
  },
  {
    mbid: '0383dadf-2a4e-4d10-a46a-e9e041da8eb3',
    name: 'Queen',
    why: 'heavily remastered catalogue; Live at Wembley and friends',
  },
  {
    mbid: '10adbe5e-a2c0-4bf3-8249-2b4cbf6e6ca8',
    name: 'Massive Attack',
    why: 'guest vocalists, so credits that are genuinely multi-artist',
  },
  {
    mbid: '561d854a-6a28-4aa7-8c99-323e6ce46c2a',
    name: 'Miles Davis',
    why: 'jazz: live records, long titles, decades of remasters',
  },
  {
    mbid: '2944824d-4c26-476f-a981-be849081942f',
    name: 'Nina Simone',
    why: 'live albums and standards covered under many titles',
  },
  {
    mbid: 'bd13909f-1c29-4c27-a874-d4aaf27c5b1a',
    name: 'Fleetwood Mac',
    why: 'reissue-heavy; Rumours alone exists in many remastered editions',
  },

  // ---- Featured credits: the "feat." join is the reason these are here
  {
    mbid: 'e21857d5-3256-4547-afb3-4b6ded592596',
    name: 'Gorillaz',
    why: 'almost every track is a feature; the canonical feat. test case',
  },
  {
    mbid: '8dd98bdc-80ec-4e93-8509-2f46bafc09a7',
    name: 'Calvin Harris',
    why: 'dance records credited "X feat. Y" as a matter of course',
  },
  {
    mbid: '302bd7b9-d012-4360-897a-93b00c855680',
    name: 'David Guetta',
    why: 'same, and often two or three credited guests',
  },
  {
    mbid: '75be165a-ad83-4d12-bd28-f589a15c479f',
    name: 'Major Lazer',
    why: 'features plus titles that carry version labels',
  },

  // ---- Latin script with diacritics: transliteration and folding
  {
    mbid: '87c5dedd-371d-4a53-9f7f-80522fb7f3cb',
    name: 'Björk',
    why: 'ö in the artist name itself, which dedup keys have to fold',
  },
  {
    mbid: 'f6f2326f-6b25-4170-b89d-e235b25508e8',
    name: 'Sigur Rós',
    why: 'Icelandic: ó, æ, þ in titles, and an invented-language album',
  },
  {
    mbid: 'c2b37a39-c66a-44b2-b190-a69485ae5d95',
    name: 'Café Tacvba',
    why: 'Spanish, and a name whose sort form differs from its display form',
  },
  {
    mbid: 'f07dbc2f-317b-470f-bad4-5f1b0eb6faf1',
    name: 'Caetano Veloso',
    why: 'Portuguese: ç, ã, õ across a long catalogue',
  },
  {
    mbid: 'af081ea2-7a2c-4fbd-8200-92d62056b5f5',
    name: 'Youssou N’Dour',
    why: 'a typographic apostrophe inside a name, which NFKC does not touch',
  },
  {
    mbid: '9be2a5ac-8201-489b-b5f6-91f958bf9060',
    name: 'Ali Farka Touré',
    why: 'Malian, frequently in collaborative credits',
  },
  {
    mbid: '1fb60b6c-0f4d-42b4-8a5e-de705ec76660',
    name: 'Amadou & Mariam',
    why: 'an ampersand in the artist name, which is also a credit separator',
  },
  {
    mbid: '5c98fc12-be83-4246-ae5b-2184192913b9',
    name: 'Tinariwen',
    why: 'Tamasheq titles in Latin transcription; unusual letter sequences',
  },

  // ---- Non-Latin scripts, as the artist's primary name
  {
    mbid: 'b539e453-c4fe-47e3-8a07-8517eac74429',
    name: '宇多田ヒカル',
    why: 'Japanese: kanji and katakana in one name, mixed-script titles',
  },
  {
    mbid: 'a7f7df4a-77d8-4f12-8acd-5c60c93f4de8',
    name: '坂本龍一',
    why: 'Japanese, and a catalogue of reissues going back to the 1970s',
  },
  {
    mbid: '0d79fe8e-ba27-4859-bb8c-2f255f346853',
    name: 'BTS',
    why: 'Korean: Hangul titles under a Latin artist name, both scripts at once',
  },
  {
    mbid: 'a223958d-5c56-4b2c-a30a-87e357bc121b',
    name: '周杰倫',
    why: 'Traditional Chinese, where NFKC fullwidth folding actually bites',
  },
  {
    mbid: '064db6e8-fdfb-4acb-a327-fc2de75b37de',
    name: 'Кино',
    why: 'Cyrillic, and a catalogue reissued many times over',
  },
  {
    mbid: '338bbb53-5b96-447a-9444-8906844a0790',
    name: 'فيروز',
    why: 'Arabic: right-to-left, which is where naive span slicing goes wrong',
  },
  {
    mbid: '0a354a70-b879-4697-ad9b-60bfe2bd1d63',
    name: 'أم كلثوم',
    why: 'Arabic, with very long titles and famous live recordings',
  },
  {
    mbid: 'e2b96b55-35c4-45b9-8d7b-726ac927982f',
    name: 'Άννα Βίσση',
    why: 'Greek, a script with its own accent-folding rules',
  },
  {
    mbid: 'aeb71bd8-447d-4415-8ea1-2b7d664f67e1',
    name: 'Lata Mangeshkar',
    why: 'Indian film music: enormous catalogue, many playback credits',
  },
  {
    mbid: '79c5547a-e098-495c-8dac-7e99546aa46b',
    name: 'Asha Bhosle',
    why: 'the same, and frequently credited alongside another singer',
  },
]
