# Adding a job board

The adapter pattern exists for this. If adding a board requires changing
anything in `src/content/`, `src/background/`, or `src/lib/`, the abstraction is
wrong and that is worth raising in the PR.

## The contract

Implement [`JobBoardAdapter`](../extension/src/adapters/types.ts):

```ts
export interface JobBoardAdapter {
  readonly id: string;
  readonly label: string;
  matches(url: URL): boolean;
  detectPageType(url: URL, doc: Document): PageContext['pageType'] | null;
  extract(url: URL, doc: Document): PageContext | null;
  findPanelAnchor(pageType: PageContext['pageType'], doc: Document): Element | null;
}
```

## Steps

1. Create `src/adapters/<board>.ts`.
2. Register it in [`src/adapters/registry.ts`](../extension/src/adapters/registry.ts).
3. Add path-scoped matches to `content_scripts.matches` in
   [`public/manifest.json`](../extension/public/manifest.json).
4. Add `tests/<board>-adapter.test.ts`.

## The five things that go wrong

### 1. A thrown selector takes down the whole panel

Content scripts have no error boundary. Use `safeQuery`, `safeText`, and
`safeBlockText` from [`types.ts`](../extension/src/adapters/types.ts) — they take
a **list** of selectors, try each in turn, and return `undefined` instead of
throwing.

```ts
const company = safeText(doc, [
  '.new-class-name',      // newest first
  '.previous-class-name', // keep the old ones; regional and cached variants lag
  '.legacy-public-page',
]);
```

When a selector breaks, add the new one to the front of the list rather than
replacing the list.

### 2. Returning a half-extracted context instead of `null`

The content script treats `null` from `extract` as "not ready — retry on the
next mutation" and a returned context as "this is the page". On a single-page
app the company name often renders a frame or two before the description.

```ts
const companyName = safeText(doc, SELECTORS.companyName);
if (!companyName) return null;   // not ready — do NOT return a partial context
```

Returning a partial context is the most common way to get a panel showing the
*previous* job's company next to the current job's description.

Missing *optional* fields are fine — a context with no `jobDescription` renders a
degraded panel, which is correct.

### 3. Flattening the job description

Use `safeBlockText`, not `safeText`, for the description. It preserves line
breaks.

The [phrase detector](../extension/src/lib/sponsorship-phrases.ts) scopes
negation to clauses, and clause boundaries come from sentence terminators and
newlines. Flattening

```
- Must have existing right to work
- Visa sponsorship available for exceptional candidates
```

into one line merges two contradictory statements into one clause, and which one
wins becomes arbitrary. This is a correctness bug in the feature most likely to
mislead someone, not a formatting nicety.

### 4. Unstable page keys

`PageContext.key` is how the content script knows the page changed. Many boards
render postings into a pane without changing the path — on LinkedIn's search
page the posting id is in `?currentJobId=`, and keying on the path alone makes
every posting look like the same page, so the panel never updates.

```ts
export function jobKey(url: URL, companyName: string): string {
  const id = url.searchParams.get('currentJobId')
    ?? /^\/jobs\/view\/(\d+)/.exec(url.pathname)?.[1]
    ?? companyName;
  return `board:job:${id}`;
}
```

The key must also be *stable* across query noise — tracking parameters change
between renders of the same posting, and keying on the full URL causes constant
re-renders.

### 5. Scoping match patterns too tightly *or* too loosely

Scope to the site's **job section**, not to the whole domain and not to
enumerated sub-paths:

```jsonc
// Too broad — runs on the feed, messages, and profiles
"matches": ["https://www.linkedin.com/*"]

// Too narrow — this was a real bug
"matches": [
  "https://www.linkedin.com/jobs/view/*",
  "https://www.linkedin.com/jobs/search/*",
  "https://www.linkedin.com/jobs/collections/*"
]

// Right
"matches": ["https://www.linkedin.com/jobs/*"]
```

The middle version shipped first and looked careful. LinkedIn also serves the
identical two-pane posting UI from `/jobs/search-results/`, so on that path the
content script never injected and the panel simply never appeared — with no
error in the console, because nothing had run. Enumerating sub-paths buys no
real privacy over scoping to the section, and it breaks silently every time the
site adds a route.

Keep the adapter's own path regex equally broad (`/^\/jobs(\/|$)/`) and let
`extract` return `null` on job-section pages that have no posting on them.

**Add the URL to [`tests/manifest.test.ts`](../extension/tests/manifest.test.ts).**
That suite asserts the manifest injects on every URL the adapter claims — the
gap between those two files is invisible to unit tests of either one, which is
exactly how the bug above survived a green suite.

## Testing

Fixture-based tests cannot prove your selectors match the live site — only
running against it can. What they *can* pin down is the contract:

- a missing element degrades rather than throwing
- a not-yet-rendered page returns `null`
- page keys distinguish postings and survive query noise
- the description retains its line structure

See [`tests/linkedin-adapter.test.ts`](../extension/tests/linkedin-adapter.test.ts).

## Country inference

If the board exposes a location string, pass it through `inferCountry` from
[`lib/country.ts`](../extension/src/lib/country.ts). Returning `undefined` is
fine and meaningful — the backend then checks every register it holds rather
than guessing one.
