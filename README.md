# PurePaste

A small, accountless paste and file sharing service that runs entirely on Cloudflare. One Worker, one D1 database for metadata, one R2 bucket for bodies, and an hourly cron that cleans up after itself.

Every paste expires — 30 days is the hard ceiling and the server enforces it, not the page you are looking at. There are no accounts, no listing of what other people have pasted, no analytics, and nothing loaded from a third party. The link is the only way in, and the management link is the only way to remove something early.

- **Pastes and files.** Text up to 10 MiB, files up to 25 MiB, small snippets kept in D1 and everything else streamed to R2.
- **Expiry that is real.** A row without a future `expires_at` cannot exist; the scheduled Worker removes what has lapsed.
- **Optional protection.** A password whose derivation happens in the reader's browser, and end-to-end encryption where the key never leaves the URL fragment.
- **Burn after reading.** A reveal page that a link preview cannot trigger, and a single-use claim that survives two people clicking at the same moment.
- **A usable API.** Create, read, and delete from a terminal: pipe stdin, get a bare URL back, ask for JSON when you want it.
- **No lock-in.** Static assets are bundled and self-hosted, the client script is a few hundred lines of vanilla TypeScript, and the only runtime dependency is Hono.

It is not a social network, a public gallery, an admin dashboard, or an analytics product. There is no way to browse what other people have made, and there will not be.

---

## Contents

