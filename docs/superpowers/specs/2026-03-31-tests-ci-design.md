# Tests & CI/CD Design

## Overview

Add frontend unit tests for logic-heavy code and a GitHub Actions CI pipeline that runs typecheck + tests on every push and PR.

## Frontend Unit Tests

Test pure functions and hooks in `apps/ionosphere` — no DOM environment, no component rendering.

### What to test

**Timestamp calculations:**
- TimestampProvider's time broadcast logic (currentTimeNs offset adjustment)
- Seek callback adjustment (ns → seconds + offset)

**Transcript position mapping:**
- Compact transcript decoding → word positions (the time→Y mapping that drives brightness wave)
- Boundary time calculations (shared midpoints between adjacent words)
- Time-to-word-index lookup

**Concept facet overlay:**
- Byte range → word span matching
- Overlapping facet merging
- concept-ref facet extraction from mixed facet arrays

### What NOT to test

- React component rendering (TranscriptView, VideoPlayer) — these are visual and better caught by design review
- HLS video playback — depends on browser APIs
- API integration — depends on running appview

## CI/CD Pipeline

### GitHub Actions workflow

**File:** `.github/workflows/ci.yml`

**Triggers:** push to `main`, pull requests to `main`

**Steps:**
1. Checkout
2. Setup Node 24 + pnpm
3. `pnpm install`
4. `pnpm -r typecheck`
5. `pnpm -r test`

### What's NOT in CI (yet)

- **`next build`** — requires a running appview with data, which needs PDS + SQLite. Add when we set up a CI data fixture or build-time API mock.
- **Panproto WASM tests** — skip gracefully when WASM binary isn't present. No WASM build in CI. These tests gate locally, not in CI.
- **Enrichment/publish jobs** — need OpenAI API key and PDS credentials. Add as separate workflows with GitHub Actions secrets when ready.
- **Linting** — no linter configured. Add during a style pass.

### Secrets strategy

Current workflow needs zero secrets — pure static analysis + unit tests with local/mocked data.

Future secrets (when needed):
- `OPENAI_API_KEY` — for enrichment CI jobs
- `PDS_URL`, `BOT_HANDLE`, `BOT_PASSWORD` — for publish/integration CI jobs
- Stored as GitHub Actions secrets, never in code or `.env` committed to repo

### `.env` handling

`.env` stays in `.gitignore` (already is). CI uses no env vars for the current workflow. Future workflows use GitHub Actions secrets → env vars.
