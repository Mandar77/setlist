# Product Requirements Document — "Setlist": Text-to-Playlist Generator (Multi-Platform, AWS Serverless)

> **Provenance.** Transcribed from the PRD v1.0 PDF supplied on 2026-09-28. If you hold
> a cleaner original, replace this file wholesale — nothing generates from it.
>
> **This document is outranked.** Precedence is `plan/AUTOPILOT.md` and `adr/` >
> [PED](PED.md) > **PRD**. The PED re-selects the AWS service set to hit a hard $0
> bill, so several architecture sections below are superseded. Every such section
> carries a callout. Amendments are applied inline, marked with the ADR that authorised
> them; [`spec-amendments.md`](spec-amendments.md) is the changelog.

## 1. Document Control & Executive Summary

**Version:** 1.0 · **Date:** September 23, 2026 · **Status:** Draft for engineering review · **Owner:** Platform Engineering

**Executive summary.** Setlist ingests free-form written text containing a list of songs (a Reddit thread, a blog post, a DJ setlist, a chat message, an uploaded `.txt`/`.md`/`.csv`), extracts (title, artist, hints) tuples using a hybrid deterministic + LLM parser on Amazon Bedrock, resolves each song to concrete tracks per platform (ISRC-anchored fuzzy matching), and creates a playlist on the user's chosen platform(s): Spotify, YouTube Music, Apple Music, and Amazon Music. It is a multi-tenant SPA + REST web app on AWS, serverless-first and event-driven.

**The single most consequential finding:** Spotify's April 15, 2025 blog "Updating the Criteria for Web API Extended Access" (effective May 15, 2025) restricts Extended Quota Mode to applicants meeting four criteria — "1. The business entity must be a legally registered business or organization. 2. The business must be operating an active and launched service. 3. The service must be maintaining a minimum of 250,000 monthly active users. 4. The service must be available in key Spotify markets." Spotify support states the review "can take up to six weeks" with no guarantee of approval. **A public Spotify launch is therefore gated by a business/scale threshold the project cannot meet at inception.** The recommended rollout order is: **YouTube Music first** (public launch feasible via Google OAuth verification), then **Spotify** (operate in Development Mode until the MAU threshold is met), then **Apple Music** (feasible but with hard API limitations), and **Amazon Music last** (contingent on closed-beta access, which Amazon confirms it is "not onboarding any partner to" as of 2026).

The recommended IaC is **AWS CDK (TypeScript)**; CI/CD is **GitHub Actions with OIDC federation** across separate dev/stage/prod AWS accounts under AWS Organizations. Lambdas and Glue run **Python 3.13**; the frontend is **TypeScript + React**. The extraction LLM default is **Claude Haiku 4.5 on Amazon Bedrock** ($1/$5 per M input/output tokens) for parsing, with escalation to **Claude Sonnet 4.6** ($3/$15 per M) for hard inputs.

> **Superseded — [PED](PED.md) D9, D15, and [ADR-004](adr/0004-language-map.md).**
> Three of the summary's decisions no longer hold:
> - **Bedrock is off by default** (PED D9): it has no free tier. The deterministic
>   parser plus an on-device LLM replace it; Bedrock sits behind a flag in the
>   enterprise profile.
> - **One AWS account, not Organizations** (PED D15): joining an Organization upgrades
>   a free-plan account to paid and expires its credits immediately.
> - **Node/TypeScript, not Python**, for Lambdas ([ADR-004](adr/0004-language-map.md)).
>   Python 3.13 survives only for `services/ocr` and `packages/etl`.
>
> The product thesis — arbitrary text in, grounded playlist out — is unchanged.

## 2. Problem Statement, Goals, Non-Goals

**Problem.** People routinely encounter song lists as prose — festival lineups, "best of" articles, group chats, DJ tracklists — but converting them into a playlist means manual search-and-add, dozens of times, per platform. Existing tools (Soundiiz, TuneMyMusic, SongShift, FreeYourMusic) transfer *playlists between services*; none specialize in *parsing arbitrary text into a playlist* with grounded, auditable extraction. That is Setlist's differentiator.

**Goals.**

- **G1:** Turn arbitrary pasted text or an uploaded text file into a playlist on ≥1 chosen platform in a single flow.
- **G2:** High extraction fidelity (no hallucinated songs) and high match accuracy (correct recording, not a live/remix by accident).
- **G3:** Multi-platform creation in one action where the user has connected accounts.
- **G4:** Human-in-the-loop review/fix of low-confidence matches before creation.
- **G5:** Production-grade reliability, observability, security, and cost control.

**Non-Goals.**

