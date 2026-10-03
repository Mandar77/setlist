r"""Dump the oracle's answers for a corpus of strings, so the port can be diffed against them.

ADR-001 calls the differential test "the real deliverable: it converts a rewrite, which
would silently lose hard-won behaviour, into a verified migration". This is the function
level of it. The pipeline level lives in the CLI and `golden/oracle/`; this covers the
pieces underneath, where Python and JavaScript actually disagree.

They disagree about Unicode. Python's ``\\w`` and ``\\b`` are Unicode-aware and
JavaScript's are ASCII-only, so ``[^\\w\\s]`` keeps Cyrillic in one language and strips
it in the other — ``fold("Печаль")`` is either "pechal" or the empty string depending on
which regex engine ran. That is not a bug anyone would notice by reading the port; it is
a bug a thousand real titles notice immediately.

The corpus is deliberately not hand-written. It comes from the seed catalog, the golden
cases, and a short list of adversarial strings, because the inputs that break a
transliteration are the ones nobody thinks to invent.

Usage:
    python tools/oracle-py/differential.py            # check the committed fixture
    python tools/oracle-py/differential.py --write    # regenerate it
"""

from __future__ import annotations

import json
import sys
from pathlib import Path
from typing import Any

REPO_ROOT = Path(__file__).resolve().parents[2]
OUT_PATH = REPO_ROOT / "golden" / "diff" / "normalize.jsonl"

sys.path.insert(0, str(Path(__file__).resolve().parent / "src"))

from setlist_core import normalize  # noqa: E402

#: Strings chosen to break things, rather than to pass.
ADVERSARIAL = [
    "",
    " ",
    chr(9) + chr(10) + " ",  # tab, newline, space
    "Печаль",
    "最後的戰役",
    "Σε πόσα ταμπλώ",
    "فيروز",
    "きみについて",
    "Björk",
    "Sigur Rós",
    "Café Tacvba",
    "Ali Farka Touré",
    # Built with chr() rather than written out, and not for style. Ruff's PLE2502,
    # PLE2515 and RUF001 reject literal invisible and ambiguous characters in source,
    # and they are right to - a fixture whose most interesting inputs are unreadable
    # in the file is a fixture nobody can review. These are precisely the inputs that
    # matter here, so they are spelled as code points and the file stays legible.
    "Youssou N" + chr(0x2019) + "Dour",  # typographic apostrophe
    "".join(chr(ord(c) + 0xFEE0) for c in "FULLWIDTH"),
    "zero" + chr(0x200B) + "width",  # ZWSP
    "soft" + chr(0x00AD) + "hyphen",
    "bidi" + chr(0x202E) + "override",
    # The three that separate Python's whitespace class from JavaScript's. U+FEFF is
    # whitespace to JavaScript and not to Python; U+0085 and U+001C are the reverse.
    "bom" + chr(0xFEFF) + "inside",
    "nel" + chr(0x0085) + "separator",
    "filesep" + chr(0x001C) + "inside",
    "Song (Live)",
    "Song (Remastered)",
    "Song (2011 Remaster)",
    "Song (Original Mix)",
    "Song (Extended Mix)",
    "Song (Interlude)",
    "Song (Part 2)",
    "Song - Live",
    "Song feat. Someone",
    "Song (feat. A, B & C)",
    "Artist feat. Guest",
    "Amadou & Mariam",
    "Miles Davis + 19",
    "A vs. B",
    "Ólafur x Someone",
    "by Someone",
    "  -- trimmed --  ",
    "0:00",
    "3:45",
    "1:02:03",
    "99:59",
    "GBAYE6300674",
    "gb-aye-63-00674",
    "not-an-isrc",
    "Song — Eric Prydz Remix",
    "Song [Radio Edit]",
    "Song (Unplugged)",
    "Song (Karaoke Version)",
    "ALL CAPS TITLE",
    "mIxEd CaSe TiTlE",
    "Trailing space ",
    "Multiple   spaces",
    "emoji 🔥 title",
    "🎵 leading emoji",
]


def corpus() -> list[str]:
    """Every string the fixture covers, in a stable order."""
    values: list[str] = list(ADVERSARIAL)

    seed = REPO_ROOT / "golden" / "seed" / "recordings.jsonl"
    if seed.exists():
        for line in seed.read_text(encoding="utf-8").splitlines():
            if not line.strip():
                continue
            row = json.loads(line)
            values.append(row["title"])
            values.append(row["artist"])

    extraction = REPO_ROOT / "golden" / "extraction"
    for path in sorted(extraction.glob("*.json")):
        document = json.loads(path.read_text(encoding="utf-8"))
        for case in document.get("cases", []):
            values.extend(case["text"].splitlines())

    # Deduplicate while keeping first-seen order, then sort, so the fixture is stable
    # whatever order the sources happen to be read in.
    return sorted(set(values))


def answers(value: str) -> dict[str, Any]:
    """Everything the oracle has to say about one string."""
    base, qualifiers, featured, version_label = normalize.strip_qualifiers(value)
    primary, feat = normalize.split_artist_credits(value)
    return {
        "normalize_document": normalize.normalize_document(value),
        "fold": normalize.fold(value),
        "tokens": list(normalize.tokens(value)),
        "strip_qualifiers": {
            "base": base,
            "qualifiers": sorted(str(q) for q in qualifiers),
            "featured": list(featured),
            "version_label": version_label,
        },
        "normalize_artist": normalize.normalize_artist(value),
        "split_artist_credits": {"primary": primary, "featured": list(feat)},
        "split_featured": list(normalize.split_featured(value)),
        "has_version_annotation": normalize.has_version_annotation(value),
        "normalize_isrc": normalize.normalize_isrc(value),
        "parse_duration": normalize.parse_duration(value),
        "dedupe_key": normalize.dedupe_key(value, value, qualifiers),
    }


HEADER = (
    "// GENERATED by tools/oracle-py/differential.py - do not edit. The oracle's answers "
    "for every string below, so packages/core can be diffed against them (ADR-001). "
    "Regenerate with `make diff-write`."
)


def build() -> str:
    """Render the fixture.

    JSONL, one case per line, sorted by input. Indented JSON came to four megabytes for
    the same content and turned every regeneration into an unreadable wall of diff; a
    line per case keeps ``git diff`` meaningful, which is the only reason to commit a
    generated file rather than build it on demand.
    """
    lines = [HEADER]
    lines.extend(
        json.dumps({"input": value, **answers(value)}, ensure_ascii=False, sort_keys=True)
        for value in corpus()
    )
    return "\n".join(lines) + "\n"


def main(argv: list[str]) -> int:
    """Entry point: check, or regenerate with ``--write``."""
    expected = build()

    if "--write" in argv[1:]:
        OUT_PATH.parent.mkdir(parents=True, exist_ok=True)
        OUT_PATH.write_text(expected, encoding="utf-8", newline="\n")
        count = len(expected.splitlines()) - 1
        print(f"differential: wrote {count} oracle answers to {OUT_PATH.name}")
        return 0

    if not OUT_PATH.exists():
        print(f"differential: {OUT_PATH.name} is missing - run `make diff-write`")
        return 1
    if OUT_PATH.read_text(encoding="utf-8") != expected:
        print(
            f"differential: {OUT_PATH.name} does not match the oracle. The oracle is "
            "frozen (CORE-01), so this means the fixture was edited by hand or the "
            "corpus changed. Run `make diff-write`."
        )
        return 1
    print(f"differential: {len(expected.splitlines()) - 1} oracle answers current")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
