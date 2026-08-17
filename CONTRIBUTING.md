# Contributing

Thanks for looking. SponsorScope is MIT licensed and contributions of every size
are welcome.

## Where help is most useful

**Company aliases.** The highest-value, lowest-friction contribution. Entity
resolution is the main thing limiting match quality, and no amount of algorithm
work bridges "Amazon" to "AMAZON.COM SERVICES LLC" — that needs a curated
mapping. Add rows to [`backend/seed/aliases.csv`](backend/seed/aliases.csv) and
open a PR. No setup required.

**False positives in the posting-text detector.** If the panel says a posting
mentions sponsorship when it does not (or the reverse), open an issue with the
**exact sentence**. Those sentences go into
[`sponsorship-phrases.test.ts`](extension/tests/sponsorship-phrases.test.ts)
before the detector is changed.

**Wrong entity matches.** The panel has a "this doesn't look like the right
company" link that pre-fills an issue with both names.

**New job boards** — see [docs/adding-a-job-board.md](docs/adding-a-job-board.md).

**New countries** — see [docs/adding-a-country.md](docs/adding-a-country.md).

## Setup

See [Local setup](README.md#local-setup). Both test suites run without a
database or network access:

```bash
cd extension && npm install && npm test
cd backend   && uv venv && uv pip install -e ".[dev]" && pytest
```

## Project constraints

These are decisions, not gaps. A PR that changes one of them needs to argue for
the change first, in an issue.

- **No accounts, no login, no server-side user data.** The backend must remain
  unable to identify a caller.
- **No automated interaction with any job board.** Read the DOM of a page the
  user is already viewing. No headless browsers, no undocumented internal APIs,
  no searches performed on the user's behalf. Where we want to point at a
  third-party result, build a URL and open a tab.
- **The resume never leaves the device.** There is no endpoint that accepts it,
  and there should not be.
- **No remote code.** Everything executable ships in the bundle.
- **Light theme only.**
- **Minimal permissions.** Path-scoped host matches; `activeTab` over `tabs`;
  broad host access requested at the moment of use.

## Code conventions

**Design tokens are the single source of truth.** Never hardcode a colour or a
spacing value. Add it to
[`extension/src/design/tokens.ts`](extension/src/design/tokens.ts) and run
`npm run build:tokens`. A test fails if the generated CSS is stale, and another
fails if a palette change drops below WCAG AA contrast.

**Never signal status by colour alone.** Every status in the panel pairs its
tint with an icon, a border style, and a text label. This is an accessibility
requirement and also a plain-legibility one — the verified and unverified badges
must be impossible to confuse.

**Preserve the three distinctions.** No-record vs. does-not-sponsor,
verified vs. posting-claimed, certain vs. possible. They are encoded in the
types so they cannot be collapsed by accident; please do not collapse them on
purpose either.

**Provenance is not optional.** Anything that emits a figure emits its source
and publication date with it.

**Adapters fail silently and degrade.** Log and skip; never throw into a content
script, and never guess at a missing field.

**Comments explain why.** The codebase has a lot of them, concentrated on the
decisions that are not obvious from the code — why `history.pushState` cannot be
patched from a content script, why `token_set_ratio` alone matches "Apple" to
"Apple Bank", why the offscreen document exists. Please keep that up; skip the
comments that restate the line below them.

## Tests

New behaviour needs a test. In particular:

- **Phrase detection** — add the real sentence, both polarities where relevant.
- **Entity resolution** — add the real company-name pair. A test asserting a
  `possible` band rather than a match or a miss is the intended contract, not a
  weak test: the product's answer to genuine ambiguity is to show it.
- **ETL parsing** — add a fixture row shaped like the real file, mess included.
- **Adapters** — test the contract (degradation, not-ready, key stability), not
  the selectors.

```bash
cd extension && npm test && npm run typecheck
cd backend   && pytest && ruff check .
```

## Pull requests

Small and focused beats large and comprehensive. Describe what changed and why;
if it touches entity resolution, phrase detection, or the status-rendering
rules, say what you did to convince yourself it does not make the panel confidently
wrong — that is the failure mode this project cares most about.

## Reporting a privacy discrepancy

If you find behaviour that contradicts [docs/privacy.md](docs/privacy.md), that
is a bug and a serious one. Open an issue.
