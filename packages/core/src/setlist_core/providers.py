"""Provider adapter contract and the verified per-provider capability table.

The capability values below are not defaults or guesses - they are the verified
findings in PRD S7.8, and they drive real behaviour: the UI hides reordering where the
platform has no reorder API, and the E2E harness stops trying to clean up playlists it
is not permitted to delete.

Apple is the load-bearing case. Per Apple engineer statements in the Developer Forums,
the Apple Music API offers no way to delete a library playlist, remove tracks from one,
or reorder it, and additions always append. Encoding that here means the limitation
shows up as a flag every caller can branch on rather than as a surprise in Phase 4.
"""

from enum import StrEnum
from typing import Protocol

from pydantic import BaseModel, ConfigDict, Field

from setlist_core.enums import Provider
from setlist_core.models import Hints

__all__ = [
    "CAPABILITIES",
    "AddPosition",
    "Capabilities",
    "PlaylistRef",
    "ProviderAdapter",
    "RateBudget",
    "TrackCandidate",
    "UserCtx",
]


class AddPosition(StrEnum):
    """Where a provider permits new tracks to be inserted."""

    ANYWHERE = "anywhere"
    END_ONLY = "end_only"


class Capabilities(BaseModel):
    """What a provider's playlist API actually supports."""

    model_config = ConfigDict(frozen=True, extra="forbid")

    can_delete: bool
    can_reorder: bool
    add_position: AddPosition
    #: Maximum tracks per add-items request.
    add_batch_size: int = Field(ge=1)
    #: False while a provider is gated behind a closed beta or an unmet access tier.
    generally_available: bool = True


class RateBudget(BaseModel):
    """A provider's request budget, as configured for our token bucket.

    Deliberately set below observed provider limits (PRD S7.11): the cost of being
    conservative is latency, the cost of being wrong is a 429 storm across every user
    sharing the app's quota.
    """

    model_config = ConfigDict(frozen=True, extra="forbid")

    requests: int = Field(gt=0)
    window_seconds: float = Field(gt=0)
    #: Daily unit ceiling for quota-metered APIs (YouTube), else ``None``.
    daily_units: int | None = Field(default=None, gt=0)


#: Verified capability values from PRD S7.8. Changing one of these is a product
#: decision, not a refactor - the contract test suite asserts them.
CAPABILITIES: dict[Provider, Capabilities] = {
    Provider.SPOTIFY: Capabilities(
        can_delete=True,
        can_reorder=True,
        add_position=AddPosition.ANYWHERE,
        add_batch_size=100,
    ),
    Provider.YOUTUBE: Capabilities(
        can_delete=True,
        can_reorder=True,
        add_position=AddPosition.ANYWHERE,
        # playlistItems.insert takes exactly one item per request.
        add_batch_size=1,
    ),
    Provider.APPLE: Capabilities(
        can_delete=False,
        can_reorder=False,
        add_position=AddPosition.END_ONLY,
        add_batch_size=100,
    ),
    Provider.AMAZON: Capabilities(
        can_delete=False,
        can_reorder=False,
        add_position=AddPosition.END_ONLY,
        add_batch_size=1,
        # Closed beta; Amazon confirms it is not onboarding partners (PRD R4).
        generally_available=False,
    ),
}


class UserCtx(BaseModel):
    """The authenticated user on whose behalf an adapter acts."""

    model_config = ConfigDict(frozen=True, extra="forbid")

    user_id: str = Field(min_length=1)
    provider: Provider
    #: Provider-side account identifier, where the API exposes one.
    provider_user_id: str | None = None
    #: Storefront / market code, required by Spotify and Apple catalog lookups.
    market: str | None = Field(default=None, min_length=2, max_length=2)


class PlaylistRef(BaseModel):
    """A playlist that exists on a provider."""

    model_config = ConfigDict(frozen=True, extra="forbid")

    provider: Provider
    playlist_id: str = Field(min_length=1)
    url: str | None = None


class TrackCandidate(BaseModel):
    """One possible resolution of a parsed item on one provider.

    Candidates are what the review UI shows when confidence is low (FR-007), so they
    carry enough metadata for a human to tell two recordings apart.
    """

    model_config = ConfigDict(frozen=True, extra="forbid")

    provider: Provider
    track_id: str = Field(min_length=1)
    title: str
    artists: tuple[str, ...] = ()
    album: str | None = None
    isrc: str | None = None
    duration_s: float | None = Field(default=None, gt=0)
    url: str | None = None
    #: Provider popularity, normalized to [0, 1] where the provider exposes it. Used
    #: only as a tiebreak (PRD S7.10.3).
    popularity: float | None = Field(default=None, ge=0, le=1)


class AddResult(BaseModel):
    """Outcome of an add-tracks call, including per-track failures."""

    model_config = ConfigDict(frozen=True, extra="forbid")

    added: tuple[str, ...] = ()
    failed: tuple[str, ...] = ()
    #: True when the provider reported this batch as already applied. Idempotent
    #: retries must not double-add (FR-009).
    deduplicated: bool = False


class ProviderAdapter(Protocol):
    """The interface every provider adapter implements (PRD S7.8).

    Adapters are the only place provider HTTP lives. Everything above them - matching,
    orchestration, the review flow - works against this interface, which is what keeps
    one provider's outage or policy change from reaching the rest of the system.
    """

    provider: Provider

    def search_by_isrc(self, isrc: str, market: str) -> list[TrackCandidate]:
        """Resolve by ISRC, the canonical cross-platform key."""
        ...

    def search_by_text(self, title: str, artist: str | None, hints: Hints) -> list[TrackCandidate]:
        """Resolve by normalized text search when no ISRC is available."""
        ...

    def create_playlist(
        self, user: UserCtx, name: str, description: str, *, public: bool
    ) -> PlaylistRef:
        """Create a playlist on behalf of ``user``."""
        ...

    def add_tracks(self, user: UserCtx, playlist: PlaylistRef, track_ids: list[str]) -> AddResult:
        """Append tracks, respecting `Capabilities.add_batch_size`."""
        ...

    def rate_budget(self) -> RateBudget:
        """Report the request budget this adapter must stay within."""
        ...

    def capabilities(self) -> Capabilities:
        """Report what this provider's playlist API supports."""
        ...