- [How it is put together](#how-it-is-put-together)
- [Getting started](#getting-started)
- [Configuration](#configuration)
- [How pastes behave](#how-pastes-behave)
- [Browser encryption, explained honestly](#browser-encryption-explained-honestly)
- [Passwords](#passwords)
- [The API](#the-api)
- [Security model](#security-model)
- [Management links](#management-links)
- [Scheduled cleanup](#scheduled-cleanup)
- [Free plan notes](#free-plan-notes)
- [Backup, deletion and what you cannot undo](#backup-deletion-and-what-you-cannot-undo)
- [Repository layout](#repository-layout)
- [Testing](#testing)
- [Troubleshooting](#troubleshooting)
- [Licence and credits](#licence-and-credits)

---

## How it is put together

```
                    ┌──────────────────────────────────────────┐
   browser ────────►│ Worker (Hono)                            │
                    │  • pages: /, /about, /pastes, /licenses  │
                    │  • pastes: /:id, /raw/:id, /download/:id │
                    │  • api:    /api/pastes…                  │
                    │  • cron:   hourly cleanup                │
                    └───────┬───────────────────────┬──────────┘
                            │                       │
                   ┌────────▼────────┐     ┌────────▼─────────┐
                   │ D1              │     │ R2               │
                   │ one row per     │     │ bodies > 64 KiB, │
                   │ paste: metadata,│     │ files, encrypted │
                   │ small bodies    │     │ payloads         │
                   └─────────────────┘     └──────────────────┘
                            │
                   ┌────────▼─────────┐
                   │ Static assets    │  CSS, self-hosted fonts, client bundle
                   │ (Workers Assets) │  served without invoking the Worker
                   └──────────────────┘
```

**Routing.** Fixed routes are registered before the single-segment paste route, so `/api/...`, `/raw/...`, `/download/...` and `/manage/...` can never be shadowed by a paste whose id happens to look like them.

**Storage split.** `INLINE_TEXT_MAX_BYTES` (64 KiB by default) decides where a body goes. Small unencrypted text sits in a D1 column so a read is one query; anything larger, any file, and every encrypted payload goes to R2 under `pp/v1/<text|file|blob>/<paste id>`. Keys are built from the generated paste id, never from a filename a visitor supplied.

**Reads.** One indexed lookup by primary key, then either the column or an R2 `get`. The response is streamed, so a 25 MiB file never sits in memory in full. Pastes larger than 1 MiB are not inlined into the page: the page ships a placeholder and the browser fetches the raw body instead.

**Writes.** A paste is inserted once and never updated, except for the counter (off by default) and the single-use claim for burn-after-reading. There is no edit path; "editing" is a fork, which the paste page offers as a prefilled copy of the editor.

**Expiry.** `expires_at` is `NOT NULL` in the schema, and the value written is always `min(requested, MAX_TTL_SECONDS)`. Reads check it as well, so a paste stops answering the moment it lapses even if the cron has not run.

**Cleanup.** An hourly scheduled Worker sweeps in bounded batches: expired rows first, then the R2 objects behind pastes consumed by burn-after-reading (after a short grace period so the reader still gets their bytes). Object deletion happens before the row is removed, so a half-finished sweep can be retried safely.

**Client bundle.** Pages are server-rendered HTML and work without JavaScript. A single esbuild pass produces `theme.js` (a few lines, runs before paint) and `app.js` plus lazy chunks for the QR encoder, the Markdown renderer, and each syntax grammar. There are no inline scripts anywhere, which is what lets the Content Security Policy be `script-src 'self'` with no exceptions.

**Dependencies.** `hono` at runtime. Everything else — TypeScript, Wrangler, Vitest, esbuild, highlight.js, qrcode-generator, Prettier, ESLint — is a development dependency.

---

## Getting started

You need Node.js 22 or newer (Wrangler requires it), a Cloudflare account, and a domain in that account if you want a custom hostname. Everything below is free-plan territory.

```bash
git clone https://github.com/mahimmazidul/PurePaste.git
cd PurePaste
npm install
npx wrangler login          # opens a browser and stores an OAuth token locally
```

### 1. Create the database

```bash
npx wrangler d1 create purepaste
```

The command prints a `database_id`. Paste it into `wrangler.jsonc`, replacing the placeholder:

```jsonc
"d1_databases": [
  { "binding": "DB", "database_name": "purepaste", "database_id": "<the id it printed>", "migrations_dir": "migrations" }
]
```

### 2. Create the bucket

```bash
npx wrangler r2 bucket create purepaste-blobs
```

The bucket name already in `wrangler.jsonc` is `purepaste-blobs`; if you used another name, change it there too. Add `--location weur` (or another region hint) if you would like the data parked nearer your readers.

### 3. Apply the schema

```bash
npm run migrate:local     # wrangler d1 migrations apply purepaste --local
npm run migrate:remote    # wrangler d1 migrations apply purepaste --remote
```

`npm run dev` uses the local database; `npm run deploy` needs the remote one. Migrations live in `migrations/` and are tracked in D1's own `d1_migrations` table, so applying them twice is harmless.

New migrations are created with:

```bash
npx wrangler d1 migrations create purepaste add_something
npx wrangler d1 migrations list purepaste --remote    # see what is pending
```

### 4. Set the secret

The management tokens, password verifiers and unlock cookies are all keyed by one secret. Set it before the first deploy:

```bash
npx wrangler secret put APP_SECRET      # paste a long random string, e.g. from: openssl rand -base64 32
```

It cannot be rotated without invalidating every existing management link and password, so keep a copy somewhere you can find it. For local development a fallback secret is used automatically, and `wrangler dev` works with no secrets set at all.

### 5. Develop

```bash
npm run dev
```

That builds the client bundle in watch mode and starts `wrangler dev` on <http://localhost:8787>. The scheduled handler can be fired locally without waiting for the hour to pass:

```bash
curl "http://localhost:8787/cdn-cgi/local/scheduled?format=json&cron=17+*+*+*+*"
```

### 6. Deploy

```bash
npm test            # 147 tests, running inside workerd against real D1 and R2
npm run deploy      # preflight → build the client bundle → wrangler deploy
```

`npm run preflight` is a fast, mostly offline sanity check: it parses `wrangler.jsonc`, refuses the placeholder database id, checks the built assets exist, and warns about anything it cannot verify while logged out. `npm run deploy` runs it for you.

The same workflow, in the order it usually happens:

```bash
npm install
npm run dev
npm test
npm run deploy
```

### 7. A custom domain

`workers_dev` is on, so the Worker answers on `<worker>.<subdomain>.workers.dev` immediately. To attach your own hostname, add a route to `wrangler.jsonc` and deploy again:

```jsonc
"routes": [
  { "pattern": "paste.example.com", "custom_domain": true }
]
```

Cloudflare creates the DNS record and certificate for you. Nothing in the application hard-codes a hostname: every URL it builds comes from the incoming request, so `workers.dev`, a custom domain, and a preview URL all behave identically.

---

## Blob storage: R2 or Workers KV

The upstream design stores blobs in R2. Activating R2 requires a payment method on file even for free-tier usage, so **this deployment binds a Workers KV namespace instead** (`BLOBS` in `wrangler.jsonc`) — free, with no card. The server picks the backend automatically: R2 when a `BUCKET` binding is present, KV otherwise. To switch back, enable R2, create the bucket, restore the `r2_buckets` block in place of `kv_namespaces`, and redeploy; no code changes are needed.

Differences from R2, absorbed in `src/services/object-store.ts`:

- KV is eventually consistent: values reach every edge location within about a minute, so a very fresh large paste can briefly miss from a distant colo. Small text pastes are unaffected — they live in the D1 row.
- Values cap at 25 MiB, which matches `FILE_MAX_BYTES` exactly.
- There is no bulk delete: the cleanup sweep removes keys one at a time, within its existing batch bounds.
- KV has no HEAD or native etag, so the byte size and a per-object etag ride in the value metadata (1 KiB budget; the D1 row keeps the authoritative filename).

Free-tier budget: 1 GB storage, 100k reads/day, and 1k each of writes, deletes and lists per day.

---

## Configuration

Everything is set in the `vars` block of `wrangler.jsonc` and read through `src/config.ts`. Values are clamped to a sane range, so a typo cannot produce a nonsense limit; anything unparseable falls back to the default shown here.

| Variable                    | Default             | Range              | What it does                                                                                 |
| --------------------------- | ------------------- | ------------------ | -------------------------------------------------------------------------------------------- |
| `MAX_TTL_SECONDS`           | `2592000` (30 days) | 60 – 2592000       | Ceiling for every paste. The application never allows more than 30 days, whatever this says. |
| `DEFAULT_TTL_SECONDS`       | `604800` (7 days)   | 60 – max           | What "Expires" defaults to in the editor.                                                    |
| `INLINE_TEXT_MAX_BYTES`     | `65536`             | 1 KiB – 1 MiB      | Above this, text is stored in R2 rather than in the D1 row.                                  |
| `TEXT_MAX_BYTES`            | `10485760` (10 MiB) | ≥ inline – 100 MiB | Largest paste.                                                                               |
| `FILE_MAX_BYTES`            | `26214400` (25 MiB) | 1 KiB – 100 MiB    | Largest upload.                                                                              |
| `PASSWORD_ITERATIONS`       | `210000`            | 100000 – 1000000   | PBKDF2 rounds the _browser_ uses when creating a password.                                   |
| `UNLOCK_COOKIE_TTL_SECONDS` | `1800`              | 60 – 86400         | How long an unlocked paste stays unlocked in that browser.                                   |
| `FEATURE_REDIRECT`          | `on`                | –                  | Short-link mode. `off` removes the form and refuses new links.                               |
| `FEATURE_VIEW_COUNTING`     | `off`               | –                  | Counts reads. Off means reads perform no writes at all.                                      |
| `FEATURE_TURNSTILE`         | `off`               | –                  | Adds Cloudflare Turnstile to the create form.                                                |
| `CLEANUP_BATCH_SIZE`        | `100`               | 1 – 1000           | Rows per sweep step.                                                                         |
| `CLEANUP_MAX_BATCHES`       | `5`                 | 1 – 20             | Steps per hourly run, so a sweep is always bounded.                                          |

**Secrets** (never in `wrangler.jsonc`, never in the repository):

| Secret                 | Required       | What it does                                                                                |
| ---------------------- | -------------- | ------------------------------------------------------------------------------------------- |
| `APP_SECRET`           | for production | Keys management-token hashes, password verifiers and unlock cookies. 16 characters or more. |
| `TURNSTILE_SECRET_KEY` | with Turnstile | Server-side validation of the Turnstile token.                                              |
| `TURNSTILE_SITE_KEY`   | with Turnstile | Passed to the widget as a variable, not a secret.                                           |

```bash
npx wrangler secret put APP_SECRET
npx wrangler secret put TURNSTILE_SECRET_KEY
```

For local work, put them in `.dev.vars` (git-ignored):

```
APP_SECRET=local-only-secret-at-least-16-chars
```

**Optional bindings.** The `ratelimits` block is optional. Remove it and the Worker keeps working — the check is skipped rather than failing. The same is true of the `triggers` block: without it, expiry is still enforced on every read, and the objects behind consumed pastes linger until you run a sweep.

**Turnstile.** Set `FEATURE_TURNSTILE` to `on`, `TURNSTILE_SITE_KEY` as a var, and `TURNSTILE_SECRET_KEY` as a secret. The widget script is then added to the create form, and the framework's allowlist gains `challenges.cloudflare.com` for exactly as long as the feature is enabled. Tokens are validated server-side on every create; a failure is a plain "we couldn't verify that" with a 403, and the form keeps what you typed.

---

## How pastes behave

**Nothing is permanent.** The expiry choices are 1 hour, 1 day, 7 days, 14 days and 30 days. The API also accepts a raw number of seconds, and the server clamps it to the ceiling rather than trusting it. Client-supplied expiration is never taken at face value: a request for a year gets 30 days.

**Expiry is checked three times.** At creation the value is clamped; on every read it is compared against the clock (an expired paste answers `410` with a short page saying so, on every route); and an hourly sweep deletes the rows and their objects. A paste that lapses while somebody is looking at the reveal page stops working the moment they submit.

**Two people, one burn.** Burn-after-reading pastes show a reveal page first. A link preview, a crawler or a plain `GET` sees only the button, so nothing is spent. The button issues a `POST`, and the claim is a single atomic `UPDATE … WHERE consumed_at IS NULL RETURNING …`: exactly one caller can win, however many arrive at once. The others get `410`. An unread burn paste still expires on schedule.

**Encrypted pastes are stored as opaque bytes.** The server records the size, the creation time and the expiry, and nothing else. Titles and filenames travel inside the encrypted payload.

**Link mode is deliberately slow.** A paste in URL mode shows where it goes, with the host named, before anybody is sent there. Only absolute `http` and `https` addresses are accepted; credentials in the URL, control characters, other schemes and anything over 2048 characters are refused. There is no way to make a link auto-redirect.

**Forking instead of editing.** A paste is immutable. "Fork" opens the editor with the original body copied in, and the original stays where it is until it expires or you delete it. Encrypted and password-protected pastes cannot be forked, because there is nothing readable to copy.

---

## Browser encryption, explained honestly

Turn on "Encrypt in my browser" and the payload is encrypted in the browser with AES-GCM before it is sent. The 256-bit key is generated in the browser and never leaves the URL fragment.

What that means in practice:

- **The key is not sent to the server.** Browsers do not transmit the fragment — the part after `#` — so the key does not appear in a request line, a log line, a referrer, or a proxy.
- **The server stores ciphertext it cannot read.** Not the title, not the filename, not the language if you would rather not share it: the envelope carries metadata inside the encrypted section.
- **Losing the fragment loses the paste.** A link that arrives with the `#…` part stripped by a chat app, an email client, or a "copy link" button in some other tool cannot be recovered by anyone, including the person who runs the server. There is no escrow, no recovery code, and no way to ask. This is the trade-off, and it is the whole point.
- **What is still visible:** the size of the payload, when it was created, when it expires, and how often it has been read (when counting is on). Padding is not implemented, so a very small paste is a very small ciphertext.
- **The paste page needs JavaScript** to decrypt, so an encrypted paste does not degrade the way a normal one does. The page says so, and the `<noscript>` note explains why.
- **It is not a promise about your browser.** Malicious extensions, a compromised device, or a page that has been tampered with in transit (which the CSP and HSTS make harder, not impossible) can still read what you type.

The envelope is a small, explicit format — magic `PPv1`, a kind byte, a length-prefixed encrypted metadata block, then the encrypted body, each with its own 12-byte nonce and separated authenticated-data labels. It is documented in `src/client/lib/crypto.ts` and covered by tests, including a round trip in the test suite.

**Password + encryption** can be combined. The password gates access to the ciphertext; the key in the fragment decrypts it. Neither one replaces the other.

---

## Passwords

A password is derived **in the browser** with PBKDF2-HMAC-SHA256: a random 16-byte salt, at least 100,000 iterations, producing a 256-bit verifier. Only the salt, the iteration count and the verifier are posted. The password itself never leaves the device.

The server then stores `HMAC(APP_SECRET, "pw:v1:<paste id>:<salt>:<verifier>")` — a peppered hash, so a database leak on its own does not let an attacker test guesses offline without also holding the secret. On unlock, the presented verifier is hashed the same way and compared in constant time.

Why the derivation is in the browser rather than the Worker: a PBKDF2 derivation at OWASP-recommended strength costs roughly 48 ms of CPU at 210,000 iterations in workerd (measured, and about 100 ms at 600,000), while the Workers **free plan allows 10 ms of CPU per request**. Server-side derivation would exceed the budget on every unlock, and lowering the iteration count to fit would make the stored verifier cheap to attack. Deriving in the browser moves that cost to the device that has the password anyway and keeps the server's work to one HMAC. On the paid plan you could move it; the code is written so the parameters travel with the paste, which is also what makes a future increase backwards-compatible.

After a correct password, the browser gets a cookie named `pp_<paste id>`: `HttpOnly`, `SameSite=Lax`, `Path=/`, `Secure` over HTTPS, and good for `UNLOCK_COOKIE_TTL_SECONDS` (30 minutes by default). Unlock attempts are rate limited per address and per paste.

For terminals, the same thing can be done by hand — derive the verifier yourself and send it as a header:

```bash
curl -s -o /dev/null -w "%{http_code}\n" \
  -H "X-Paste-Password: <base64url verifier>" \
  "https://paste.example.com/raw/<id>"
```

The password is never accepted as a query parameter, so it cannot end up in a log.

---

## The API

The format is decided by the request, never by the User-Agent. An explicit `?format=` wins, then the `Accept` header, then a sensible default for the path: `/api/…` is JSON, pages are HTML.

### Create

```bash
# A bare URL back, nothing else — the friendliest thing for a shell script
echo "hello from a pipe" | curl -s -X POST --data-binary @- \
  -H "Content-Type: text/plain" -H "Accept: text/plain" \
  https://paste.example.com/api/pastes

# JSON response, everything spelled out
curl -s -X POST https://paste.example.com/api/pastes \
  -H "Content-Type: application/json" \
  -d '{"content":"SELECT 1;","title":"Check","language":"sql","expire":"1d","slug":"check"}'

# A file
curl -s -X POST https://paste.example.com/api/pastes \
  -H "Accept: application/json" \
  -F "file=@./screenshot.png"

# A short link (only if FEATURE_REDIRECT is on)
curl -s -X POST https://paste.example.com/api/pastes \
  -H "Content-Type: application/json" \
  -d '{"kind":"redirect","url":"https://example.com/a-long-page","expire":"7d"}'

# Burn after reading
curl -s -X POST https://paste.example.com/api/pastes \
  -H "Content-Type: application/json" -H "Accept: text/plain" \
  -d '{"content":"one time only","burn":true,"expire":"1h"}'
```

An encrypted payload is sent as opaque bytes. The envelope is built in the browser, so this is the same shape the editor posts — either as raw bytes with `?encrypted=1`, or as the `payload` part of a form:

```bash
curl -s -X POST "https://paste.example.com/api/pastes?encrypted=1&expire=1d" \
  -H "Content-Type: application/octet-stream" -H "Accept: text/plain" \
  --data-binary @envelope.bin

curl -s -X POST https://paste.example.com/api/pastes -H "Accept: application/json" \
  -F "encrypted=1" -F "expire=1d" -F "payload=@envelope.bin"
```

Password material (`password_salt`, `password_verifier`, `password_iterations`) is accepted in a JSON body, a form, or the query string — the password itself never is, because the verifier is already derived before the request leaves the browser.

`POST /api/pastes` answers `201` with either a bare URL, a single `{url}`, or the full object:

```json
{
  "id": "k3m9x2qp7a",
  "url": "https://paste.example.com/k3m9x2qp7a",
  "raw_url": "https://paste.example.com/raw/k3m9x2qp7a",
  "download_url": null,
  "manage_url": "https://paste.example.com/manage/k3m9x2qp7a#token=…",
  "manage_token": "…",
  "kind": "text",
  "encrypted": false,
  "burn_after_reading": false,
  "expires_at": 1790000000000,
  "expires_in_seconds": 86400,
  "size_bytes": 42
}
```

`manage_token` is shown exactly once. If it is lost, the paste can only be left to expire.

### Read

```bash
curl -s https://paste.example.com/api/pastes/<id>            # metadata as JSON
curl -s https://paste.example.com/raw/<id>                   # the body, as text
curl -s https://paste.example.com/raw/<id>?format=json       # {"id":…,"kind":"text","content":…}
curl -s -o out.bin -D - https://paste.example.com/download/<id>
curl -s https://paste.example.com/api/config                 # limits, features, TTL choices
```

`/api/pastes/<id>` reports `locked: true` plus the KDF parameters for a password-protected paste, and never the title, filename or content until it has been unlocked. There is deliberately no endpoint that lists pastes.

### Delete

```bash
curl -s -X DELETE https://paste.example.com/api/pastes/<id> \
  -H "Authorization: Bearer <manage_token>"

curl -s -X DELETE https://paste.example.com/api/pastes/<id> \
  -H "X-Manage-Token: <manage_token>"     # the same thing, spelled differently
```

The token is only ever accepted in a header. A token in the query string is refused with `401` — query strings end up in logs, referrers and shell history. Deleting twice is safe: the second call answers `404`, which is the outcome the caller wanted.

### Errors

Every failure is a small JSON object and a status code that means something:

```json
{ "error": "expired", "message": "This paste has expired." }
```

| Status | When                                                          |
| ------ | ------------------------------------------------------------- |
| `400`  | Malformed request, invalid slug, invalid expiration, bad URL. |
| `401`  | Wrong or missing management token or password verifier.       |
| `403`  | Turnstile validation failed.                                  |
| `404`  | No such paste, or a feature that is turned off.               |
| `405`  | A real address, wrong method — with an `Allow` header.        |
| `410`  | Expired, or a one-time paste that has already been opened.    |
| `413`  | Over the size limit.                                          |
| `415`  | A content type this service does not read.                    |
| `429`  | Rate limited, with `Retry-After`.                             |
| `500`  | Something broke. No stack traces, ever.                       |

---

## Security model

**The link is the secret.** There are no accounts, so anybody holding a URL can read the paste. Ids are 10 characters from a 32-character alphabet with visually ambiguous letters removed, and custom slugs cannot shadow application routes or look like an id.

**Management tokens** are 32 random bytes, base64url-encoded, returned once at creation and stored only as a peppered HMAC. They travel in the URL _fragment_ of the management page, so they are never sent to the server; the page's delete button puts the token in an `Authorization` header on a non-GET request.

**The database holds no addresses.** No IP address, no user agent, no fingerprint, no session table. Rate limiting uses Cloudflare's edge counters, keyed by address in memory at the edge and never written to D1. Logs redact query strings, and the application never logs passwords, tokens, keys or paste contents.

**Escaping and rendering.** Everything rendered into HTML is escaped; Markdown is rendered in the reader's browser by a small purpose-built renderer that escapes as it emits, refuses anything but `http`, `https` and `mailto` links, and re-checks its own output against a tag allowlist. Raw and download responses are always sent as attachments under a `default-src 'none'; sandbox` policy, so a paste can never execute in the context of this site — SVG included.

**Headers.** A deny-by-default Content Security Policy with no inline scripts or styles to exempt, `nosniff`, `Referrer-Policy: no-referrer`, `frame-ancestors 'none'` plus `X-Frame-Options`, a permissions policy that turns off everything the site does not use, HSTS, `Cross-Origin-Opener/Resource-Policy`, and `Cache-Control: no-store` on everything the Worker serves.

**Limits.** Body size is checked before the body is read, sizes are enforced again in the storage layer, slugs are validated, path parameters are checked against a strict pattern before they touch a query, and every D1 statement is prepared with bound parameters. Nothing the Worker produces is cacheable: `Cache-Control: no-store` goes on every response, so a protected or one-time paste cannot be replayed out of a cache.

**What this does not protect against.** Anyone who has the link; anyone who can read your screen or your clipboard; a compromised device; the fact that a paste's existence is visible to Cloudflare as it passes through. Encryption with the key in the fragment is the answer to the last two, and it is opt-in by design.

---

## Management links

When a paste is created, the result page shows two links: the public one and the management one. The management link contains the token after a `#`, so it is the only copy that exists — only a hash of the token is stored, and it cannot be sent again.

From the management page you can see the paste's status, expiry and size, copy the public link again, open it, fork it, or delete it. Deleting asks for confirmation ("Delete this paste? This cannot be undone."), sends the token in an `Authorization` header, and removes both the row and the object.

**If the management link is lost, nobody can help.** Not the operator, not Cloudflare, not a support request: there is no plaintext token anywhere to check. The paste simply expires on its own schedule.

"My pastes" keeps a local list in your browser — id, title, type, creation time, expiry, the public URL, and the management link — so the links survive a closed tab. It stores no paste contents, it is never sent anywhere, and clearing site data erases it. That list is the only place your management links live.

---

## Scheduled cleanup

The cron trigger in `wrangler.jsonc` runs `17 * * * *` — hourly at seventeen past the hour, in UTC. A sweep:

1. selects up to `CLEANUP_BATCH_SIZE` rows whose `expires_at` has passed, deletes their R2 objects first, then the rows;
2. does the same for rows consumed by burn-after-reading, after a five-minute grace period so the reader still receives their bytes;
3. repeats up to `CLEANUP_MAX_BATCHES` times, then stops — the run is always bounded, so a large backlog is cleared over several hours rather than in one unbounded loop.

Every step is idempotent and partial-failure safe: objects are removed before rows, a failed R2 delete leaves the row in place for the next run, and running the sweep twice in a row changes nothing. Expired pastes are unreachable whether or not the sweep has caught up, because reads check expiry themselves.

To test it locally, or to force a sweep in production, see [Getting started](#5-develop) for the local trigger. In production, `npx wrangler tail` shows each run's summary line.

---

## Free plan notes

PurePaste is designed to sit comfortably inside Cloudflare's free tier.

- **Workers Free:** 100,000 requests per day and **10 ms of CPU per request**. The application does no expensive work in a request — no server-side key derivation, no full-body buffering beyond the limits above, no background writes on reads while view counting is off.
- **D1 Free:** 5 million rows read and 100,000 rows written per day, 5 GB stored. A paste is one insert and one or two indexed reads. **Turning view counting on converts every read into a write**, which is why it is off by default and why `/api/config` reports the setting.
- **R2 Free:** 10 GB-month storage, 1 million Class A operations, 10 million Class B operations per month. Deletes are free operations, so cleanup costs nothing.
- **Rate limiting** uses the rate limiting binding (Wrangler 4.36+, available on both plans). Counters are per Cloudflare location rather than global, so the honest description is "close enough", not a guarantee.
- **Static assets** (CSS, fonts, the client bundle) are served without invoking the Worker at all, which keeps the request count for ordinary page views lower.

Sizes: a text paste of 10 MiB and a file of 25 MiB are the shipped ceilings. Cloudflare's own request body limit is far higher (100 MB), so the application's limits are what bind, and they are enforced server-side.

---

## Backup, deletion and what you cannot undo

- **Deletion is immediate and irreversible.** The row and the R2 object are removed on the spot. There is no recycle bin, no soft delete, and no version history.
- **There is no export.** Nothing is backed up by the application, and there is no admin interface to read other people's pastes. `wrangler d1 export` is the only way to take a copy of the database, and it will not include bodies stored in R2.
- **Expiry is not a suggestion.** When a paste lapses it stops answering, and the sweep removes it. If you need something to last longer than 30 days, keep a copy.
- **Nothing is billed for storage of deleted objects.** R2's DeleteObject is a free operation, and the storage is released as soon as the object is gone.
- **The APP_SECRET cannot be rotated** without invalidating every management token and password verifier at once. If you must rotate it, accept that existing management links stop working; pastes keep expiring normally.

---

## Repository layout

```
src/
  index.ts            fetch + scheduled handlers
  app.ts              route table, error rendering, method handling
  config.ts           environment variables → one validated Config
  env.ts, types.ts    bindings and shared types
  lib/                ids, crypto, validation, errors, formatting, negotiation, languages
  middleware/         security headers, rate limiting, body limits
  routes/             create, paste, manage
  services/           object-store, metadata-store, paste-store, cleanup, views, turnstile
  views/              layout and one module per page (server-rendered HTML)
  client/             browser bundle: crypto, markdown, qr, highlighting, history, pages
migrations/           D1 schema, applied by wrangler
public/               static assets: stylesheet, icon, self-hosted fonts, licences
scripts/              dev, build-client, preflight
test/                 twelve suites, run inside workerd
```

---

## Testing

```bash
npm test              # everything, once
npm run test:watch    # watch mode
npm run typecheck     # wrangler types + tsc for the Worker, the client, and the tests
npm run lint          # ESLint
npm run format        # Prettier
```

The tests run **inside workerd** through `@cloudflare/vitest-plugin`, against real D1 and R2 bindings with the migrations applied — not against mocks of the platform. Each test file gets its own storage, so suites cannot interfere with each other.

What is covered: creation and validation (slugs, reserved names, collision retry), the 30-day ceiling and every expiry path, D1-versus-R2 storage decisions at the boundary, file uploads and size rejection, password access, token deletion, expired pastes on every route, the two kinds of cleanup including partial failures, burn-after-reading concurrency (five simultaneous reveals, exactly one winner), raw-response safety, Markdown sanitisation against real attack strings, encrypted payload round trips and metadata privacy, URL validation for link mode, the whole API surface through content negotiation, security headers and markup, and rate limiting against the real binding.

---

## Troubleshooting

**`wrangler` complains about the Node version.** Wrangler 4 needs Node 22 or newer. `node --version` should say so.

**`no such table: pastes`.** The migrations have not been applied to the database you are talking to. `npm run migrate:local` for `wrangler dev`, `npm run migrate:remote` for the deployed Worker.

**Preflight refuses to continue.** It prints exactly one line per problem, and the common one is the placeholder `database_id` in `wrangler.jsonc`. Run `npx wrangler d1 create purepaste` and paste in the id.

**Management links stopped working.** `APP_SECRET` changed, or the deployment was given a new one. Existing tokens were hashed with the old secret and cannot be recovered; the pastes themselves are unaffected.

**A page renders unstyled.** The client bundle has not been built: run `npm run build`. It is rebuilt automatically by `npm run dev` and by `npm run deploy`.

**Everything expires too quickly.** Check `DEFAULT_TTL_SECONDS` rather than `MAX_TTL_SECONDS`: the ceiling applies to what is allowed, the default to what the editor preselects.

---

## Licence and credits

PurePaste is MIT licensed. The fonts, and the two libraries the browser bundle uses, are credited on the `/licenses` page in the running application and their licence texts ship in `public/assets/licenses/`: Manrope and IBM Plex Mono (SIL Open Font Licence 1.1), highlight.js (BSD 3-Clause), and qrcode-generator (MIT).

Built with [Hono](https://hono.dev) and [Cloudflare Workers](https://developers.cloudflare.com/workers/), D1, R2 and Workers Static Assets.
