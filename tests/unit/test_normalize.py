"""Unit tests for text normalization."""

import pytest

from setlist_core.enums import Qualifier
from setlist_core.normalize import (
    dedupe_key,
    fold,
    has_version_annotation,
    normalize_artist,
    normalize_document,
    normalize_isrc,
    parse_duration,
    split_artist_credits,
    split_featured,
    strip_qualifiers,
    tokens,
)

pytestmark = pytest.mark.unit


class TestNormalizeDocument:
    def test_normalizes_line_endings(self):
        assert normalize_document("a\r\nb\rc") == "a\nb\nc"

    def test_applies_nfkc(self):
        # Fullwidth latin and the ligature fi both fold under NFKC.
        assert normalize_document("ＡＢ") == "AB"
        assert normalize_document("ﬁn") == "fin"

    @pytest.mark.parametrize(
        "invisible",
        ["\u200b", "\u200e", "\u2060", "\ufeff", "\u202e", "\u00ad", "\u2066"],
    )
    def test_strips_invisible_characters(self, invisible):
        assert normalize_document(f"Daft{invisible} Punk") == "Daft Punk"

    def test_keeps_tabs_and_newlines_but_drops_other_controls(self):
        assert normalize_document("a\tb\nc\x00d\x07") == "a\tb\ncd"

    def test_is_idempotent(self):
        once = normalize_document("Björk\u200b – Hyperballad\r\n")
        assert normalize_document(once) == once

    def test_preserves_visible_content(self):
        assert normalize_document("Sigur Rós") == "Sigur Rós"


class TestFold:
    def test_transliterates_and_lowercases(self):
        assert fold("Björk") == "bjork"
        assert fold("Sigur Rós") == "sigur ros"

    def test_drops_punctuation_and_collapses_space(self):
        assert fold("  Sweet Child o' Mine!! ") == "sweet child o mine"

    def test_empty_input(self):
        assert fold("   ") == ""
        assert tokens("   ") == ()

    def test_tokens(self):
        assert tokens("Daft Punk") == ("daft", "punk")


class TestStripQualifiers:
    @pytest.mark.parametrize(
        ("raw", "title", "expected"),
        [
            ("Song (Live)", "Song", {Qualifier.LIVE}),
            ("Song [Live at Wembley]", "Song", {Qualifier.LIVE}),
            ("Song - Remastered 2011", "Song", {Qualifier.REMASTER}),
            ("Song (Eric Prydz Remix)", "Song", {Qualifier.REMIX}),
            ("Song (Acoustic)", "Song", {Qualifier.ACOUSTIC}),
            ("Song (Radio Edit)", "Song", {Qualifier.RADIO_EDIT}),
            ("Song (Instrumental)", "Song", {Qualifier.INSTRUMENTAL}),
            ("Song (Demo)", "Song", {Qualifier.DEMO}),
        ],
    )
    def test_recognized_qualifiers(self, raw, title, expected):
        base, qualifiers, _, _ = strip_qualifiers(raw)
        assert base == title
        assert qualifiers == expected

    def test_extended_mix_is_not_a_remix(self):
        # "Extended Mix" is the label's own master, not a third-party remix; tagging
        # it REMIX would make the matcher hunt for a remix that does not exist.
        _, qualifiers, _, _ = strip_qualifiers("Genesis (Extended Mix)")
        assert qualifiers == {Qualifier.EXTENDED}

    def test_unrecognized_parenthetical_stays_in_the_title(self):
        base, qualifiers, _, _ = strip_qualifiers("Delilah (pull me out of this)")
        assert base == "Delilah (pull me out of this)"
        assert qualifiers == frozenset()

    def test_stops_peeling_at_the_first_unrecognized_annotation(self):
        base, qualifiers, _, _ = strip_qualifiers("Song (Part 2) (Live)")
        assert base == "Song (Part 2)"
        assert qualifiers == {Qualifier.LIVE}

    def test_hyphenated_title_survives(self):
        base, qualifiers, _, _ = strip_qualifiers("Jump-Start")
        assert base == "Jump-Start"
        assert not qualifiers

    @pytest.mark.parametrize(
        "raw",
        [
            "Title (feat. Kali Uchis)",
            "Title [ft. Kali Uchis]",
            "Title featuring Kali Uchis",
            "Title feat. Kali Uchis",
        ],
    )
    def test_featured_artists(self, raw):
        base, _, featured, _ = strip_qualifiers(raw)
        assert base == "Title"
        assert featured == ("Kali Uchis",)

    def test_multiple_featured_artists_deduplicated(self):
        _, _, featured, _ = strip_qualifiers("Title (feat. SZA, SZA & Doja Cat)")
        assert featured == ("SZA", "Doja Cat")

    def test_version_label_is_preserved_verbatim(self):
        _, _, _, label = strip_qualifiers("Midnight City (Eric Prydz Remix)")
        assert label == "Eric Prydz Remix"

    def test_combined_qualifier_and_credit(self):
        base, qualifiers, featured, _ = strip_qualifiers("Title (Live) [feat. Bono]")
        assert base == "Title"
        assert qualifiers == {Qualifier.LIVE}
        assert featured == ("Bono",)

    def test_bare_version_word_peels_without_a_qualifier(self):
        base, qualifiers, _, _ = strip_qualifiers("Title (Single Version)")
        assert base == "Title"
        assert not qualifiers


