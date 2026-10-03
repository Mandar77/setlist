"""Unit tests for the deterministic parser family (FR-002)."""

import pytest

from setlist_core.enums import Qualifier
from setlist_core.models import Line
from setlist_core.parsers import (
    detect_table,
    is_list_shaped,
    looks_like_noise,
    looks_like_prose,
    parse_line,
    parse_table,
    split_lines,
)
from setlist_core.parsers.affixes import strip_prefixes, strip_suffixes
from setlist_core.parsers.pair import parse_bare, parse_by, parse_dash, parse_quoted, parse_tab
from setlist_core.pipeline import extract_deterministic

pytestmark = pytest.mark.unit


class TestSplitLines:
    def test_offsets_are_exact(self):
        text = "alpha\nbeta\n\ngamma"
        lines = split_lines(text)
        assert [line.text for line in lines] == ["alpha", "beta", "", "gamma"]
        for parsed in lines:
            assert text[parsed.offset : parsed.offset + len(parsed.text)] == parsed.text

    def test_empty_line_has_no_span(self):
        assert Line("", 0).span is None


class TestStripPrefixes:
    @pytest.mark.parametrize(
        ("raw", "remainder", "position"),
        [
            ("1. Daft Punk - Da Funk", "Daft Punk - Da Funk", 1),
            ("12) Daft Punk - Da Funk", "Daft Punk - Da Funk", 12),
            ("#3 - Daft Punk - Da Funk", "Daft Punk - Da Funk", 3),
            ("[4] Daft Punk - Da Funk", "Daft Punk - Da Funk", 4),
        ],
    )
    def test_ordinals(self, raw, remainder, position):
        line, hints = strip_prefixes(Line(raw, 0))
        assert line.text == remainder
        assert hints.position == position

    def test_a_leading_year_is_not_an_ordinal(self):
        # "1979 - Smashing Pumpkins" must keep its year; the ordinal cap is 3 digits.
        line, hints = strip_prefixes(Line("1979 - Smashing Pumpkins", 0))
        assert line.text == "1979 - Smashing Pumpkins"
        assert hints.position is None

    @pytest.mark.parametrize("bullet", ["- ", "* ", "• ", "· ", "+ "])
    def test_bullets(self, bullet):
        line, _ = strip_prefixes(Line(f"{bullet}Justice - Genesis", 0))
        assert line.text == "Justice - Genesis"

    @pytest.mark.parametrize(
        ("raw", "seconds"),
        [
            ("00:14 Artist - Title", 14),
            ("[1:02:17] Artist - Title", 3737),
            ("(4:21) Artist - Title", 261),
        ],
    )
    def test_timestamps(self, raw, seconds):
        line, hints = strip_prefixes(Line(raw, 0))
        assert line.text == "Artist - Title"
        assert hints.timestamp_s == seconds

    def test_chained_prefixes(self):
        line, hints = strip_prefixes(Line("3. [00:14] Artist - Title", 0))
        assert line.text == "Artist - Title"
        assert hints.position == 3
        assert hints.timestamp_s == 14

    def test_offset_tracks_consumed_characters(self):
        line, _ = strip_prefixes(Line("1. Artist - Title", 100))
        assert line.offset == 103


class TestStripSuffixes:
    def test_trailing_duration(self):
        line, hints = strip_suffixes(Line("Artist - Title (3:45)", 0))
        assert line.text == "Artist - Title"
        assert hints.duration_s == 225.0

    def test_bare_trailing_clock_is_left_alone(self):
        # Unbracketed, a trailing clock is indistinguishable from a title like "9:30".
        line, hints = strip_suffixes(Line("Artist - 9:30", 0))
        assert line.text == "Artist - 9:30"
        assert hints.duration_s is None

    def test_trailing_isrc(self):
        line, hints = strip_suffixes(Line("Artist - Title [USRC17607839]", 0))
        assert line.text == "Artist - Title"
        assert hints.isrc == "USRC17607839"

    def test_duration_and_isrc_together(self):
        line, hints = strip_suffixes(Line("Artist - Title (3:45) [USRC17607839]", 0))
        assert line.text == "Artist - Title"
        assert hints.duration_s == 225.0
        assert hints.isrc == "USRC17607839"


