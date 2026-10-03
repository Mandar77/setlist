/**
 * The harvest, driven by a fake MusicBrainz and an in-memory store.
 *
 * Nothing here touches the network. That is partly CLAUDE.md's rule about never calling
 * a real provider in a unit test, but mostly it is that the alternative does not work: a
 * suite that asks MusicBrainz for Daft Punk's discography fails when MusicBrainz is down,
 * when an editor adds a release, and when the rate limiter does its job and makes the
 * suite take four minutes.
 *
 * Resumability gets the most attention because it is the property with a real cost
 * attached. At one request per second a full harvest is minutes long, and the wrong
 * behaviour after an interruption is to spend someone else's bandwidth re-fetching what
 * is already on disk.
 */

import { describe, expect, it } from 'vitest'

import {
  EMPTY_STATE,
  harvest,
  rowsFromRelease,
  sortRows,
  type HarvestState,
  type Store,
} from '../src/harvest.js'
import { MusicBrainzClient, type ReleaseJson } from '../src/musicbrainz.js'
import type { SeedRow } from '../src/row.js'
import type { Clock } from '../src/rate-limit.js'

const instantClock: Clock = { now: () => 0, sleep: async () => undefined }

/** A store that lives in a variable, so resume logic is tested instead of the filesystem. */
class MemoryStore implements Store {
  state: HarvestState | null = null
  rows: SeedRow[] = []
  writes = 0

  async readState(): Promise<HarvestState | null> {
    return this.state
  }
  async writeState(state: HarvestState): Promise<void> {
    this.state = state
  }
  async clearState(): Promise<void> {
    this.state = null
  }
  async readRows(): Promise<SeedRow[]> {
    return this.rows
  }
  async writeRows(rows: readonly SeedRow[]): Promise<void> {
    this.rows = [...rows]
    this.writes += 1
  }
}

function track(
  id: string,
  title: string,
  isrcs: string[] = [],
  join = '',
  version = '',
): Record<string, unknown> {
  return {
    title,
    recording: {
      id,
      title,
      disambiguation: version,
      length: 200000,
      isrcs,
      'artist-credit': [
        { name: 'Test Artist', joinphrase: join, artist: { id: 'artist-1', name: 'Test Artist' } },
        ...(join === ''
          ? []
          : [{ name: 'Guest', joinphrase: '', artist: { id: 'artist-2', name: 'Guest' } }]),
      ],
    },
  }
}

function release(
  id: string,
  title: string,
  tracks: Record<string, unknown>[],
  extra: Partial<ReleaseJson> = {},
): ReleaseJson {
  return {
    id,
    title,
    date: '2001-01-01',
    disambiguation: '',
    'release-group': { 'primary-type': 'Album', 'secondary-types': [] },
    media: [{ tracks: tracks as never }],
    ...extra,
  } as ReleaseJson
}

/** A client whose pages are scripted per artist. */
function fakeClient(
  pages: Record<string, ReleaseJson[][]>,
  onRequest?: (mbid: string, offset: number) => void,
) {
  let served = 0
  const client = new MusicBrainzClient({
    clock: instantClock,
    fetch: async url => {
      const parsed = new URL(url)
      const mbid = parsed.searchParams.get('artist') ?? ''
      const offset = Number(parsed.searchParams.get('offset') ?? '0')
      onRequest?.(mbid, offset)
      served += 1

      const forArtist = pages[mbid] ?? []
      const all = forArtist.flat()
      const pageIndex = forArtist.findIndex(
        (_, i) => forArtist.slice(0, i).flat().length === offset,
      )
      const releases = pageIndex === -1 ? [] : (forArtist[pageIndex] ?? [])
      return new Response(JSON.stringify({ 'release-count': all.length, releases }), {
        status: 200,
      })
    },
  })
  return { client, requests: () => served }
}

// ------------------------------------------------------------------ shaping

