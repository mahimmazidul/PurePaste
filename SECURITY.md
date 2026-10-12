# Security policy

Slip is an unauthenticated, link-only store on a clock. That shape decides what is a vulnerability here, so both lists below are worth reading before you spend effort on a report — and before you decide that a behaviour is a bug.

## In scope

Anything where a paste can be read, spent, replaced or kept by someone who should not be able to:

- **A paste readable without its link** — a listing, an index, an enumeration that works, a predictable id, or a route that accepts something other than the exact id.
- **A burn-after-read paste that survives its one read** — a reveal that succeeds twice, or a path (`/p/:id/media`, `/download`, a preview) that shows the body without claiming the row. The claim is a conditional `UPDATE … WHERE consumed_at IS NULL`, and any way around it is a real finding.
- **A password-protected paste read without the passphrase** — or a stored verifier weak enough to guess offline. The verifier is PBKDF2-SHA-256 with a documented iteration count; a report that lowers it, or that recovers text from the row alone, is in scope.
- **An end-to-end encrypted slip the server can open** — anything kept server-side that lets the ciphertext be recovered, or the key from the URL `#` fragment reaching the server at all: a query string, a log line, a referrer header, an error message. The fragment is the design, so leaking it is the worst bug this project can have.
- **The management key** obtained, forged or brute-forced from what is stored (a fingerprint, not the token), or accepted somewhere it can leak — the delete route takes it in the `X-Manage-Token` header and never in a URL.
- **Stored bytes executed or drawn as markup** — the media route answering with an uploaded HTML, SVG or XML document; a sniffed `Content-Type` where the allowlist should have refused; a `javascript:` or non-HTTP destination accepted in a short link; any response that ends up scriptable in a same-origin page.
- **Expiry that does not mean anything** — an object that outlives its row, a sweep that leaves a body reachable, a `MAX_TTL_SECONDS` ceiling that can be exceeded, or ids that become guessable because a counter or timestamp leaked into them.
- **The visitor's browser coerced into a request it should not make** through a paste: an SSRF-shaped redirect, a fetch to another origin provoked by stored content, or a CSP hole in `img-src` / `media-src` / `object-src`.
- **Driving the storage budget past a free plan's ceiling without limit** — the object stores here are small and shared, so a creation path that ignores `CREATE_LIMITER`/`UNLOCK_LIMITER` when they are bound, or that writes a body no row will ever delete, is a problem and not a performance note.
- **Anything the pages fetch or store that the operator did not configure** — a new outbound request from a page, a new origin in the policy, telemetry, a cookie beyond the short-lived unlock one.

## Out of scope

- "Anyone with the exact link can read it." The link is the access control, the id is unguessable, and the page says so in plain words. What matters is a link that is _shorter_ or _older_ than it should be, not a link that works.
- "I lost the link and want the paste back", or "it expired". There is no recovery path by design; the server enforces expiry and the ceiling is 30 days.
- "The management link deletes a paste with no password." It is a bearer capability, shown exactly once, and it can do exactly one thing.
- The draft copy in your own `localStorage`, and the fact that it stays until you press Discard. That is the browser's, not this service's.
- Abuse of the service — illegal content, malware, spam, impersonation. No moderation happens here, deliberately: report to Cloudflare (Worker, KV, R2) and to whichever storage provider holds the bucket, and include the paste id and its expiry.
- Anything that needs the reporter's own machine, browser extension or network to be already compromised; a paste the reporter was given legitimately.
- Vulnerabilities in Cloudflare, Workers, workerd, a storage provider or a browser. Report upstream; if a fix has to land in this repository to matter, say so and it will be taken.
- A missing rate limit on an instance where the limit binding is not configured. `CREATE_LIMITER` and `UNLOCK_LIMITER` are optional, the README documents what an instance without them does, and "the free plan got tired" is an operations note.
- Denial-of-service by volume, and anything a client can only do to _its own_ paste.

## How to report

**Security tab → "Report a vulnerability" → open an advisory draft.** It is private: only you and the maintainer see it, and it can become a published advisory with credit if you want credit. There is no published email address for this project. If the advisory route is unavailable to you, open a one-line issue titled `contact request` and nothing else, then delete nothing from it — a private channel will be arranged.

Please include: which instance (the URL, or your own deployment and its version id from `npx wrangler deployments list`), the exact request, what you expected, what happened, and the smallest reproduction that proves it.

**Do not test against `purepaste.byaislop.workers.dev`.** Other people's pastes are in that database, and the free-plan ceilings are shared with them. The whole thing runs locally in two minutes:

```
git clone https://github.com/mahimmazidul/PurePaste && cd PurePaste
npm install && npm run dev        # workerd on :8787, local D1 and KV
```

Add `S3_*` vars from the README if the report involves the object pool, and `SUPABASE_*` if it involves the mirror. Deleting and re-creating your own pastes on a local instance is fair game; anything that touches somebody else's is not.

## What happens next

This is one person, not a security team, so the promises are the ones that will actually be kept:

- an acknowledgement within **3 days**;
- a fix, or a reasoned refusal with the reasoning written down, within **14 days** of the last round of the conversation;
- no public disclosure — not in an issue, not in a commit message, not on social media — until the patch is deployed where it matters. If you would like to disclose after **90 days** regardless, say so at the start and that deadline holds, fixed or not;
- a fix lands on `main`. There are no releases and no backport branches; if you run your own copy, the deploy is the release.

No bounty and no swag, honestly. Credit in the advisory and a line in the release note are the whole reward, and both are yours for asking.