- **NG1:** No audio playback, streaming, or downloading (no DRM circumvention).
- **NG2:** No music recommendation/discovery engine (out of scope; also restricted by Spotify policy and by the Nov 2024 API deprecations).
- **NG3:** No training or ingestion of provider content into ML models (prohibited by Spotify Developer Terms).
- **NG4:** Image/screenshot OCR is a later optional phase, not v1.
- **NG5:** No cross-service library migration (that is the incumbents' niche).

> **Superseded — [PED](PED.md) §2–§4.** NG4 is reversed: scanning a photo of a
> handwritten setlist is the PED's *headline* use case, not a later phase. Everything
> else stands.

## 3. Personas, User Stories, Key Use Cases

**Personas.**

- **Playlist Curator Casey** — pastes a "Top 100 songs of the summer" article, wants a Spotify playlist.
- **DJ Dana** — uploads a timestamped tracklist `.txt`, wants YouTube Music + Apple Music playlists.
- **Multi-platform Morgan** — has Spotify + Apple Music, wants the same playlist on both.
- **Ops/On-call Riley** — internal; monitors pipeline health and provider quota.

**User stories.**

- **US1:** As Casey, I paste text and see a parsed preview (title/artist/confidence) before anything is created.
- **US2:** As Dana, I upload a `.txt` and pick two platforms; the app creates both playlists asynchronously with live progress.
- **US3:** As Morgan, I review low-confidence matches, pick the right track from candidates, then confirm creation.
- **US4:** As any user, I connect/disconnect a provider account and, on disconnect, my provider data is deleted.
- **US5:** As Riley, I see per-provider queue depth, 429 rate, and DLQ depth on a dashboard.

**Key use cases:** paste a Reddit thread → playlist; paste a blog "best of" list → playlist; upload a DJ setlist → multi-platform playlists; review-and-fix low-confidence matches before creating.

## 4. Scope, Assumptions, Constraints

**Assumptions** (defaults; deviate only with explicit justification).

- Multi-user, multi-tenant web app: React SPA + REST API. Each user connects their own music accounts via OAuth.
- AWS, serverless-first, event-driven. Python 3.13 for Lambda and Glue; TypeScript+React frontend.
- IaC = AWS CDK (TypeScript). CI/CD = GitHub Actions + OIDC. Separate dev/stage/prod accounts + a shared tooling account under AWS Organizations.
- Extraction = deterministic parsers + Claude on Bedrock (hybrid).

> **Three of these assumptions are superseded**, and they are the ones most likely to
> be acted on by mistake, since an assumptions list reads as settled:
>
> | Assumption above | Now | Why |
> | --- | --- | --- |
> | Separate accounts under **AWS Organizations** | **One account**, per-environment stacks | Joining an Organization upgrades a free-plan account to paid and expires its Free Tier credits immediately ([PED](PED.md) D15) |
> | **Python 3.13** for Lambda and Glue | **Node/TypeScript** by default; Python only for `services/ocr` and `packages/etl` | [ADR-004](adr/0004-language-map.md) — one grammar, one toolchain |
> | Extraction = deterministic parsers **+ Claude on Bedrock** | Deterministic parser by default; Bedrock behind a flag | Bedrock has no free tier ([PED](PED.md) D9) |
>
> Unchanged and still correct: CDK in TypeScript, GitHub Actions with OIDC, multi-tenant
> SPA + REST, serverless-first and event-driven, and per-environment provider apps.
>
> The **runtime/version facts** below still apply to the Python that survives, and Glue
> targeting is moot while Glue jobs are flagged off ([PED](PED.md) D8).

**Runtime/version facts** (verified Sep 2026).

- **AWS Lambda Python 3.13:** GA announced Nov 14, 2024 ("the latest long-term support (LTS) release of Python … expected to be supported for security and bug fixes until October 2029"); runtime release listed Nov 18, 2024. Python 3.14 added Nov 18, 2025. We standardize on **3.13** (stable, Powertools-supported). Python 3.15 is public preview only — not for production.
- **AWS Glue 6.0** (Spark 4.1.1, Python 3.13, Scala 2.13, ~30% lower rate) is the latest; **Glue 5.1** (Spark 3.5.6, Python 3.11, Scala 2.12.18, Java 17) is available across all commercial + GovCloud regions (April 2026). We target **Glue 5.1** for stability with a fast-follow upgrade path to 6.0.

### Platform constraints table

| Platform | Auth | Access requirement | Quotas / rate limits | Known limitations |
|---|---|---|---|---|
| **Spotify** | OAuth 2.0 Authorization Code + PKCE; scopes `playlist-modify-public`, `playlist-modify-private` | **Development Mode** default (app owner Premium; new apps capped at ~5 users; since July 23, 2026, up to **25 client IDs per developer account** on a shared per-account quota). **Extended Quota Mode:** legally registered business, active launched service, **≥250,000 MAU**, available in key markets (since May 15, 2025); review up to 6 weeks | Rolling 30-second window; **429** with `Retry-After` (body now carries reason `QUOTA_EXCEEDED`); community-observed ~180 req/min; **add-items batch max 100 items per request**; `/search` `limit` max reduced 50→10 (Feb 2026); user max ~11,000 playlists | Nov 27, 2024 deprecations removed recommendations/audio-features/related-artists/featured-playlists for new apps (not needed here); Feb 2026 removed further endpoint families; ISRC `isrc:` search filter is market-specific and occasionally flaky |
| **YouTube Music** | Google OAuth 2.0; scope `youtube.force-ssl` | Google Cloud project; **OAuth app verification** required for sensitive scope; quota-extension audit for scale | **10,000 units/day** default; `search.list` = **100 units**, `playlists.insert` / `playlistItems.insert` = **50 units** each; quota cannot be purchased | No official "YouTube Music" API — use YouTube Data API v3; playlists created via Data API surface in YouTube Music. `ytmusicapi` is unofficial ("not supported nor endorsed by Google", ToS/breakage risk). Matching to official audio/"Topic" channels is heuristic |
| **Apple Music** | Developer token (JWT/ES256, ≤6 months / 15,777,000 s) + Music User Token (opaque, via MusicKit JS `authorize()`; sent in `Music-User-Token` header) | **Apple Developer Program** ($99/yr); user needs **active Apple Music subscription** (`addToCloudMusicLibrary` capability) | No published numeric rate limit; returns **429** when throttled; no rate-limit headers | **Cannot delete a library playlist, remove tracks, or reorder** via API; add-tracks appends to end only; complicates E2E cleanup |
| **Amazon Music** | Login with Amazon (OAuth 2.0) | **Closed beta**; access only via an Amazon Music business/BD contact; Amazon confirms "not onboarding any partner … still in closed Beta" (2026) | TPS limits; 429 "Too Many Requests"; **access token expires after 1 hour** | Web API in beta; schema "subject to change"; create/modify playlist endpoints exist but are gated |

> **Superseded — [PED](PED.md) §2 and D17–18.** At $0, Apple Music and Amazon Music are
> **out of scope entirely** ($99/yr and a closed beta respectively), and Spotify is
> **conditional** on the app owner holding a Premium subscription. YouTube is the only
> provider built. The capability data above is still encoded in
> `packages/core`'s provider table and still drives UX and test cleanup.

## 5. Functional Requirements (MoSCoW)

- **FR-001 (Must):** Accept pasted free-form text (configurable size limit, default 100 KB) and uploaded files (`.txt`, `.md`, `.csv`; `.docx`/`.pdf` later). *AC:* given a valid paste/upload, the API returns a job id and a parsed preview.
- **FR-002 (Must):** Deterministic parsing of common patterns: separator-delimited artist/title pairs, "Title by Artist", numbered/bulleted lists, CSV columns, timestamped DJ tracklists, setlists. **Orientation of a separator-delimited line is inferred, not fixed**: explicit cues first, then the document's own convention, then a source-kind prior (`scan_*` and `screenshot` → title first; `paste` and `file` → artist first). Where confidence is below 0.8 the parser emits the swapped reading as `alternate`, and matching resolves it against free catalogs before any provider quota is spent. *AC:* golden-set precision ≥0.95 on deterministic-friendly inputs; parser-only orientation accuracy ≥90% on bare-dash lines and ≥98% after matching.
- **FR-003 (Must):** LLM-based structured extraction (JSON schema) on Bedrock for prose, with **source-span grounding** to prevent hallucinated songs. *AC:* every extracted item carries a character offset span into the source text; items without a valid span are rejected.
- **FR-004 (Must):** Hybrid merge + per-item confidence score; deduplication of repeated songs. *AC:* duplicates collapse; each item has confidence ∈ [0,1].
- **FR-005 (Must):** Parse-and-preview is synchronous (target p95 < 6 s) and creates nothing. *AC:* preview returns before any provider write.
- **FR-006 (Must):** Cross-platform resolution using **ISRC** as canonical key when available, else normalized fuzzy match (title/artist/duration). *AC:* match returns a chosen track + candidates + confidence per platform.
- **FR-007 (Must):** Human-in-the-loop review UI for items below a confidence threshold (default 0.8). *AC:* user can pick an alternate candidate or drop the item before creation.
- **FR-008 (Must):** Async playlist creation per selected provider with live progress to the UI. *AC:* the UI shows per-track resolved/added/failed counts in near-real-time.
- **FR-009 (Must):** **Idempotent creation** — retries never create duplicate playlists or duplicate tracks. *AC:* replaying the same job id yields exactly one playlist per provider.
- **FR-010 (Must):** Connect/disconnect provider accounts via OAuth; on disconnect, delete all stored provider tokens and personal data for that provider. *AC:* post-disconnect, no tokens or provider PII remain (verified by data-deletion test).
- **FR-011 (Should):** Multi-platform creation in one action for all connected providers. *AC:* one confirm creates N playlists across N providers.
- **FR-012 (Should):** Bulk/large-file import path (>500 songs) routed to a batch (Glue) pipeline. *AC:* a 5,000-line file completes without timeout and is idempotent on rerun.
- **FR-013 (Should):** Export the parsed/matched result as CSV/JSON (portability; does not cache provider content beyond ToS limits).
- **FR-014 (Could):** Scheduled re-matching of previously "not found" tracks as catalogs change.
- **FR-015 (Could):** OCR of pasted images/screenshots (later phase).
- **FR-016 (Won't, v1):** Cross-service library migration and audio playback.

> **Amended — [ADR-002](adr/0002-line-orientation.md).** FR-002 above already carries
> the amendment. The original text named `"Artist – Title"` as *the* canonical pattern,
> which is right for a pasted tracklist and wrong for a handwritten setlist — where the
> writer already knows who is playing and lists only songs. A fixed global default is
> wrong roughly half the time on the PED's headline use case, and under autonomous
> creation it silently adds the wrong track.

> **Superseded — [PED](PED.md) D9 and §7.** FR-003's Bedrock dependency is removed from
> the default path: the deterministic parser plus an on-device LLM cover it, with
> Bedrock behind a flag. **The span-grounding requirement is unchanged and is the more
> important half** — see [ADR-007](adr/0007-deterministic-core-and-span-grounding.md).
> FR-012's Glue dependency is likewise flagged off (PED D8): the ETL module runs as a
> scheduled Lambda. FR-015's OCR is promoted from "could" to a Must (PED FR-M-005).

## 6. Non-Functional Requirements

- **NFR-001 Performance:** Parse-and-preview p95 < 6 s for ≤50 songs; async creation of a 50-song playlist completes p95 < 90 s (single provider), subject to provider rate limits.
- **NFR-002 Scalability:** Support 1k → 100k playlists/month without architecture change; per-provider concurrency isolated so one provider's throttling cannot starve others.
- **NFR-003 Availability:** Control-plane API 99.9% monthly; async pipeline is at-least-once with DLQs; no data loss on provider outage (jobs park and resume).
- **NFR-004 Security:** Cognito user pools; WAF on CloudFront/API Gateway; least-privilege IAM; per-user OAuth tokens encrypted with KMS; input size caps; per-user abuse rate limiting.
- **NFR-005 Privacy/Compliance:** GDPR/CCPA-style data export and deletion; honor Spotify Developer Terms (no caching of Spotify Content beyond temporary metadata/cover-art; no ML training on provider content; disconnect ⇒ delete). Clear privacy policy; per-provider disconnect mechanism.
- **NFR-006 Observability:** Structured JSON logs, EMF metrics, X-Ray/ADOT traces, correlation IDs propagated across sync → async → provider calls; dashboards + alarms.
- **NFR-007 Cost:** Track cost per playlist; target < $0.02 per 50-song playlist at 10k/month (excluding provider fees), dominated by Bedrock + Lambda.
- **NFR-008 Accessibility:** WCAG 2.2 AA; automated axe checks in CI gate the frontend.
- **NFR-009 Data residency:** Bedrock regional endpoints; all PII in-region.

> **Superseded — [PED](PED.md) §8.** NFR-003's availability target drops to **99.5%**
> (single region, no multi-AZ paid services). NFR-004's KMS CMK becomes an AES-GCM data
> key in an SSM SecureString (PED D7 — a CMK costs $1/month), and standalone WAF becomes
> the CloudFront flat-rate Free plan (D2). NFR-007's target becomes **$0.00**, not
> $0.02 — the cost model is a hard constraint, not a budget.

## 7. System Architecture

> **Service selection superseded — [PED](PED.md) §10.** The PED re-selects nearly every
> service named in this section to reach $0: API Gateway → Lambda Function URLs behind
> CloudFront OAC (D1); EventBridge bus → SNS (D3); Step Functions on the hot path →
> a Lambda saga (D4); SQS pollers → SNS→Lambda with DLQ destinations (D5); KMS CMK →
> SSM SecureString (D7); S3 lake + Glue + Athena → a scheduled Lambda ETL (D8);
> Bedrock → the deterministic parser (D9); Secrets Manager + AppConfig → SSM Parameter
> Store (D10–11); WebSocket → push + polling (D1).
>
> **Read this section in two halves.**
>
> | Sub-sections | Status |
> | --- | --- |
> | **7.1–7.6, 7.12** | Superseded. They describe the enterprise profile — accurate for `-c profile=enterprise`, not for what gets built. |
> | **7.7–7.11** | **Current.** They specify *behaviour* rather than *services*, so the PED does not restate them: the data model, the provider adapter contract and its verified capability table, and the extraction, matching and idempotency algorithms. Individual storage choices inside 7.7 are amended where the PED changes them, and those amendments are marked in place. |

### 7.1 Architecture diagram

The original diagram describes the enterprise profile: CloudFront + WAF → API Gateway REST (Cognito authorizer) → `parse-preview` and `job-controller` Lambdas → Step Functions → SNS fan-out → per-provider SQS queues → provider adapter Lambdas, with a DynamoDB single table, a Secrets/KMS token store, a WebSocket API for progress, EventBridge domain events, and an S3 + Glue + Athena analytics lane.

See [PED §10.1](PED.md#101-0-profile) for the $0 topology and [§10.2](PED.md#102-enterprise-profile--c-profileenterprise-same-code) for this one.

### 7.2 Component descriptions

- **CloudFront + WAF:** SPA hosting + edge protection (rate rules, AWS managed rule sets, optional bot control).
- **API Gateway (REST):** control plane; Cognito authorizer; request validation via JSON Schema models.
- **parse-preview Lambda (sync):** runs deterministic parsers, then Bedrock LLM for residual prose, merges, scores, returns preview. **No provider writes.**
- **job-controller Lambda:** validates the confirmed job, starts the Step Functions execution.
- **Step Functions (Standard):** orchestrates per-job resolve→create; uses **Distributed Map** for large lists; emits progress.
- **SNS→SQS fan-out:** one SQS queue per provider for rate-limit isolation; each with a DLQ + redrive.
- **Provider adapter Lambdas:** implement the common adapter interface; reserved/max concurrency tuned per provider's rate budget; token-bucket limiter in DynamoDB.
- **Token store:** per-user OAuth tokens in DynamoDB with KMS envelope encryption (see 7.7).
- **WebSocket API:** pushes per-track progress to the SPA.
- **EventBridge:** domain events (`JobCreated`, `PlaylistCreated`, `MatchLowConfidence`) + schedules (re-matching).
- **S3 data lake + Glue + Athena:** analytics ETL, bulk imports, data-quality checks.

### 7.3 Sequence — OAuth connect (Spotify)

SPA requests `GET /connect/spotify` with a PKCE challenge → API Gateway starts the connect Lambda → 302 to Spotify authorize (scopes, PKCE) → user consents → redirect to `/callback?code` → exchange code + verifier → `POST /api/token` → access + refresh tokens → envelope-encrypt and store per user → connected.

### 7.4 Sequence — parse & preview

SPA `POST /parse {text}` → API Gateway → parse-preview Lambda → deterministic parsers + dedup → extract residual prose (JSON schema, tool-use) via Bedrock Claude → items + spans → merge + confidence → `preview {items, confidence, spans}`.

### 7.5 Sequence — async creation with retries

Step Functions publishes resolve tasks → SNS fans out per provider → SQS (event source mapping, max concurrency) → adapter Lambda → idempotency check (Powertools) → search (ISRC first) + add items (batch 100) → on `429 Retry-After`, backoff + jitter honouring `Retry-After` → retry → `201 added` → task success (partial batch responses). Failures return to the queue and reach the DLQ after `maxReceiveCount`.

### 7.6 API outline (REST)

- `POST /parse` → `{jobId, items[]}` (sync preview)
- `POST /jobs/{jobId}/confirm` → `{executionId}` (starts async creation; body selects providers + item overrides)
- `GET /jobs/{jobId}` → status + per-provider progress
- `GET /connect/{provider}` / `GET /callback/{provider}` → OAuth
- `DELETE /connections/{provider}` → disconnect + delete
- `POST /uploads` → presigned S3 URL
- `GET /me/export` / `DELETE /me` → GDPR export/delete
- WebSocket `$connect`, `progress`, `$disconnect`

### 7.7 Data model (DynamoDB single-table)

Single-table design (`PK`/`SK`) with GSIs:

- `USER#<id>` / `PROFILE`
- `USER#<id>` / `CONN#<provider>` → encrypted tokens (KMS), scopes, expiry
- `JOB#<id>` / `META` → status, counts
- `JOB#<id>` / `ITEM#<n>` → parsed item, confidence, span, per-provider match
- `MATCHCACHE#<isrc-or-hash>` / `PROVIDER#<p>` → resolved id + TTL (ToS-compliant: store neutral keys such as ISRC and your own match record — **never bulk Spotify catalog data**)
- `RATE#<provider>` / `BUCKET` → token-bucket counters (with TTL)

TTL on match cache and rate buckets. GSI1: user→jobs; GSI2: job→low-confidence items.

**Token storage decision.** Use **DynamoDB + KMS envelope encryption**, not one Secrets Manager secret per user. AWS Secrets Manager is priced at **$0.40 per secret per month plus $0.05 per 10,000 API calls** (uniform across regions), so per-user secrets are untenable at scale (10k users ≈ $4,000/month in secret storage alone vs. cents in DynamoDB). One shared KMS key with per-item data keys gives equivalent protection with auditable IAM + KMS grants. Refresh handling: Spotify refresh tokens carry a six-month reauthorization horizon (2026 change) — a scheduled Lambda re-prompts before expiry; Apple developer token is regenerated ≤6 months; Amazon access token is refreshed every hour.

> **Amended — [PED](PED.md) D6 and D7.** The single-table design, the key layout, the
> GSIs and the TTLs above are all current. Two storage choices inside it change:
>
> - the table becomes **provisioned** (≤17 WCU/RCU total across every table *and*
>   index, shared account-wide), with an IAM `LeadingKeys` prefix per service;
> - the KMS CMK becomes an **AES-256-GCM data key held in an SSM SecureString**, cached
>   per cold start — a customer-managed key costs $1/month, which is not $0.
>
> The reasoning against per-user Secrets Manager secrets is unchanged and now stronger:
> Secrets Manager is banned outright.

### 7.8 Provider adapter interface

```python
class ProviderAdapter(Protocol):
    provider: str
    def search_by_isrc(self, isrc: str, market: str) -> list[TrackCandidate]: ...
    def search_by_text(self, title: str, artist: str, hints: Hints) -> list[TrackCandidate]: ...
    def create_playlist(self, user: UserCtx, name: str, description: str, public: bool) -> PlaylistRef: ...
    def add_tracks(self, user: UserCtx, playlist: PlaylistRef, track_ids: list[str]) -> AddResult: ...
    def rate_budget(self) -> RateBudget: ...        # req/window, batch size
    def capabilities(self) -> Capabilities: ...     # can_delete, can_reorder, add_position
```

Per-provider capability flags drive UX and test cleanup. **Verified capability values:**

- **Spotify:** `can_delete=True` (remove items), `add_position` supported, add batch = 100.
- **YouTube:** `can_delete=True`, one item per `playlistItems.insert`.
- **Apple:** `can_delete=False`, `can_reorder=False`, `add_position="end_only"` — per Apple engineer statements in Developer Forums: "Only the ability to add items to the Cloud Library and editable playlists is currently available in the Apple Music API," and "Apple Music API doesn't have any public API for reordering tracks in a playlist." Editing/removal via the Swift MusicKit `MusicLibrary` API works only for playlists the app created on Apple platforms, and "cannot edit playlists created via Apple Music API."
- **Amazon:** capabilities discovered at beta onboarding; assume create + modify gated by scope.

> **Amended — [ADR-004](adr/0004-language-map.md).** The interface is TypeScript, not a
> Python `Protocol`. The contract is unchanged. **The capability values above are
> verified findings and are encoded as data**, with a contract test asserting them —
> Apple's inability to delete or reorder is the load-bearing case, because it changes
> both the UI and how E2E tests clean up after themselves.

### 7.9 Extraction algorithm spec

> The six steps below are numbered `7.9.1` … `7.9.6` and are cited by that number from
> the implementation. They are headings rather than list items so those citations
> resolve to something that exists.

#### 7.9.1 Normalize

Unicode NFKC, strip zero-width, detect encoding.

#### 7.9.2 Deterministic pass

Regex/grammar for known patterns → candidate items with spans + high base confidence.

#### 7.9.3 Residual pass

Send un-parsed lines/prose to Bedrock Claude with a strict JSON schema (title, artist, hints, `source_span`). Use tool-use/structured output; temperature 0.

#### 7.9.4 Prompt-injection defense

Treat user text as untrusted **data, not instructions**; wrap it in a delimited data block; system prompt forbids following embedded instructions; validate output against schema; **reject items whose `source_span` text doesn't actually contain the claimed title/artist tokens** (anti-hallucination gate).

#### 7.9.5 Merge, dedup, score

Merge, dedup (normalized key); assign confidence (deterministic > LLM-grounded > LLM-ungrounded→rejected).

#### 7.9.6 Chunk long inputs

Token-budgeted overlapping windows; multilingual/transliteration handled by normalization + Claude.

> **Amended — [ADR-001](adr/0001-parser-home-typescript-core.md) and
> [ADR-007](adr/0007-deterministic-core-and-span-grounding.md).** The algorithm is
> unchanged; its home is not. It lives in `packages/core` as **TypeScript + zod** and
> runs on the device, in the browser and in Node Lambdas — one grammar, no drift.
>
> Two refinements the implementation makes explicit:
> - Spans index the **normalized** text, not the raw input. NFKC and zero-width
>   stripping both change length, so offsets taken against raw bytes drift.
> - Step 4's gate needs a **span-size cap** as well as token coverage. Without one, a
>   span covering the whole document trivially "contains" any invented title.
>
> Step 3's Bedrock call is off by default ([PED](PED.md) D9); the residual set it would
> receive is still computed and is exactly what an on-device LLM sees.

### 7.10 Matching algorithm spec

> As with §7.9, the steps are headings so the `7.10.N` citations in the implementation
> resolve.

#### 7.10.1 ISRC first

If **ISRC** present (from source, or resolved via MusicBrainz/Deezer/Odesli), query provider by ISRC first (Spotify `isrc:` filter; Apple `GET /v1/catalog/{storefront}/songs?filter[isrc]=`; YouTube via text since it exposes no ISRC).

#### 7.10.2 Normalized text search

Else normalized text search: lowercase, strip feat./remaster/live/remix tags into structured qualifiers, transliterate, remove punctuation. **Note:** Spotify's `/search` `limit` max is now **10** (reduced from 50 in Feb 2026), so paginate/deprioritize deep result scans.

#### 7.10.3 Score candidates

Weighted title similarity (token-set ratio), artist similarity, duration tolerance (±3 s default), version/qualifier match, popularity tiebreak.

#### 7.10.4 Confidence thresholds

**≥0.8 auto-accept; 0.5–0.8 flag for review; <0.5 mark not-found.**

#### 7.10.5 Cache

Cache match by ISRC/normalized-hash (TTL, ToS-compliant).

#### 7.10.6 YouTube heuristics

Prefer official audio / "Topic" channel results via channel/title heuristics.

**MusicBrainz constraints:** ≤1 request/sec per IP; a descriptive `User-Agent` (with contact) is mandatory or requests are throttled/blocked. This forces MusicBrainz lookups onto a rate-limited, cached path (its own SQS queue + token bucket), **not the hot request path**.

> **Amended — [ADR-002](adr/0002-line-orientation.md).** Matching gains a step: when the
> parser emitted an `alternate` reading because line orientation was uncertain, resolve
> it here — check both readings against the free catalogs (MusicBrainz, Deezer) and take
> the one whose best candidate wins by ≥0.10; otherwise keep the prior and send the item
> to review. This happens **before any provider call**, so it costs zero YouTube quota.
> Autonomous creation never proceeds on an unresolved orientation.
>
> The MusicBrainz constraints above are therefore load-bearing for correctness, not just
> for politeness. In the $0 profile the rate-limited path is a DynamoDB token bucket
> rather than an SQS queue ([PED](PED.md) D5).

### 7.11 Rate limiting, idempotency, error handling

- **Distributed token bucket** per provider in DynamoDB (conditional updates), sized **below** observed limits (Spotify conservative vs. ~180 req/min community figure; always honor `Retry-After`).
- **Idempotency:** Powertools for AWS Lambda idempotency utility keyed on `jobId+provider` for create and `jobId+provider+trackBatchHash` for add; DynamoDB idempotency store with TTL.
- **Retries:** exponential backoff with full jitter; honor `Retry-After` on 429; circuit breaker per provider (open on sustained 5xx). SQS **partial batch responses** so only failed records retry; DLQ after `maxReceiveCount` with redrive.

### 7.12 AWS service justification table

| Service | Used for | Why (vs alternative) | If not used |
|---|---|---|---|
| Lambda | All request handlers + adapters | Event-driven, per-provider concurrency isolation | — |
| Glue 5.1 | Bulk/large-file import, scheduled re-matching, analytics ETL, DQ checks | Genuine Spark batch over S3; cheaper than long Lambda for big files | Small jobs stay on Lambda/Distributed Map |
| SQS | Per-provider work queues | Rate-limit isolation, DLQ, backpressure | — |
| SNS | Fan-out job → provider queues | 1→N decoupling | — |
| Step Functions (Standard + Distributed Map) | Orchestrate resolve→create; large lists | Durable, visual, retries/catch; Distributed Map for 10k+ items | Express for sub-workflows |
| EventBridge | Domain events + schedules | Loose coupling; cron re-matching | — |
| API Gateway (REST + WebSocket) | Control plane + live progress | WebSocket chosen over polling (lower latency/fewer calls) and over AppSync (no GraphQL need) | AppSync if GraphQL adopted |
| DynamoDB | State, tokens, cache, rate buckets | Single-digit-ms, TTL, streams | — |
| S3 | Uploads + data lake | Durable object store, event source | — |
| Cognito | AuthN/user pools | Managed identity | — |
| Secrets Manager / KMS | App-level provider client secrets; KMS for per-user token encryption | KMS envelope far cheaper than per-user secrets | — |
| CloudFront + WAF | SPA + edge security | Standard | — |
| SES | Transactional email (job done, deletion confirm) | Managed email | — |
| CloudWatch + X-Ray/ADOT | Observability | Native | — |
| AppConfig | Feature flags, thresholds, provider on/off | Dynamic config without deploy | — |
| Athena | Ad-hoc analytics over lake | Serverless SQL | — |
| **AWS Batch** | **Intentionally NOT used** | Glue + Distributed Map cover batch needs; no custom container fleet warranted | Reconsider only if heavy non-Spark compute appears |

> **Superseded — [PED](PED.md) §5 and §12.** Most rows above are now on the **never-use
> list**. See `infra/free-tier/budget.yaml` (`never_use`) for the authoritative set and
> the cdk-nag pack that enforces it. The "intentionally NOT used" discipline in the last
> row is the right instinct, applied far more aggressively.

## 8. Environments & Account Strategy

- **Local:** SAM/CDK local + LocalStack for AWS emulation; provider calls hit recorded fixtures or the dev provider apps; Vite dev server for SPA.
- **dev / stage / prod:** three separate AWS accounts + a shared tooling account (artifacts, ECR, OIDC roles) under AWS Organizations.
- Per-environment config in AppConfig + SSM; per-environment **separate provider developer apps, credentials, and redirect URIs** (e.g., a Spotify dev app per env with its own allow-listed users; separate Google OAuth client per env; separate Apple MusicKit key per env). Data fully isolated per account — no cross-environment provider data mixing.

> **Superseded — [PED](PED.md) D15, D19 and §11.** **One account, per-environment
> stacks.** Joining an AWS Organization upgrades a free-plan account to paid and expires
> its credits immediately, and the free tier is aggregated across an org regardless.
> LocalStack's Community edition ended in March 2026, so local emulation is moto server
> + DynamoDB Local + ElasticMQ. Isolation comes from name prefixes, tags, per-env OIDC
> role scoping (`environment:<env>`), per-env permission boundaries, and separate
> Cognito pools and tables. The per-environment provider-app discipline is unchanged and
> still correct.

## 9. CI/CD Pipeline

**Decision:** GitHub Actions (not CDK Pipelines/CodePipeline). OIDC federation removes long-lived keys; GitHub Environments give native approval gates; single pane with code review. **Build once, promote the same artifact** dev→stage→prod (no rebuild per env). Progressive delivery via CodeDeploy canary/linear for Lambda with CloudWatch alarm-based auto-rollback; feature flags via AppConfig. Rollback runbooks documented per stack; post-deploy smoke tests + synthetic canaries.

**PR quality gates:** ruff, mypy/pyright, ESLint/Prettier; unit + coverage ≥85% (line) / ≥75% (branch); CodeQL + Semgrep SAST; dependency + secrets scanning; cdk-nag/checkov IaC scan; SBOM (CycloneDX). Conventional Commits + semantic versioning.

> **Superseded — [PED](PED.md) §13 and [ADR-005](adr/0005-credentials-branches-deploys.md).**
> Build-once-promote, OIDC and the approval gates are kept. Changed: AppConfig → SSM
> Parameter Store (D10–11); synthetic canaries dropped (CloudWatch Synthetics is on the
> never-use list); CodeDeploy canary is **prod only**, with ≤5 prod alarms (D12). The
> gate set gains KICS + 2MS as blocking, with Checkmarx One dormant behind `CX_ENABLED`.
> Branch policy is fixed by ADR-005: agents push `task/*` and fast-forward `develop`;
> **only the human merges to `main`**, and only that merge deploys prod.

## 10. Testing Strategy & Test Matrix

| Test type | Purpose | Tools | Env | When | Pass criteria |
|---|---|---|---|---|---|
| Unit | Parsers, normalizers, matchers | pytest, moto, Hypothesis | local/CI | every PR | ≥85% cov; property tests green |
| Integration | Real AWS wiring | **ephemeral CDK stacks** (recommended over LocalStack for fidelity) | dev | every PR/merge | resources behave; teardown clean |
| Contract | Detect provider API drift | recorded fixtures + JSON Schema validation + scheduled live canaries | stage | nightly | schemas match; canary green |
| Payload | Request/response + event schema, boundaries, Unicode/emoji/RTL/zero-width, malformed | JSON Schema, Schemathesis (OpenAPI fuzz), prompt-injection corpus | CI | every PR | no schema violations; injection blocked |
| Batch | Glue jobs, large files, idempotent reruns, bookmarks, DQ | Glue local container/Spark local, Glue DQ/Deequ | dev | merge | reruns idempotent; DQ rules pass |
| E2E | Full UI flow | Playwright + dedicated provider test accounts; verify via provider API | stage | pre-prod | playlist exists w/ expected tracks |
| Performance/load | Throughput/latency | k6/Artillery vs **provider simulator** (never real limits) | perf | pre-release | meets NFR-001/002 |
| Resilience/chaos | 429/5xx/timeouts, DLQ redrive | AWS FIS, fault injection | stage | scheduled | recovers; no data loss |
| Accuracy eval | Extraction + matching golden sets | pytest + metrics harness | CI | every PR | F1 ≥ target (regression gate) |
| Security | SAST + DAST | CodeQL/Semgrep + OWASP ZAP | CI/stage | PR/nightly | no high findings |
| Accessibility | WCAG | axe-core | CI | PR | no critical a11y violations |
| Mutation | Test suite strength | mutmut/cosmic-ray | CI (nightly) | nightly | mutation score ≥60% core modules |

**Regression gating despite nondeterministic LLM output:** accuracy tests run the extractor at temperature 0 against a frozen golden set and assert **F1 ≥ threshold** (not exact string equality), using normalized (title, artist) matching. A small tolerance band prevents flakiness while still catching regressions.

**E2E cleanup note:** Because the Apple Music API cannot delete playlists or remove tracks, Apple E2E uses disposable test accounts; the harness tags test playlists and ages them for out-of-band cleanup rather than API deletion. Spotify and YouTube support deletion, so their tests self-clean.

> **Superseded — [PED](PED.md) §14, [ADR-004](adr/0004-language-map.md) and
> [ADR-006](adr/0006-test-data.md).** Tooling follows the language map: Vitest +
> fast-check + aws-sdk-client-mock for TypeScript, pytest + Hypothesis for the Python
> exceptions. Mutation targets rise: Stryker ≥70% on `packages/core`, ≥65% elsewhere;
> mutmut ≥70%. FIS is on the never-use list, so chaos testing uses flags
> (`fault.yt.429`, `fault.ddb.throttle`, `fault.latency.ms`). Load tests never touch
> AWS.
>
> The **regression-gating reasoning above is retained verbatim in the implementation** —
> normalized (title, artist) matching with an F1 threshold rather than string equality —
> and [ADR-006](adr/0006-test-data.md) adds the rule it was missing: expected outputs are
> generated truth-first from an external catalog, never from parser output.

## 11. Metrics

**Product success.**

- Extraction precision ≥0.95, recall ≥0.90, F1 ≥0.92 at (title, artist) pair level (normalized).
- Match accuracy ≥0.93; **wrong-song rate <2%**.
- Platform coverage (found/total) ≥0.90 for Spotify/Apple, ≥0.85 for YouTube.
- E2E playlist-creation success ≥98%; time-to-playlist p95 <90 s (50 songs).
- User correction rate <15%; activation (first playlist created) ≥60% of connectors; W4 retention target set post-beta.

**SLIs/SLOs.** API availability 99.9%; parse p95 <6 s; create p95 <90 s; SQS oldest-message-age <120 s; DLQ depth = 0 (alarm on >0); provider 429 rate <5% of calls; cost/playlist <$0.02.

**Testing/quality.** Coverage ≥85%; mutation ≥60% core; flaky-test rate <1%; defect escape rate <5%/release; E2E pass ≥98%.

> **Amended — [PED](PED.md) §14, [ADR-004](adr/0004-language-map.md).** The mutation
> floor rose: **Stryker ≥70% on `packages/core` and ≥65% elsewhere; mutmut ≥70%** for
> the Python that remains. The ≥60% above is superseded — see
> [`../CLAUDE.md`](../CLAUDE.md) for the floors actually enforced. Everything else in
> this block stands.

**DORA.** Deploy frequency: daily to dev, ≥weekly to prod; lead time <1 day; change failure rate <15%; MTTR <1 h.

> **Superseded — [PED](PED.md) §15.** Availability drops to 99.5%, cost/playlist to
> $0.00, and MTTR to <4 h (one maintainer, not a rota). The extraction and matching
> targets above **still apply** and are the ones the accuracy gate enforces.

## 12. Phase-Wise Delivery Plan

**External dependencies on the critical path (start day 1):** Google OAuth verification (can take weeks for sensitive scopes), Apple Developer Program enrollment, Spotify dev app (dev mode immediate; extended quota gated by MAU + up to 6-week review), Amazon Music closed-beta request (may never be granted). Put all of these in flight before Phase 2.

- **Phase 0 — Foundations/CI-CD & environments.** Org accounts, OIDC, CDK skeleton, pipelines, observability baseline. *Exit:* green pipeline deploys a hello-world stack dev→stage→prod; cdk-nag clean; dashboards exist.
- **Phase 1 — Parsing engine.** Deterministic + Bedrock hybrid, golden set, prompt-injection defenses. *Exit:* extraction F1 ≥0.92 on golden set in CI; injection corpus 100% blocked.
- **Phase 2 — Matching + first provider (YouTube Music).** ISRC + fuzzy matching; YouTube adapter; quota budgeting. *Exit:* E2E creates a real YouTube playlist from text; match accuracy ≥0.90 on golden set; quota model documented (see R2).
- **Phase 3 — Async pipeline hardening.** SNS/SQS/Step Functions, idempotency, DLQ/redrive, rate limiting, WebSocket progress. *Exit:* chaos test (429/5xx) recovers with zero duplicate playlists; DLQ redrive verified.
- **Phase 4 — Spotify (dev mode) + Apple Music.** Add adapters; Apple capability limits encoded. *Exit:* E2E on both in stage with test accounts; Spotify operates within dev-mode user cap; documented go-live gate for Spotify extended quota.
- **Phase 5 — Batch/Glue.** Large-file import, scheduled re-matching, analytics ETL + Athena + DQ. *Exit:* 5,000-song file import idempotent; DQ rules pass; Athena dashboards live.
- **Phase 6 — Frontend UX.** Review/fix low-confidence flow, multi-platform selection, a11y. *Exit:* axe clean; Playwright E2E green; usability pass.
- **Phase 7 — Hardening/security/load.** DAST, FIS, k6 vs simulator, cost tuning. *Exit:* no high security findings; load meets NFR-002; cost/playlist target met.
- **Phase 8 — Beta.** Invite users (Spotify limited to dev-mode allow-list; YouTube/Apple broader). *Exit:* SLOs met for 2 weeks; wrong-song rate <2%.
- **Phase 9 — GA.** Public launch on YouTube + Apple; Spotify remains dev-mode-limited until MAU threshold; Amazon gated on beta access. *Exit:* GA runbooks, on-call, error-budget policy in place.

Each phase decomposes into increments that each end green + deployable.

> **Superseded — [PED](PED.md) §16 and [ADR-003](adr/0003-build-order-m0-first.md).**
> The phase plan is replaced by M0–M8 with a Free-Tier Gate at every exit, and M0 is
> split at the credential boundary (M0a / CORE / M0b) so nothing waits on a human. Apple
> Music and Amazon Music phases are cut entirely. The authoritative decomposition is
> [`plan/TASKS.yaml`](plan/TASKS.yaml).

## 13. Risks & Cost Model

**Risks.**

- **R1 (High):** Spotify Extended Quota Mode requires **≥250k MAU** (registered business, launched service, key markets; up to 6-week review, no guarantee). *Mitigation:* launch on other providers first; run Spotify in dev mode; pursue the business/review path only when scale justifies. **Hard external gate.**
- **R2 (Medium):** YouTube **10,000 units/day** quota. With `search.list`=100 and inserts=50, a 40-song playlist that searches every track costs ~40×100 + 1×50 + 40×50 = **~6,050 units** — i.e., roughly **one 40-song playlist per project per day** on default quota. *Mitigation:* resolve via ISRC/MusicBrainz/Deezer first to avoid `search.list`; cache aggressively; batch; request the quota-extension audit early; per-user quota accounting.
- **R3 (Medium):** Apple cannot delete/edit/reorder playlists via API. *Mitigation:* set UX expectations; disposable test accounts; no reliance on API cleanup.
- **R4 (Blocking):** Amazon Music API closed beta (Amazon "not onboarding any partner"). *Mitigation:* phase is go/no-go; ship without Amazon; provide export fallback.
- **R5:** Provider policy/endpoint drift (Spotify's Nov 2024 + Feb 2026 removals show precedent). *Mitigation:* scheduled contract canaries; monthly policy review.
- **R6:** Prompt injection / hallucinated songs. *Mitigation:* span-grounding gate, schema validation, injection test corpus.

**Cost model** (order-of-magnitude, excluding provider fees). Per 50-song playlist: Bedrock Haiku 4.5 ($1/$5 per M tokens) extraction over a few thousand tokens ≈ sub-cent; Lambda + DynamoDB + SQS ≈ sub-cent; **total well under $0.02**. Monthly: 1k playlists ≈ tens of dollars; 10k ≈ low hundreds; 100k ≈ low thousands, dominated by Bedrock + Lambda + NAT/data transfer. Token storage on DynamoDB + KMS avoids the ~$4,000/month Secrets-Manager-per-user trap at 10k users (Secrets Manager = $0.40/secret/month + $0.05/10k calls).

> **Superseded — [PED](PED.md) §17.** The cost model is replaced by a hard $0 target
> with structural enforcement. **R2 is now the binding constraint on the entire
> product**: at 800 units per 15-song playlist and a 7,000-unit prod share, that is
> ~8 playlists/day, ~250/month — and its mitigation (resolve via ISRC first, avoid
> `search.list`) is load-bearing rather than an optimisation. R6's mitigation is
> unchanged and is implemented in
> [ADR-007](adr/0007-deterministic-core-and-span-grounding.md).

## 14. Security, Privacy, Compliance

- Cognito auth; WAF; least-privilege IAM per Lambda; KMS envelope encryption for tokens; app secrets in Secrets Manager; TLS everywhere.
- **Spotify Developer Terms compliance:** no ML training/ingestion of Spotify Content (Developer Terms v10 / Policy §III.14, effective May 15, 2025); only temporary caching of metadata/cover art (no aggregation/compilation/database of Spotify Content); on disconnect, "delete and no longer request or process any of that user's Spotify Personal Data"; branding/attribution per Design & Branding Guidelines; privacy policy required.
- **YouTube API Services compliance:** privacy policy, data refresh/retention rules, OAuth verification for sensitive scopes, disclose scopes, provide a revocation path.
- **Apple:** identity/branding guidelines; subscription-gated writes; developer token per env.
- **GDPR/CCPA:** `GET /me/export`, `DELETE /me`, per-provider disconnect deletes tokens + provider PII; audit trail of deletions.

> **Superseded — [PED](PED.md) D2, D7, D10–11 and §10.6.** WAF becomes the CloudFront
> flat-rate Free plan; KMS CMK becomes an SSM SecureString data key; Secrets Manager is
> banned. **Every compliance obligation above is unchanged** — they are provider terms,
> not architecture. The PED adds: images are never persisted server-side, EXIF/GPS is
> stripped on the device and again on the server, and event payloads carry identifiers
> only, never song names or personal data.

## 15. Claude Code Implementation Guide

**Monorepo structure.**

```text
setlist/
  CLAUDE.md
  .claude/{agents,skills,hooks,commands}/
  infra/                  # AWS CDK (TypeScript)
  services/
    parse_preview/        # Python 3.13 Lambda
    matcher/
    adapters/{spotify,youtube,apple,amazon}/
    orchestration/        # Step Functions defs
    batch_glue/           # Glue 5.1 jobs
  packages/core/          # shared: models, parsers, normalizers
  web/                    # React + TS SPA
  tests/{unit,integration,e2e,contract,payload,accuracy,load}/
  golden/                 # extraction + matching golden sets
  .github/workflows/
```

**CLAUDE.md outline.** Conventions (ruff, mypy strict, ESLint/Prettier, Conventional Commits, semver); commands (`make test`, `make lint`, `cdk deploy dev`, `npm run e2e`); testing requirements (write tests first; coverage ≥85%; accuracy gates must pass); definition of done (green CI, deployable, docs updated); **guardrails: never commit secrets; never deploy to prod outside the pipeline; never call real provider APIs in unit tests; treat all user text as untrusted; never train models on or persist provider content beyond ToS limits.**

**Claude Code workflow.** Use **plan mode** to decompose each phase; **subagents** for isolated tasks (e.g. a single provider adapter) to keep the main context small; **hooks** to enforce block-secrets + format-on-write + test-on-stop deterministically; **skills/custom slash commands** for repeated flows (`/new-adapter`, `/run-accuracy`); **headless mode + Claude Code GitHub Actions** for CI-driven fixes and PR review; **CLAUDE.md as the always-on project constitution**; **MCP** only if a controlled provider tool is genuinely needed; manage context with per-phase scope and a documented `/compact` policy. Use permission modes to keep destructive actions gated.

**Epic/task example (Given/When/Then).**

- *Epic P2:* YouTube adapter. *Task:* `search_by_isrc`. **Given** an ISRC, **when** resolved via MusicBrainz then YouTube text search, **then** returns ranked candidates with confidence and cites `videoId`. *DoD:* unit + contract tests green; quota cost logged; idempotent.

**Human-in-the-loop checkpoints (Claude Code cannot do these):**

- Create AWS accounts / the Organization.
- Register developer apps: Spotify, Google Cloud OAuth client, Apple MusicKit key (`.p8`), Amazon Music (request beta via BD contact).
- Enroll in the Apple Developer Program; complete Google OAuth verification; request the YouTube quota-extension audit; apply for Spotify Extended Quota (only when eligible).
- Provision secrets (client IDs/secrets, Apple `.p8`) into Secrets Manager.
- Create provider test accounts (Apple account must have an active Apple Music subscription) for E2E.
- Approve stage/prod deployments in GitHub Environments.

> **Superseded — [PED](PED.md) §18 and [ADR-005](adr/0005-credentials-branches-deploys.md).**
> The monorepo layout is expanded (the PED's 13 catalog rows become 15 service
> directories, since the adapters share one row, plus `kill-switch` and
> `usage-sentinel` — 17 in all — with `mobile/`, `tools/`, `security/`,
> `packages/{contracts,etl,api-client}`) and `packages/core` is TypeScript. The hook is
> not a formatter or a preflight wrapper: it is a **guard that blocks `aws`,
> `cdk`/`sam deploy`, force pushes, pushes to `main`, `gh pr merge` and `gh secret`
> outright**. Secrets go to SSM Parameter Store, not Secrets Manager. The HITL list is
> expanded click-by-click in [`hitl/`](hitl/).
>
> The **guardrail list above is unchanged and remains in force** — it is reproduced in
> [`../CLAUDE.md`](../CLAUDE.md).

## 16. Open Questions

- Will Amazon Music grant beta access? If not, is export-only acceptable for that provider?
- Will the business pursue the Spotify 250k-MAU/registered-business path, or remain dev-mode indefinitely?
- Do we need `.docx`/`.pdf` parsing in v1, or defer alongside OCR?
- Final confidence thresholds after first golden-set calibration?
- Which AWS region(s) for data residency, given Bedrock model availability?

> **Resolved or superseded.** Amazon and Apple are out of scope at $0; Spotify stays
> dev-mode and conditional on owner Premium. Region is **us-east-1** ([PED](PED.md) §11).
> Bedrock availability is moot while it is flagged off. Threshold calibration is still
> open and is tracked in [`README.md`](README.md); the current values live in one place,
> `packages/core`'s confidence module, precisely so recalibration is a single diff.

## 17. References (official docs used)

- **Spotify:** "Updating the Criteria for Web API Extended Access" (2025-04-15); Rate Limits concept doc; Create Playlist reference; Add Items to Playlist reference; Search reference (ISRC filter); "Introducing some changes to our Web API" (2024-11-27); Developer Terms; Developer Policy.
- **Apple:** MusicKit / Apple Music API docs — Create a New Library Playlist, Add Tracks to a Library Playlist, Search, Get Multiple Catalog Songs by ISRC, Get a User's Storefront, User Authentication for MusicKit; WWDC22 "Meet Apple Music API and MusicKit"; Apple Developer Forums (delete/reorder limitations).
- **Google:** YouTube Data API v3 — Determine Quota Cost; OAuth 2.0 for Web Server Apps; API Services Developer Policies.
- **Amazon:** Amazon Music Web API — Overview, Authentication (LWA), Playlist, Library, Errors (closed beta).
- **MusicBrainz:** API Rate Limiting; API docs (User-Agent requirement).
- **AWS:** Lambda runtimes doc; "AWS Lambda adds support for Python 3.13/3.14"; Glue 5.1 and Glue 6.0 announcement blogs; Powertools for AWS Lambda (idempotency); Secrets Manager pricing.
- **Anthropic:** Claude Code documentation and best practices (CLAUDE.md, subagents, hooks, skills, headless/GitHub Actions); Bedrock/Claude pricing.
- **Prior art:** Soundiiz, TuneMyMusic, SongShift, FreeYourMusic (metadata- vs ISRC-based matching; review-before-transfer patterns).
