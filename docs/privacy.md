# Privacy

SponsorScope is used by people whose ability to stay in a country may depend on
the decisions they make with it. A record that someone was researching visa
sponsorship is sensitive in a way that ordinary browsing data is not, so the
project is built so that record largely cannot exist.

The guarantees below are structural, not policy. There is no user table to leak
and no session to subpoena because the code has nowhere to put one.

---

## What is stored on your device

All of this lives in `chrome.storage.local` and is never transmitted anywhere.

| Data | Where | Lifetime |
| --- | --- | --- |
| Resume text | `resume:data` | Until you delete it |
| Resume embedding | `resume:data` | Invalidated when the text or model changes |
| Settings | `settings:data` | Until changed |
| Lookup cache | `cache:*` | 7 days, max 500 entries |

**Deleting your resume** is a control on the options page. It removes the text,
the computed embedding, and the derived match cache in one operation — a delete
that left the embedding behind would be a lie, since the vector is derived from
the text.

Uninstalling the extension removes all of it.

---

## What is sent to the backend

One request, made when you open a job or company page:

```
GET /v1/company?name=Acme+Corp&country=US
```

That is the complete payload. Specifically:

**Sent**

- The company name displayed on the page — already public information you are
  currently looking at.
- A two-letter country code, when we can infer one from the posting's location.
- Optionally, the employer's own web domain when the page exposes it.

**Not sent**

- Your resume, or anything computed from it
- The job description
- The page URL, job id, or job title
- Any user, device, session, or installation identifier
- Any cookie — the request is made with `credentials: 'omit'`, and the API sets
  no cookie in response

The resume never leaves your machine because **there is no endpoint that would
accept it**. Removing it from the client would not create a leak; there is
nothing on the server side to leak into.

---

## What the backend stores

One table, [`lookup_counters`](../backend/app/models.py):

| normalized_name | day | count |
| --- | --- | --- |
| `acme` | 2026-08-17 | 41 |

A normalised company name, a date, and a counter. It exists to show which
companies need alias curation, which is the main thing limiting match quality.

It is deliberately shaped so it cannot become a profile: no IP, no user agent,
no session id, no request ordering, no timestamps finer than a day, and nothing
joinable to any other record. Two lookups by the same person and two lookups by
different people are indistinguishable in it.

Increments happen after the response is computed, so telemetry can never
influence what you get back, and a failure to record is swallowed rather than
failing the request.

### Client IP addresses

The rate limiter uses the client IP as a throttling key, because an
unauthenticated public API has no other handle to throttle on. It is held
transiently in Redis for the length of the rate-limit window and is not written
to the database, not associated with the company being looked up, and not
retained.

If you would rather not send an IP to our deployment at all, self-host — the API
and the pipelines are MIT licensed, and the options page accepts any base URL.

---

## What the backend has no capacity to do

- **No accounts.** No user table, no session table, no credential of any kind.
- **No authentication.** There is no API key, so there is nothing tying requests
  together across time.
- **No cross-request linkage.** Responses are pure functions of the query.

---

## Third-party requests

The extension makes network requests to exactly one host: the configured API
base URL.

The interview and referral features build **links**. Nothing is fetched until
you click one, and clicking opens a normal tab under your own session — the same
as typing the search yourself. The extension does not read those pages, does not
know whether you clicked, and does not aggregate anything from them.

The one exception is an employer's own website for the leadership-page lookup,
which is fetched only after you grant host permission for that specific domain
through Chrome's own permission prompt.

---

## The embedding model

The sentence-embedding model is vendored into the extension bundle at build time
and loaded from `chrome.runtime.getURL`. It is never fetched at runtime.

This is partly a Chrome Web Store requirement — remote code execution is
grounds for rejection — and partly a privacy property: a model downloaded on
first use would tell a third-party CDN the moment you started looking at job
postings, which is exactly the signal this project is trying not to create.

---

## Permissions, and why each is needed

| Permission | Why |
| --- | --- |
| `storage` | The resume, settings, and cache |
| `activeTab` | Opening links from the panel. Deliberately not `tabs`, which would grant read access to every tab's URL |
| `offscreen` | Hosting the embedding model outside the service worker |
| `host_permissions: api.sponsorscope.dev` | The one API call |
| `optional_host_permissions` | Requested at the moment of use for a custom API endpoint or an employer's own site — never taken up front |

Content script matches are path-scoped — `https://www.linkedin.com/jobs/view/*`
rather than `https://www.linkedin.com/*` — so the extension does not run on your
feed, messages, or profile.

---

## Verifying any of this

Everything above is checkable:

- `extension/src/background/api.ts` — the only outbound request
- `extension/src/lib/storage.ts` — everything written locally
- `backend/app/models.py` — every table that exists
- `backend/app/service.py` — `record_lookup` is the entire analytics surface

Load the extension unpacked, open DevTools, and watch the network tab. If you
find a discrepancy between this document and the code, that is a bug — please
open an issue.