class TestArtists:
    def test_split_featured(self):
        assert split_featured("Doja Cat, SZA & Rosalia") == ("Doja Cat", "SZA", "Rosalia")

    def test_split_artist_credits_inline(self):
        assert split_artist_credits("Calvin Harris feat. Dua Lipa") == (
            "Calvin Harris",
            ("Dua Lipa",),
        )

    def test_split_artist_credits_bracketed(self):
        assert split_artist_credits("Calvin Harris (feat. Dua Lipa)") == (
            "Calvin Harris",
            ("Dua Lipa",),
        )

    def test_collaboration_joiners_are_left_intact(self):
        # "&" is how providers spell the primary credit; splitting it hurts matching.
        assert split_artist_credits("Simon & Garfunkel") == ("Simon & Garfunkel", ())

    def test_normalize_artist_strips_leading_by_and_punctuation(self):
        assert normalize_artist("  by  The Cure , ") == "The Cure"


class TestIsrc:
    @pytest.mark.parametrize(
        ("raw", "expected"),
        [
            ("usrc17607839", "USRC17607839"),
            ("US-RC1-76-07839", "USRC17607839"),
            ("GBAYE0000456", "GBAYE0000456"),
        ],
    )
    def test_valid(self, raw, expected):
        assert normalize_isrc(raw) == expected

    @pytest.mark.parametrize("raw", ["", "USRC1760783", "USRC176078399", "1SRC17607839", "hello"])
    def test_invalid_fails_closed(self, raw):
        assert normalize_isrc(raw) is None


class TestDuration:
    @pytest.mark.parametrize(
        ("raw", "expected"),
        [("3:45", 225.0), ("03:45", 225.0), ("1:02:17", 3737.0), ("0:09", 9.0)],
    )
    def test_valid(self, raw, expected):
        assert parse_duration(raw) == expected

    @pytest.mark.parametrize("raw", ["345", "3:75", "abc", "", "3:4"])
    def test_invalid(self, raw):
        assert parse_duration(raw) is None


class TestDedupeKey:
    def test_case_and_punctuation_insensitive(self):
        assert dedupe_key("One More Time", "Daft Punk", frozenset()) == dedupe_key(
            "one more time!", "daft punk", frozenset()
        )

    def test_qualifiers_separate_recordings(self):
        studio = dedupe_key("Song", "Artist", frozenset())
        live = dedupe_key("Song", "Artist", frozenset({Qualifier.LIVE}))
        assert studio != live


class TestHasVersionAnnotation:
    @pytest.mark.parametrize(
        ("text", "expected"),
        [
            ("Genesis (Extended Mix)", True),
            ("Song (Live)", True),
            ("Daft Punk", False),
            ("Delilah (pull me out of this)", False),
        ],
    )
    def test_detection(self, text, expected):
        assert has_version_annotation(text) is expected