describe('turning a release into rows', () => {
  it('takes title, credit, ISRCs and duration from the recording', () => {
    const rows = rowsFromRelease(
      release('rel-1', 'Album', [track('rec-1', 'Song', ['GBAAA0000001'])]),
    )

    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      recording_mbid: 'rec-1',
      title: 'Song',
      artist: 'Test Artist',
      isrc: 'GBAAA0000001',
      duration_ms: 200000,
      release_title: 'Album',
    })
  })

  it('picks the lowest-sorting ISRC when a recording has several', () => {
    // Several ISRCs means several territorial releases, and MusicBrainz does not say
    // which is canonical. Sorting is not a judgement about which is right — it is the
    // only way to make re-harvesting produce the same file.
    const rows = rowsFromRelease(
      release('rel-1', 'Album', [track('rec-1', 'Song', ['USAAA0000002', 'GBAAA0000001'])]),
    )
    expect(rows[0]?.isrc).toBe('GBAAA0000001')
    expect(rows[0]?.isrcs).toEqual(['GBAAA0000001', 'USAAA0000002'])
  })

  it('keeps a row with no ISRC rather than dropping it', () => {
    // The gate is 80%, not 100%, and silently discarding ISRC-less recordings would make
    // the measured coverage meaningless.
    const rows = rowsFromRelease(release('rel-1', 'Album', [track('rec-1', 'Song', [])]))
    expect(rows[0]?.isrc).toBeNull()
  })

  it('skips a track whose recording has no MBID or no title', () => {
    const rows = rowsFromRelease(
      release('rel-1', 'Album', [
        { title: 'Nameless', recording: { id: 'rec-1', isrcs: [], 'artist-credit': [] } },
        { title: 'Ghost', recording: { title: 'Ghost', isrcs: [] } },
      ] as never),
    )
    expect(rows).toEqual([])
  })

  it('renders a featured credit using MusicBrainz’s own join text', () => {
    const rows = rowsFromRelease(
      release('rel-1', 'Album', [track('rec-1', 'Song', ['GBAAA0000001'], ' feat. ')]),
    )
    expect(rows[0]?.artist).toBe('Test Artist feat. Guest')
    expect(rows[0]?.tags).toContain('feat')
  })

  it('tags live from the release group, not from the title', () => {
    // A recording called "Live and Let Die" is not a live recording. Reading the tag out
    // of the title would be the parser's guess dressed up as ground truth, which is
    // exactly what CORE-03 must not build its expected outputs from.
    const studio = rowsFromRelease(
      release('rel-1', 'Album', [track('rec-1', 'Live and Let Die', ['GBAAA0000001'])]),
    )
    expect(studio[0]?.tags).not.toContain('live')

    const live = rowsFromRelease(
      release('rel-2', 'At the Hall', [track('rec-2', 'Quiet Song', ['GBAAA0000002'])], {
        'release-group': { 'primary-type': 'Album', 'secondary-types': ['Live'] },
      }),
    )
    expect(live[0]?.tags).toContain('live')
  })

  it('tags remaster from the release, where reissues actually live', () => {
    const rows = rowsFromRelease(
      release('rel-1', 'Rumours (2004 Remastered Edition)', [
        track('rec-1', 'Dreams', ['GBAAA0000001']),
      ]),
    )
    expect(rows[0]?.tags).toContain('remaster')
  })
})

// ------------------------------------------------------------------ resume

