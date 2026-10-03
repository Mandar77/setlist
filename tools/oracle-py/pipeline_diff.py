r"""Build ten thousand inputs and record what the oracle makes of each.

ADR-001: "TypeScript output must equal the oracle's on every golden case and on >=10,000
generated inputs." Eight golden cases prove the port composes; ten thousand prove it on
input nobody chose by hand, which is where a port actually breaks — a title with a
bracket in it, a line that is all punctuation, a credit that trips the artist-word cap.

## Why digests rather than outputs

A full pipeline result is a kilobyte of JSON. Ten thousand of them is a ten-megabyte
fixture that no reviewer reads and every regeneration rewrites. So the fixture holds the
input and a SHA-256 of the oracle's canonical output, and the port recomputes both.

That only works if "canonical" means the same thing in both languages, which is not
something to assume. ``canonical()`` below is compact, sorted and non-ASCII-preserving,
and ``test/pipeline-differential.test.ts`` asserts the two agree on the eight golden
cases before trusting them on ten thousand — a digest comparison that silently differed
in serialization would report ten thousand failures and mean nothing.

Usage:
    python tools/oracle-py/pipeline_diff.py            # check the committed fixture
    python tools/oracle-py/pipeline_diff.py --write    # regenerate it
"""

from __future__ import annotations

import hashlib
import json
import random
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
OUT_PATH = REPO_ROOT / "golden" / "diff" / "pipeline.jsonl"

sys.path.insert(0, str(Path(__file__).resolve().parent / "src"))

from setlist_core import cli  # noqa: E402
from setlist_core.pipeline import extract_deterministic  # noqa: E402

#: How many inputs the fixture carries. ADR-001 says at least ten thousand.
TARGET = 10_000

#: Fixed, so the fixture is reproducible. Changing it rewrites every line.
SEED = 20261002

SEPARATORS = [" - ", " – ", " — ", " · ", " ~ ", " | ", " / ", "\t"]
MARKERS = ["", "{n}. ", "{n}) ", "- ", "* ", "• ", "{mm}:{ss} ", "#{n} ", "[{n}] "]
QUALIFIERS = [
    "",
    " (Live)",
    " (Remastered)",
    " (2011 Remaster)",
    " (Acoustic)",
    " (Radio Edit)",
    " (Original Mix)",
    " (Interlude)",
    " - Live",
    " [Radio Edit]",
]
NOISE_LINES = [
    "---",
    "### Tracklist",
    "https://example.com/x",
    "Encore:",
    "**bold**",
    "| --- | --- |",
    "posted by someone",
    "",
]


def pairs() -> list[tuple[str, str]]:
    """Real (artist, title) pairs from the seed catalog, with a fallback."""
    seed_file = REPO_ROOT / "golden" / "seed" / "recordings.jsonl"
    found: list[tuple[str, str]] = []
    if seed_file.exists():
        for line in seed_file.read_text(encoding="utf-8").splitlines():
            if not line.strip():
                continue
            row = json.loads(line)
            artist = row["artists"][0]["name"] if row.get("artists") else row["artist"]
            found.append((artist, row["title"]))
    if not found:
        found = [("Daft Punk", "One More Time"), ("Justice", "Genesis")]
    return found


#: The shapes `render_line` can emit, named so the branch table reads as a choice
#: rather than as a row of magic numbers.
ARTIST_FIRST, TITLE_FIRST, QUOTED, BY_FORM, CSV_ROW = range(5)

#: How often a document gains a noise line at the top, between entries, and a trailing
#: newline. Tuned to produce a mix rather than to hit any particular rate.
P_LEADING_NOISE = 0.25
P_INTERLEAVED_NOISE = 0.12
P_TRAILING_NEWLINE = 0.5


def render_line(rng: random.Random, artist: str, title: str) -> str:
    """One list line, in some shape a person might plausibly have typed."""
    marker = rng.choice(MARKERS).format(
        n=rng.randint(0, 120), mm=f"{rng.randint(0, 99):02d}", ss=f"{rng.randint(0, 59):02d}"
    )
    qualifier = rng.choice(QUALIFIERS)
    separator = rng.choice(SEPARATORS)

    shape = rng.randint(0, 5)
    if shape == ARTIST_FIRST:
        return f"{marker}{artist}{separator}{title}{qualifier}"
    if shape == TITLE_FIRST:
        return f"{marker}{title}{qualifier}{separator}{artist}"
    if shape == QUOTED:
        return f'{marker}"{title}{qualifier}" by {artist}'
    if shape == BY_FORM:
        return f"{marker}{title}{qualifier} by {artist}"
    if shape == CSV_ROW:
        return f"{artist},{title}{qualifier}"
    return f"{marker}{title}{qualifier}"  # bare title


def document(rng: random.Random, catalog: list[tuple[str, str]]) -> str:
    """One whole input document."""
    count = rng.randint(1, 10)
    lines: list[str] = []
    if rng.random() < P_LEADING_NOISE:
        lines.append(rng.choice(NOISE_LINES))
    for _ in range(count):
        artist, title = rng.choice(catalog)
        lines.append(render_line(rng, artist, title))
        if rng.random() < P_INTERLEAVED_NOISE:
            lines.append(rng.choice(NOISE_LINES))
    text = chr(10).join(lines)
    if rng.random() < P_TRAILING_NEWLINE:
        text += chr(10)
    return text


def canonical(payload: object) -> str:
    """The one serialization both languages must agree on.

    Compact and sorted. Indentation and spacing are the parts most likely to differ
    between two JSON encoders, so there is none of either.
    """
    return json.dumps(payload, sort_keys=True, ensure_ascii=False, separators=(",", ":"))


def digest_for(text: str) -> str:
    """The oracle's answer for one input, as a SHA-256 of its canonical form."""
    result = extract_deterministic(text)
    return hashlib.sha256(
        canonical(cli.render(result, source_kind="printed")).encode("utf-8")
    ).hexdigest()


HEADER = (
    "// GENERATED by tools/oracle-py/pipeline_diff.py - do not edit. Ten thousand inputs "
    "and the SHA-256 of the frozen oracle's canonical output for each, so packages/core "
    "can be diffed against them (ADR-001). Regenerate with `make pipeline-diff-write`."
)


def build() -> str:
    """Render the fixture."""
    rng = random.Random(SEED)  # noqa: S311 - reproducibility, not security
    catalog = pairs()
    lines = [HEADER]
    for _ in range(TARGET):
        text = document(rng, catalog)
        entry = {"input": text, "digest": digest_for(text)}
        lines.append(json.dumps(entry, ensure_ascii=False, sort_keys=True))
    return "\n".join(lines) + "\n"


def main(argv: list[str]) -> int:
    """Entry point: check, or regenerate with ``--write``."""
    expected = build()

    if "--write" in argv[1:]:
        OUT_PATH.parent.mkdir(parents=True, exist_ok=True)
        OUT_PATH.write_text(expected, encoding="utf-8", newline="\n")
        print(f"pipeline diff: wrote {len(expected.splitlines()) - 1} inputs to {OUT_PATH.name}")
        return 0

    if not OUT_PATH.exists():
        print(f"pipeline diff: {OUT_PATH.name} is missing - run `make pipeline-diff-write`")
        return 1
    if OUT_PATH.read_text(encoding="utf-8") != expected:
        print(
            f"pipeline diff: {OUT_PATH.name} does not match the oracle. The oracle is "
            "frozen (CORE-01), so this means the fixture was edited by hand or the "
            "generator changed. Run `make pipeline-diff-write`."
        )
        return 1
    print(f"pipeline diff: {len(expected.splitlines()) - 1} oracle digests current")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
