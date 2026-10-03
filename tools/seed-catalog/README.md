# seed-catalog

Harvests real recordings from MusicBrainz into `golden/seed/recordings.jsonl`, which
CORE-03 turns into the golden text set.

```bash
pnpm -C tools/seed-catalog harvest    # talks to MusicBrainz; a person runs this
make seed                             # checks the committed file; CI runs this
```

The split matters. A gate that calls MusicBrainz on every build would be unreliable and
rude to a volunteer-run service, so the harvest is manual and its output is committed.
What CI owes is a check on the file that is actually in git, and `make seed` is that
check — offline, and part of `make verify`.

## Being a good citizen

MusicBrainz asks for **one request per second per IP** and a **descriptive User-Agent
with contact information**. Both are implemented and the first one is tested, because
ignoring either gets an IP throttled and then blocked — the cost of getting it wrong is
not a slow build, it is the project losing access to a free service.

The contact is the repository URL rather than a person: this repo is public and ADR-005
keeps personal addresses out of it.

One request returns an entire album — tracklist, recording MBIDs, ISRCs and credits — so
a full harvest is about 130 requests rather than a few thousand. That is a politeness
decision as much as a speed one.

Core MusicBrainz data is CC0; the harvested fields here are factual catalogue metadata.

## What the file has to contain

`make seed` enforces CORE-02's floors on the committed file:

| Property | Floor | Currently |
| --- | --- | --- |
| rows | 1,800–3,000 | 2,242 |
| rows with an ISRC | ≥80% | 83.1% |
| `live` | ≥100 | 290 |
| `remaster` | ≥50 | 201 |
| `feat` | ≥100 | 216 |
| `non_latin` | ≥150 | 386 |

Plus structure: no duplicate recordings, no empty titles, well-formed ISRCs, sorted by
`recording_mbid` so the diff is readable when it is regenerated.

Floors rather than exact counts, because MusicBrainz is a live database and a harvest a
month from now will not return the same number. They sit well below what the harvest
finds, because their job is to catch a property *disappearing* — the first harvest
produced exactly **one** `remaster` row, and a floor of one would never have said so.

## Three things that were not obvious

**`type=album|live` is an AND, not an OR.** Browse intersects multiple type values, so
asking for releases that are albums or live albums actually asks for ones that are both:
it returned Daft Punk's four live editions and hid *Homework*, *Discovery* and *Random
Access Memories* entirely. `type=album` is already the superset, since live albums have
primary type Album and secondary type Live.

**A global row target quietly deletes the diversity requirement.** Artists are walked in
list order, and the non-Latin entries are at the bottom of `artists.ts`. Stopping at
2,000 rows filled the file from the first sixteen names and reached none of the last
thirteen — the row count looked perfect while the hardest requirement sat at zero. Every
artist gets an equal share instead.

**MusicBrainz does not model remasters at the recording level**, because a remaster is
the same performance. The only place it is asserted is a release, and reissues sit late
in browse order: Queen's first three pages mention "remaster" zero times and page eight
mentions it 43 times. Hence the short backwards sweep at the end of each artist, which
mostly merges a tag onto rows already collected rather than adding new ones.

## ISRC coverage and non-Latin catalogues

These two requirements pull against each other, and the budget is per artist for that
reason. MusicBrainz's ISRC data is near-complete for modern Western releases and near
absent for older non-Western ones — Άννα Βίσση came back 0/67, أم كلثوم 0/46, فيروز
0/52, Lata Mangeshkar 1/70. Those artists are on the list *for* their scripts, so
dropping them to raise a percentage would trade the requirement that is hard to satisfy
for the one that is easy to measure. Instead, at most a fifth of any artist's share may
lack an ISRC: everyone stays in, and a sparse catalogue contributes less rather than
nothing.
