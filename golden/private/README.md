# Private golden data

**This repository is public.** Plaintext photographs of people's handwriting must
never be committed here.

| What | Tracked? |
| --- | --- |
| `incoming/` — where you drop photos during Session 3 | no, git-ignored |
| `*.age` — age-encrypted archives | yes |
| `INDEX.md` — pointers and SHA-256 checksums | yes |
| any `.jpg` / `.png` / `.heic` | no, git-ignored |

The encryption key is a GitHub secret. Decryption happens only in CI runs on
`develop` and `main`, and the plaintext is deleted after encryption rather than kept
"just in case".

See [ADR-006](../../docs/adr/0006-test-data.md) and
[Session 3](../../docs/hitl/SESSION-3.md).