class TestDashParser:
    @pytest.mark.parametrize("separator", [" - ", " – ", "–", " — ", " ~ ", " | ", " / "])
    def test_separators(self, separator):
        match = parse_dash(Line(f"Daft Punk{separator}Da Funk", 0))
        assert match is not None
        assert (match.artist, match.title) == ("Daft Punk", "Da Funk")

    def test_defaults_to_artist_first(self):
        match = parse_dash(Line("Justice - Genesis", 0))
        assert match is not None
        assert match.artist == "Justice"
        assert not match.ambiguous_direction

    def test_version_annotation_identifies_the_title_side(self):
        match = parse_dash(Line("Genesis (Extended Mix) - Justice", 0))
        assert match is not None
        assert (match.artist, match.title) == ("Justice", "Genesis")
        assert match.hints.qualifiers == {Qualifier.EXTENDED}

    def test_ambiguous_when_both_sides_look_like_titles(self):
        match = parse_dash(Line("Song (Live) - Other (Remix)", 0))
        assert match is not None
        assert match.ambiguous_direction

    def test_hyphenated_name_without_spaces_is_not_split(self):
        assert parse_dash(Line("Jean-Michel Jarre", 0)) is None

    def test_splits_only_at_the_first_separator(self):
        match = parse_dash(Line("Justice - Genesis - Live", 0))
        assert match is not None
        assert match.artist == "Justice"
        assert match.title == "Genesis"
        assert match.hints.qualifiers == {Qualifier.LIVE}

    def test_long_left_side_is_rejected_as_prose(self):
        assert parse_dash(Line("I really cannot believe how good this was - it slapped", 0)) is None


class TestByParser:
    def test_basic(self):
        match = parse_by(Line("Midnight City by M83", 0))
        assert match is not None
        assert (match.artist, match.title) == ("M83", "Midnight City")

    def test_case_insensitive(self):
        assert parse_by(Line("Midnight City BY M83", 0)) is not None

    @pytest.mark.parametrize(
        "raw",
        [
            "Written by our editorial team",
            "Compiled by the staff",
            "Produced by Rick Rubin",
        ],
    )
    def test_credit_lines_are_rejected(self, raw):
        assert parse_by(Line(raw, 0)) is None

    def test_long_artist_side_is_rejected(self):
        assert parse_by(Line("This list was assembled by a very large group of people", 0)) is None


class TestQuotedParser:
    @pytest.mark.parametrize(
        "raw",
        [
            'M83 - "Midnight City"',
            '"Midnight City" - M83',
            '"Midnight City" by M83',
            "M83 – “Midnight City”",
        ],
    )
    def test_variants(self, raw):
        match = parse_quoted(Line(raw, 0))
        assert match is not None
        assert (match.artist, match.title) == ("M83", "Midnight City")

    def test_apostrophes_are_not_delimiters(self):
        assert parse_quoted(Line("Guns N' Roses - Sweet Child o' Mine", 0)) is None


class TestTabParser:
    def test_is_always_ambiguous(self):
        match = parse_tab(Line("Daft Punk\tDa Funk", 0))
        assert match is not None
        assert (match.artist, match.title) == ("Daft Punk", "Da Funk")
        assert match.ambiguous_direction


class TestBareParser:
    def test_claims_a_short_separator_less_line(self):
        match = parse_bare(Line("Bohemian Rhapsody", 0))
        assert match is not None
        assert match.artist is None

    def test_rejects_prose(self):
        assert parse_bare(Line("This was the best set of the entire weekend. Truly.", 0)) is None


class TestNoise:
    @pytest.mark.parametrize(
        "raw",
        [
            "",
            "   ",
            "---",
            "===",
            "## Best of the summer",
            "```",
            "|---|---|",
            "https://example.com/thread",
            "<div>",
            "Encore:",
            "***",
        ],
    )
    def test_noise(self, raw):
        assert looks_like_noise(raw)

    @pytest.mark.parametrize("raw", ["Daft Punk - Da Funk", "1. Justice - Genesis", "#3 Song"])
    def test_content(self, raw):
        assert not looks_like_noise(raw)

    @pytest.mark.parametrize(
        "raw",
        [
            "Honestly the rest of this article is filler about the festival lineup and more",
            "It was great. Then they played the encore.",
        ],
    )
    def test_prose(self, raw):
        assert looks_like_prose(raw)

    @pytest.mark.parametrize(
        "raw",
        [
            "Mr. Brightside - The Killers",
            "R.E.M. - Losing My Religion",
            "Vol. 2 - Some Artist",
            "Daft Punk - Da Funk",
        ],
    )
    def test_abbreviations_are_not_sentence_breaks(self, raw):
        assert not looks_like_prose(raw)

    def test_list_shape_detection(self):
        listy = split_lines("Song One\nSong Two\nSong Three\nSong Four")
        assert is_list_shaped(listy)

    def test_article_is_not_list_shaped(self):
        article = split_lines(
            "The festival opened on a warm Friday evening with a long set.\n"
            "Later the headliner arrived and the crowd finally woke up.\n"
            "By midnight the field was full and nobody wanted to leave at all."
        )
        assert not is_list_shaped(article)


class TestParseLine:
    def test_combines_affixes_and_pattern(self):
        match = parse_line(Line("3. [00:14] Justice - Genesis (Extended Mix) (3:45)", 0))
        assert match is not None
        assert (match.artist, match.title) == ("Justice", "Genesis")
        assert match.hints.position == 3
        assert match.hints.timestamp_s == 14
        assert match.hints.duration_s == 225.0
        assert match.hints.qualifiers == {Qualifier.EXTENDED}
        assert match.structured

    def test_noise_is_not_parsed(self):
        assert parse_line(Line("## Heading", 0)) is None

    def test_bare_requires_opt_in(self):
        assert parse_line(Line("Bohemian Rhapsody", 0)) is None
        assert parse_line(Line("Bohemian Rhapsody", 0), allow_bare=True) is not None