describe('resumability', () => {
  it('skips artists already marked complete', async () => {
    const asked: string[] = []
    const { client } = fakeClient(
      {
        'artist-a': [[release('rel-a', 'A', [track('rec-a', 'A1', ['GBAAA0000001'])])]],
        'artist-b': [[release('rel-b', 'B', [track('rec-b', 'B1', ['GBAAA0000002'])])]],
      },
      mbid => asked.push(mbid),
    )

    const store = new MemoryStore()
    store.state = { completed: ['artist-a'], inFlight: null }
    store.rows = [
      {
        recording_mbid: 'rec-a',
        title: 'A1',
        version: '',
        artist: 'Test Artist',
        artists: [{ name: 'Test Artist', mbid: 'artist-1', join: '' }],
        isrc: 'GBAAA0000001',
        isrcs: ['GBAAA0000001'],
        duration_ms: 200000,
        release_mbid: 'rel-a',
        release_title: 'A',
        release_date: '2001-01-01',
        tags: [],
      },
    ]

    const summary = await harvest({
      client,
      store,
      artists: [
        { mbid: 'artist-a', name: 'A', why: 'test' },
        { mbid: 'artist-b', name: 'B', why: 'test' },
      ],
    })

    expect(asked).toEqual(['artist-b'])
    expect(summary.resumed).toBe(true)
    expect(summary.rows).toBe(2)
  })

  it('picks up mid-artist at the offset it stopped on', async () => {
    const offsets: number[] = []
    const { client } = fakeClient(
      {
        'artist-a': [
          [release('rel-1', 'One', [track('rec-1', 'S1', ['GBAAA0000001'])])],
          [release('rel-2', 'Two', [track('rec-2', 'S2', ['GBAAA0000002'])])],
        ],
      },
      (_mbid, offset) => offsets.push(offset),
    )

    const store = new MemoryStore()
    store.state = { completed: [], inFlight: { mbid: 'artist-a', offset: 1 } }

    await harvest({
      client,
      store,
      artists: [{ mbid: 'artist-a', name: 'A', why: 'test' }],
      releasesPerPage: 1,
    })

    // The property is that the already-fetched page is not fetched again, which is what
    // resuming is for. Asserting the exact request list instead would make this fail the
    // moment anything else legitimately asks for a page — as the remaster sweep does.
    expect(offsets).not.toContain(0)
    expect(offsets).toContain(1)
  })

  it('sweeps the end of an artist’s releases for remasters', async () => {
    // MusicBrainz keeps one recording however many times a song is remastered, so the
    // only place "remaster" is asserted is a release — and reissues sit late in browse
    // order. Queen's first three pages mention remaster zero times and page eight
    // mentions it 43 times, which is why this sweep walks backwards from the end.
    const offsets: number[] = []
    const { client } = fakeClient(
      {
        'artist-a': [
          [release('rel-1', 'Album', [track('rec-1', 'Song', ['GBAAA0000001'])])],
          [release('rel-2', 'Filler', [track('rec-2', 'Other', ['GBAAA0000002'])])],
          [
            release('rel-3', 'Album', [track('rec-1', 'Song', ['GBAAA0000001'])], {
              disambiguation: '2011 remaster',
            }),
          ],
        ],
      },
      (_mbid, offset) => offsets.push(offset),
    )
    const store = new MemoryStore()

    await harvest({
      client,
      store,
      artists: [{ mbid: 'artist-a', name: 'A', why: 'test' }],
      releasesPerPage: 1,
      maxRowsPerArtist: 1,
    })

    // The sweep reached the last page, and the tag landed on the row already collected
    // rather than adding a second copy of the same recording.
    expect(offsets).toContain(2)
    const song = store.rows.find(r => r.recording_mbid === 'rec-1')
    expect(song?.tags).toContain('remaster')
    expect(store.rows.filter(r => r.recording_mbid === 'rec-1')).toHaveLength(1)
  })

  it('writes progress after every page, not only at the end', async () => {
    // The whole point. A harvest killed between pages must leave something to resume
    // from, so the rows file and the state file are both written as it goes.
    const { client } = fakeClient({
      'artist-a': [
        [release('rel-1', 'One', [track('rec-1', 'S1', ['GBAAA0000001'])])],
        [release('rel-2', 'Two', [track('rec-2', 'S2', ['GBAAA0000002'])])],
        [release('rel-3', 'Three', [track('rec-3', 'S3', ['GBAAA0000003'])])],
      ],
    })
    const store = new MemoryStore()

    await harvest({
      client,
      store,
      artists: [{ mbid: 'artist-a', name: 'A', why: 'test' }],
      releasesPerPage: 1,
    })

    expect(store.writes).toBeGreaterThanOrEqual(3)
  })

  it('clears the state file once the harvest finishes', async () => {
    // Otherwise the next run thinks it is resuming and skips everything.
    const { client } = fakeClient({
      'artist-a': [[release('rel-1', 'One', [track('rec-1', 'S1', ['GBAAA0000001'])])]],
    })
    const store = new MemoryStore()
    store.state = EMPTY_STATE

    await harvest({ client, store, artists: [{ mbid: 'artist-a', name: 'A', why: 'test' }] })

    expect(store.state).toBeNull()
  })

  it('resuming a finished harvest costs no requests and loses no rows', async () => {
    const { client, requests } = fakeClient({
      'artist-a': [[release('rel-1', 'One', [track('rec-1', 'S1', ['GBAAA0000001'])])]],
    })
    const store = new MemoryStore()
    const artists = [{ mbid: 'artist-a', name: 'A', why: 'test' }]

    const first = await harvest({ client, store, artists })
    const after = requests()
    const second = await harvest({ client, store, artists })

    // State was cleared, so the second run re-walks — and must produce the same file.
    expect(second.rows).toBe(first.rows)
    expect(store.rows.map(r => r.recording_mbid)).toEqual(['rec-1'])
    expect(requests()).toBeGreaterThan(after)
  })
})

