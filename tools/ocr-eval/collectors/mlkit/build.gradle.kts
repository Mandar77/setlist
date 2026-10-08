// Versions resolved from Google's Maven repository, never written from memory. Maven
// Central's copy of com.android.tools.build:gradle stops at 2.3.0, so "latest" from the
// wrong registry is wrong by nearly a decade — and it fails as a confusing resolution
// error rather than as "no such version". See README.md.
//
// AGP 9.4.1 is the latest STABLE. The repository's own `release` marker points at
// 9.5.0-alpha08; this project does not take alphas.
// Kotlin 2.4.20 is the latest STABLE from maven-metadata.xml. Worth recording how that
// was established, because three sources gave three answers: memory said 2.2.20, Maven
// Central's solr search said 2.2.0 (it does not sort by version), and only the
// authoritative metadata says 2.4.20 — whose own `release` marker points at 2.5.0-Beta1,
// which this project does not take either. A version written from any of the first two
// would have been plausible, well-formed and wrong.
plugins {
    id("com.android.application") version "9.4.1" apply false
    id("org.jetbrains.kotlin.android") version "2.4.20" apply false
}