class TestTable:
    def test_header_detection(self):
        lines = split_lines("Artist,Title,Album\nDaft Punk,Da Funk,Homework")
        spec = detect_table(lines)
        assert spec is not None
        assert spec.has_header
        assert spec.columns["artist"] == 0
        assert spec.columns["title"] == 1
        assert spec.columns["album"] == 2

    def test_header_row_is_skipped(self):
        lines = split_lines("Artist,Title\nDaft Punk,Da Funk\nJustice,Genesis")
        spec = detect_table(lines)
        assert spec is not None
        matches = parse_table(lines, spec)
        assert [(m.artist, m.title) for m in matches] == [
            ("Daft Punk", "Da Funk"),
            ("Justice", "Genesis"),
        ]

    def test_column_order_is_read_from_the_header(self):
        lines = split_lines("Title,Artist\nDa Funk,Daft Punk")
        spec = detect_table(lines)
        assert spec is not None
        matches = parse_table(lines, spec)
        assert (matches[0].artist, matches[0].title) == ("Daft Punk", "Da Funk")
        assert not matches[0].ambiguous_direction

    def test_headerless_direction_inferred_from_repetition(self):
        # The artist column repeats; the title column does not.
        lines = split_lines(
            "\n".join(
                [
                    "Daft Punk,Da Funk",
                    "Daft Punk,Around the World",
                    "Daft Punk,Revolution 909",
                    "Justice,Genesis",
                    "Justice,Phantom",
                    "Justice,Stress",
                ]
            )
        )
        spec = detect_table(lines)
        assert spec is not None
        assert not spec.has_header
        assert not spec.ambiguous
        assert spec.columns["artist"] == 0

    def test_headerless_reversed_direction_is_inferred(self):
        lines = split_lines(
            "\n".join(
                [
                    "Da Funk,Daft Punk",
                    "Around the World,Daft Punk",
                    "Revolution 909,Daft Punk",
                    "Genesis,Justice",
                    "Phantom,Justice",
                    "Stress,Justice",
                ]
            )
        )
        spec = detect_table(lines)
        assert spec is not None
        assert spec.columns["artist"] == 1
        assert spec.columns["title"] == 0

    def test_short_headerless_table_stays_ambiguous(self):
        lines = split_lines("Daft Punk,Da Funk\nJustice,Genesis")
        spec = detect_table(lines)
        assert spec is not None
        assert spec.ambiguous
        assert spec.parser_name == "csv_headerless"

    def test_isrc_and_duration_columns_typed_by_content(self):
        lines = split_lines(
            "\n".join(
                [
                    "Daft Punk,Da Funk,USRC17607839,5:28",
                    "Daft Punk,Around the World,GBAYE0000456,7:09",
                    "Justice,Genesis,FRUM71200001,3:54",
                    "Justice,Phantom,FRUM71200002,3:12",
                    "Justice,Stress,FRUM71200003,4:57",
                ]
            )
        )
        spec = detect_table(lines)
        assert spec is not None
        assert spec.columns["isrc"] == 2
        assert spec.columns["duration"] == 3
        matches = parse_table(lines, spec)
        assert matches[0].hints.isrc == "USRC17607839"
        assert matches[0].hints.duration_s == 328.0

    def test_duration_in_milliseconds(self):
        lines = split_lines("Artist,Title,Duration\nDaft Punk,Da Funk,328000")
        spec = detect_table(lines)
        assert spec is not None
        assert parse_table(lines, spec)[0].hints.duration_s == 328.0

    def test_markdown_table(self):
        lines = split_lines(
            "| Artist | Title |\n|---|---|\n| Daft Punk | Da Funk |\n| Justice | Genesis |"
        )
        spec = detect_table(lines)
        assert spec is not None
        matches = parse_table(lines, spec)
        assert [(m.artist, m.title) for m in matches] == [
            ("Daft Punk", "Da Funk"),
            ("Justice", "Genesis"),
        ]

    def test_plain_dash_list_is_not_a_table(self):
        assert detect_table(split_lines("Daft Punk - Da Funk\nJustice - Genesis")) is None

    def test_inconsistent_widths_are_not_a_table(self):
        assert detect_table(split_lines("a,b\nc,d,e\nf")) is None


class TestOrdinalRegressions:
    def test_zero_indexed_list_does_not_crash(self):
        # Found by Hypothesis: "0." is a valid list marker, but `position` is a
        # 1-based ordinal, so recording 0 violated the model and 500'd /parse.
        line, hints = strip_prefixes(Line("0. Daft Punk - Da Funk", 0))
        assert line.text == "Daft Punk - Da Funk"
        assert hints.position is None

    def test_zero_indexed_list_parses_end_to_end(self):
        result = extract_deterministic("0. Daft Punk - Da Funk\n1. Justice - Genesis")
        assert [entry.title for entry in result.items] == ["Da Funk", "Genesis"]