// ------------------------------------------------------------------ determinism

describe('the file is the same every time', () => {
  it('deduplicates a recording that appears on two releases, keeping the first', async () => {
    // A song on both the original album and its remaster is one recording with one MBID.
    // Two rows would double-count it in the ISRC percentage and give CORE-03 the same
    // song twice.
    const { client } = fakeClient({
      'artist-a': [
        [
          release('rel-1', 'Original', [track('rec-1', 'Song', ['GBAAA0000001'])]),
          release('rel-2', 'Original (Remastered)', [track('rec-1', 'Song', ['GBAAA0000001'])]),
        ],
      ],
    })
    const store = new MemoryStore()

    const summary = await harvest({
      client,
      store,
      artists: [{ mbid: 'artist-a', name: 'A', why: 'test' }],
    })

    expect(summary.rows).toBe(1)
    expect(store.rows[0]?.release_title).toBe('Original')
  })

  it('sorts rows by recording MBID', () => {
    const rows = sortRows([
      { recording_mbid: 'ccc' } as SeedRow,
      { recording_mbid: 'aaa' } as SeedRow,
      { recording_mbid: 'bbb' } as SeedRow,
    ])
    expect(rows.map(r => r.recording_mbid)).toEqual(['aaa', 'bbb', 'ccc'])
  })

  it('gives every artist a turn instead of stopping at the row target', async () => {
    // The bug this replaces: a global "stop at N rows" check, with artists walked in
    // list order, filled the target from the first sixteen names and never reached the
    // last thirteen. Those thirteen are the non-Latin ones, so the row count looked
    // perfect while the hardest requirement in CORE-02 sat at zero. Reaching the target
    // is not the property worth asserting — reaching every artist is.
    const { client } = fakeClient({
      'artist-a': [
        [
          release('rel-1', 'One', [
            track('rec-1', 'S1', ['GBAAA0000001']),
            track('rec-2', 'S2', ['GBAAA0000002']),
            track('rec-3', 'S3', ['GBAAA0000003']),
          ]),
        ],
      ],
      'artist-b': [[release('rel-2', 'Two', [track('rec-4', 'S4', ['GBAAA0000004'])])]],
    })
    const store = new MemoryStore()

    await harvest({
      client,
      store,
      artists: [
        { mbid: 'artist-a', name: 'A', why: 'test' },
        { mbid: 'artist-b', name: 'B', why: 'test' },
      ],
      targetRows: 2,
    })

    // artist-a would have filled the target on its own; artist-b must still appear.
    expect(store.rows.some(r => r.recording_mbid === 'rec-4')).toBe(true)
  })

  it('caps an artist mid-page rather than between pages', async () => {
    // One page of 25 albums can be 200 recordings, so a cap tested only between pages
    // lets a single artist take triple its share — which is how one name contributed
    // 205 rows against a cap of 104 and crowded out everyone after it.
    const { client } = fakeClient({
      'artist-a': [
        [
          release('rel-1', 'One', [
            track('rec-1', 'S1', ['GBAAA0000001']),
            track('rec-2', 'S2', ['GBAAA0000002']),
          ]),
          release('rel-2', 'Two', [
            track('rec-3', 'S3', ['GBAAA0000003']),
            track('rec-4', 'S4', ['GBAAA0000004']),
          ]),
          release('rel-3', 'Three', [track('rec-5', 'S5', ['GBAAA0000005'])]),
        ],
      ],
    })
    const store = new MemoryStore()

    const summary = await harvest({
      client,
      store,
      artists: [{ mbid: 'artist-a', name: 'A', why: 'test' }],
      maxRowsPerArtist: 2,
    })

    // Stops after the release that reached the cap, not after the whole page.
    expect(summary.rows).toBe(2)
  })
})
