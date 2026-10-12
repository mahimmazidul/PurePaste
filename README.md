# Slip

_(repository and Worker still named PurePaste — the product the pages speak is Slip.)_

**Source:** <https://github.com/mahimmazidul/PurePaste> — MIT, and the whole of it: Worker, client, schema and the cleanup cron. The site links to this repository from the mark in its header, so the running instance and the code you can read are the same thing.

A small, accountless service for text, files and short honest links, running entirely on Cloudflare. One Worker, one D1 database for metadata, an object store for bodies (this deployment uses Backblaze B2 and a KV namespace as one pool), and an hourly cron that cleans up after itself.

Every slip expires — 30 days is the hard ceiling and the server enforces it, not the page you are looking at.
The front page is one composer with three tabs — **a slip** of text, **a link** that shows its destination before anyone hops, **a file** up to 25 MiB — with a quiet stat bar of live totals underneath and a browser-local drawer of everything this device sealed. There are no accounts, no listing of what other people have pasted, no analytics, and nothing loaded from a third party. The link is the only way in, and the management link is the only way to remove something early.

- **Pastes and files.** Text up to 10 MiB, files up to 25 MiB, small snippets kept in D1 and everything else streamed to the object store. Uploads default to a three-day life — in the UI _and_ on the API, so a bare `curl -F file=@…` gets it too — because the object store is the tightest budget on a free account; text still defaults to a week.
- **Expiry that is real.** A row without a future `expires_at` cannot exist; the scheduled Worker removes what has lapsed.
- **Nothing lost to a refresh.** The composer mirrors what you are typing into `localStorage` (`slip-draft-v1`) and puts it back on the next load, including the tab you were on. Files cannot be kept, so only their names and options come back; the password field is never stored; text over 200 KiB is not mirrored (that is a job for the file tab). Sealing a sheet clears the draft, and the banner next to a restored one offers to discard it.
- **A preview before you seal.** The file tab can draw the chosen file locally — text as clipped plain text, images from a `data:` URL, everything else an honest "no preview here". No blob URLs and no `<object>`: the CSP is `img-src 'self' data:` and `object-src 'none'`, and the preview works inside it rather than by loosening it.
- **Optional protection.** A password whose derivation happens in the reader's browser, and end-to-end encryption where the key never leaves the URL fragment.
- **Burn after reading.** A reveal page that a link preview cannot trigger, and a single-use claim that survives two people clicking at the same moment.
- **A usable API.** Create, read, and delete from a terminal: pipe stdin, get a bare URL back, ask for JSON when you want it. `/api/links` seals hops, `/api/stats` feeds the stat bar, `/api/health` says hello.
- **No lock-in.** Static assets are bundled and self-hosted, the client script is a few hundred lines of vanilla TypeScript, and the only runtime dependency is Hono.

It is not a social network, a public gallery, an admin dashboard, or an analytics product. There is no way to browse what other people have made, and there will not be.

---

## Contents

- [How it is put together](#how-it-is-put-together)
- [Getting started](#getting-started)
- [Blob storage: which bucket, and why](#blob-storage-which-bucket-and-why)
- [Supabase: a runtime mirror, not a backup](#supabase-a-runtime-mirror-not-a-backup)
- [Getting more bandwidth out of a free tier](#getting-more-bandwidth-out-of-a-free-tier)
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

**Cannot activate R2 without a card?** There are two other answers, and this deployment uses the second one — with the namespace kept as a read cache in front of the bucket, so the two free tiers work as one layer instead of one waiting to be retired.

- `npx wrangler kv namespace create BLOBS` plus the binding already in `wrangler.jsonc` is enough — the Worker will use KV, at 25 MiB per file and inside its operation counts.
- An S3 bucket needs no wrangler binding at all: three vars and two secrets.

```bash
# vars in wrangler.jsonc
"S3_ENDPOINT": "https://s3.us-east-005.backblazeb2.com",
"S3_BUCKET": "purepaste",
"S3_REGION": "us-east-005",
# secrets
npx wrangler secret put S3_ACCESS_KEY_ID
npx wrangler secret put S3_SECRET_ACCESS_KEY
```

A complete `S3_*` set wins over KV automatically, so nothing else changes. Bind both and the pool uses both: existing objects stay readable in the namespace, new bodies go to the bucket, and reads that keep getting served from KV end up with a copy there. That is what let this instance move to B2 without invalidating a single existing link. See [Blob storage](#blob-storage-which-bucket-and-why).

### 3. Apply the schema

```bash
npm run migrate:local     # wrangler d1 migrations apply purepaste --local
npm run migrate:remote    # wrangler d1 migrations apply purepaste --remote
```

`npm run dev` uses the local database; `npm run deploy` needs the remote one. Migrations live in `migrations/` and are tracked in D1's own `d1_migrations` table, so applying them twice is harmless. There is an optional third database here — a Supabase mirror — whose schema is applied by hand in that dashboard; see [Supabase](#supabase-a-runtime-mirror-not-a-backup). D1 remains the database of record either way.

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
npm test            # 216 tests, running inside workerd against real D1 and a KV namespace
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

## Blob storage: which bucket, and why

Text, options, counters and expiry always live in D1 — that is the database of record whatever holds the files. Only the large bodies are pluggable, and one object decides where they go: `BlobPool` in `src/services/storage-provider.ts`.

The pool is not a primary with a spare. Every configured store is a member, one of them takes each body, the D1 row records which (`pastes.blob_store`), reads start there and fall through to the others, and **a delete goes to every store in the pool** — which is why the hourly sweep needs nobody to remember anything. Two shapes:

- `BLOB_KV=share` — bodies up to `BLOB_KV_SHARE_MAX_BYTES` (256 KiB) are written to the namespace, everything bigger to the bucket. Both stores hold part of the data and neither is a copy of the other.
- `BLOB_KV=cache` (what an instance with a bucket and a namespace gets by default) — the bucket is the origin, so an upload is readable the instant its row exists, and the bodies people actually open are copied into the namespace behind the response with a TTL on the copy. The next read is answered at an edge near the visitor, and the row is stamped `kv` so it keeps being. A cache that is empty, evicted or half-written costs one bucket read; it can never cost a file.

Three more settings decide the rest, and none of them is a judgement call the code makes silently:

| Value                         | Effect                                                                                                                                                                                                       |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `STORAGE_PROVIDER=kv\|r2\|s3` | Pins one store. A pin that is not configured is an error rather than a quiet downgrade, so a typo surfaces as one clear message on the next upload instead of bytes landing somewhere the sweep never looks. |
| `BLOB_POOL=off`               | One writer — the first complete store — and every other binding kept read-only. This is the shape to use during a migration you want to watch.                                                               |
| `STORAGE_FALLBACK=off`        | No other store is involved at all: no read-through, no cache, no share.                                                                                                                                      |

`GET /api/config` answers `storage: { provider, providers, mode, reason, direct_links, stores, share }`, where `stores` lists each member with its writes, failures, whether it is parked and whether it takes writes or only reads, and `share` reports the KV role, the byte caps and how much of today's write budget is left. It is the quickest way to confirm what a deploy is doing without reading a secret.

What holds regardless of the choice: keys are `pp/v1/<kind>/<id>` in every store, so one row can point at a body without naming a bucket in its key; the D1 row stays authoritative for filename and content type; reads, burns and the hourly sweep all go through the same `BlobStore` contract, which the tests exercise against stand-in stores so a new backend cannot drift out of the purge.

### Workers KV — the second store, and what this fork ran on first

Activating R2 requires a payment method on file even for free-tier usage, so this deployment started on a KV namespace (`BLOBS`) and still binds one: it is the read-through store for every paste made before the bucket existed. Differences from R2, absorbed in `src/services/object-store.ts`:

- KV is eventually consistent: values reach every edge in about a minute, so a very fresh large paste can briefly miss from a distant colo. Small text pastes are unaffected — they are in the D1 row.
- Values cap at 25 MiB, so `FILE_MAX_BYTES` above that is a bucket-only setting; a KV store refuses the upload with a 413 rather than failing inside KV after the row exists. The shipped default is 25 MiB, which is exactly the ceiling.
- There is no bulk delete, so the sweep removes keys one at a time inside its existing batch bounds.
- No HEAD and no native etag, so size and a generated etag ride in the value metadata (1 KiB budget).
- Values carry their own metadata, which is where `createdAt` comes from: it is what lets the daily orphan pass tell "left behind by a failed request" from "written nine seconds ago", and it is the reason KV is swept too rather than exempt.

Free tier: 1 GB stored, 100k reads a day, 1k each of writes, deletes and lists. The operation counts, not the gigabytes, are what a busy instance runs out of.

### R2 — the upstream default

Bind the bucket as `BUCKET` and nothing else changes. R2 charges no egress at all, so if your account can activate it, it is the best answer for bandwidth and this code needs no configuration for it.

### Backblaze B2 — what this fork runs now

`src/services/s3-store.ts` is a small S3 client: SigV4 signing over WebCrypto, a streaming `PUT` with `UNSIGNED-PAYLOAD` so an upload is copied rather than buffered, and presigned `GET`s when you want the browser to fetch bytes from the bucket. It is deliberately hand-rolled: an SDK would cost more than the whole Worker.

```bash
# vars
S3_ENDPOINT=https://s3.us-east-005.backblazeb2.com
S3_BUCKET=my-slips
S3_REGION=us-east-005
S3_PREFIX=pp/v1
# secrets: the keyID and the applicationKey from the B2 application key screen
npx wrangler secret put S3_ACCESS_KEY_ID
npx wrangler secret put S3_SECRET_ACCESS_KEY
```

That is the whole setup. B2's free tier is why it is the documented example: 10 GB stored permanently, egress free up to three times your average stored data, the transaction tiers free on pay-as-you-go, and **no egress charge at all when the bucket is proxied through Cloudflare**. Supabase Storage also works as an S3 target, with `S3_ENDPOINT=https://<ref>.storage.supabase.co/storage/v1/s3` and `S3_VIRTUAL_HOST_STYLE=on` (its S3 API rejects path-style addressing); MinIO or any other endpoint needs the same four values.

**Versioning is the trap.** A B2 bucket defaults to _Keep all versions_, and on such a bucket a `DELETE` only hides the current version — the storage never shrinks, so "expired and deleted" still bills and still sits there. `S3_PURGE_VERSIONS` (default `on`) is what makes deletion mean deletion: after the plain `DELETE` the sweep lists `?versions` for that key and issues one delete per `versionId`, delete markers included. It costs a `List Versions` and a `Delete` per version on top of the delete you were paying for anyway, which on B2's free transaction tier is nothing until you exceed 2,500 Class B and C calls a day. Set it to `off` if you would rather let a bucket lifecycle rule do the work (hide after N days, delete hidden after M) — the app will then be honest that a bucket refusing `list-versions` is reported as `failed:<n>`, never as deleted.

`S3_PUBLIC_BASE` plus `STORAGE_DIRECT_LINKS=on` hands image, video and audio links straight to the bucket; without a public base the Worker answers with a presigned GET. Either way the bytes stop crossing an isolate.

## Supabase: a runtime mirror, not a backup

`src/services/supabase-store.ts` keeps a second copy of the paste table in a Supabase project. It is worth being precise about what that is for, because "mirror" and "backup" get used as if they meant the same thing.

It is a **runtime** copy: D1 stays the database of record, every read and write is served from D1, and the mirror is written _after_ the response is committed (`ctx.waitUntil`, so the browser is never waiting on Postgres). Two things come out of that. Reads can fall through to the mirror when D1 errors — counted as `fallback_reads`, and the reason the mirror holds the inline `content` column and not just metadata. And if Postgres is down, slow, or simply not there, the paste flow does not notice: every failure path ends in a `console.warn` and a counter, never in a 500.

It is **not** a backup you should plan a restore around. Writes are fire-and-forget within one isolate, there is no reconciliation pass that replays what the mirror missed, and the same sweep that expires rows in D1 expires them there. If you want copies of other people's pastes to survive, that is an export job, and this README will not pretend otherwise.

### Setup

1. Create a project (the free plan is enough; see the pause note below).
2. In the dashboard: **SQL Editor → New**, paste [`supabase/schema.sql`](supabase/schema.sql), run it. The file is idempotent, so re-running it after a change is safe. It creates the `pastes` table, the three indexes the sweep and the fallback read need, `apply_views(deltas)` for batched counting, `live_pastes` for a queryable count of what is up, and `supabase_keepalive()`.
3. Point the Worker at it:

```bash
# var
npx wrangler config var set SUPABASE_URL https://<ref>.supabase.co   # or edit wrangler.jsonc
# secrets
npx wrangler secret put SUPABASE_ANON_KEY      # the publishable key: keepalive only
npx wrangler secret put SUPABASE_SECRET_KEY    # the service_role key: enables the mirror
```

The shipped grants are the reason for that split. The schema revokes `anon` and `authenticated` from everything in `public` and gives read/write on the table to `service_role` alone — a publishable key ships to every browser on the planet, and a pastebin whose whole model is "the link is the only way in" cannot have a table that key can select from. The one exception on the page is `supabase_keepalive()`, which is a `select 1` with nothing to learn from it, because the cron has to be able to reach the project with only the key every deployment is guaranteed to have.

So the feature has three states, and `/api/config` names the one you are in:

| Vars set                             | `supabase` in `/api/config` | What runs                                                               |
| ------------------------------------ | --------------------------- | ----------------------------------------------------------------------- |
| nothing                              | `{ enabled: false }`        | Nothing. No store is constructed, no requests are made.                 |
| `SUPABASE_URL` + `SUPABASE_ANON_KEY` | `mirror: "keepalive-only"`  | The hourly keep-alive call. No writes, no mirror.                       |
| `...+ SUPABASE_SECRET_KEY`           | `mirror: "on"`              | Write-through on create, burn, views and delete, plus the mirror sweep. |

`SUPABASE_MIRROR=on` with only the anon key is a boot error rather than a silent downgrade: you asked for something the key cannot do. `SUPABASE_MIRROR=off` disables mirroring while keeping the keep-alive, and `SUPABASE_KEEPALIVE=off` switches that off too. `SUPABASE_TABLE` renames the table if `pastes` collides with something.

### The pause timer, and why the cron reaches Postgres at all

A free Supabase project with no traffic for seven days is paused, and a paused project answers the next visitor with a cold start or a refusal — which would make the mirror worse than useless exactly when it is supposed to help. So the hourly cron calls `supabase_keepalive()` whether or not mirroring is on. What the pause timer counts is requests that reach the project, so a PostgREST refusal ("function does not exist", i.e. the schema has not been applied) still keeps it awake; `awake` in the cron's log line means the project answered, and the detail field says whether the function actually ran. One indexed `select 1` an hour is 24 queries a day, against a free allowance of half a million edge invocations.

### Retention

Nothing here is storage forever, and the mirror is held to the same rule as D1: the cron calls `purgeExpired(now, CLEANUP_BATCH_SIZE, grace)`, which deletes rows whose `expires_at` has passed and rows already consumed by burn-after-reading once the same five-minute grace has elapsed. Same bounds as the D1 sweep, so a mirror that has drifted far behind is cleared over several runs rather than in one unbounded loop. `/api/config` reports `writes`, `write_failures`, `fallback_reads` and `last_error`, which is how you notice a mirror that stopped being written to.

The honest consequence: enabling the mirror copies text-paste bodies into a second database. Anyone with the `service_role` key can read them. Keep that key in Worker secrets and nowhere else, and treat `SUPABASE_MIRROR=off` as the right answer if you do not want that exposure.

---

---

## Getting more bandwidth out of a free tier

The free tiers are tight in different places, so the levers differ. What follows is what this codebase does, plus what is left to you.

**Applies to every store**

- **Every preview has an address of its own.** The viewer page for an image, clip or recording links the preview to `GET /p/:id/media` and repeats that absolute URL in a copy field, so a picture can be pasted somewhere that has no idea this site exists. It is the file alone, with `Content-Disposition: inline` and a policy that lets a browser draw it, so opening it in a tab shows the image rather than a page about the image. It is public-by-link exactly like the share page is: a lock still answers `401` until the passphrase is supplied, a burn-after-read paste answers `403` and spends nothing, and an encrypted or markup body is never drawn inline. Nothing about opening it counts as a view.
- **Never re-read what you already have.** `GET /p/:id/media` answers with an `ETag` and honours `If-None-Match` with a `304`, so a refresh of a viewer page costs a header, not the file.
- **Small text never touches the object store at all.** Under `INLINE_TEXT_MAX_BYTES` (64 KiB) the body lives in the D1 row, which is the cheapest read on the platform.
- **Edge-cache the public ones, if you want.** `MEDIA_CACHE_SECONDS` sets `Cache-Control: public, max-age, immutable` on media for pastes that are unencrypted, unlocked and not burn-after-reading — 0 (the default) means every response is `no-store`. Cloudflare does not honour a long `max-age` on a Worker response by itself: add a Cache Rule for the path `/p/*/media` (or set Edge Cache TTL) or the header is advisory only.
- **Let the namespace answer the repeats.** In `cache` mode a body that is being read is copied into KV behind the response, and a KV read is one operation against a namespace sitting in the same edge location as the visitor, rather than a GET to a bucket in one region. Reads of a hot file stop costing bucket requests entirely, and the copy expires by itself (`BLOB_KV_CACHE_TTL_SECONDS`) if it stops being read. The 600-write budget is per isolate, so it is a soft cap rather than an accounting: the hard ceiling is KV's own, and the consequence of bumping into it is a cache fill that fails, gets counted, and parks the namespace for ten minutes — never a lost upload, because in `cache` mode the bucket already has the only copy that matters. A copy written just before a burn-after-reading paste deletes itself can also outlive its row by a day; the orphan pass picks it up.
- **Skip the Worker for the bytes, when it is safe.** `STORAGE_DIRECT_LINKS=on` with `S3_PUBLIC_BASE` makes `GET /p/:id/media` answer `302` to the bucket for images, video and audio — the file then crosses the CDN and never enters an isolate, which is the single biggest saving for request quota and CPU. It is refused for anything that could be opened as a top-level page, so a PDF or an HTML upload is never redirected; the CSP only ever names the exact origin you configured. Without a public base, an S3 store hands out a presigned GET instead: same bandwidth saving, still one signed request per file.
- **Keep the payload small at the source.** `FILE_MAX_BYTES` (25 MiB shipped, because that is what a KV value can hold) is a storage limit, not a courtesy; the honest way to raise throughput on a free plan is to lower it, and the honest way to raise the ceiling is to move the bytes to a bucket.

**KV specifically** — KV is limited by _operations_, not bytes: 100k reads a day is the wall, and 1k writes. So the wins are: don't read twice (the 304 path), don't store what fits in a row (the inline path), and let the burn path delete once rather than repeatedly — the sweep's per-key deletes count against the 1k delete budget, which is why `CLEANUP_BATCH_SIZE` and `CLEANUP_MAX_BATCHES` exist.

**B2 (and any S3 bucket) specifically** — a bucket is limited by _egress_, not requests: keep it behind Cloudflare (Bandwidth Alliance) and egress stops being a number; without that, stay inside three times your average stored data. Reads are one GET per preview, so the caching items above are what bound a busy link. Deletion is the other thing to watch: on a versioned bucket the app pays a `List Versions` and a delete per version to make sure the bytes actually go (`S3_PURGE_VERSIONS`), which is what keeps a free 10 GB bucket from filling up with the ghosts of expired files.

**Not done, deliberately**: Range requests. `/p/:id/media` sends the whole body, so a `<video>` element cannot seek and a long clip downloads from the start every time. Range handling belongs on the bucket or the CDN in front of it — for anything you expect people to scrub through, put the file in B2 and let Cloudflare serve it.

---

## Configuration

Everything is set in the `vars` block of `wrangler.jsonc` and read through `src/config.ts`. Values are clamped to a sane range, so a typo cannot produce a nonsense limit; anything unparseable falls back to the default shown here.

| Variable                    | Default             | Range                     | What it does                                                                                                                                           |
| --------------------------- | ------------------- | ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `MAX_TTL_SECONDS`           | `2592000` (30 days) | 60 – 2592000              | Ceiling for every paste. The application never allows more than 30 days, whatever this says.                                                           |
| `DEFAULT_TTL_SECONDS`       | `604800` (7 days)   | 60 – max                  | What "Expires" defaults to in the editor.                                                                                                              |
| `INLINE_TEXT_MAX_BYTES`     | `65536`             | 1 KiB – 1 MiB             | Above this, text goes to the object store rather than staying in the D1 row.                                                                           |
| `TEXT_MAX_BYTES`            | `10485760` (10 MiB) | ≥ inline – 100 MiB        | Largest paste.                                                                                                                                         |
| `FILE_MAX_BYTES`            | `26214400` (25 MiB) | 1 KiB – 100 MiB           | Largest upload.                                                                                                                                        |
| `PASSWORD_ITERATIONS`       | `210000`            | 100000 – 1000000          | PBKDF2 rounds the _browser_ uses when creating a password.                                                                                             |
| `UNLOCK_COOKIE_TTL_SECONDS` | `1800`              | 60 – 86400                | How long an unlocked paste stays unlocked in that browser.                                                                                             |
| `FEATURE_REDIRECT`          | `on`                | –                         | Short-link mode. `off` removes the form and refuses new links.                                                                                         |
| `FEATURE_VIEW_COUNTING`     | `off`               | –                         | Counts reads. Off means reads perform no writes at all.                                                                                                |
| `FEATURE_TURNSTILE`         | `off`               | –                         | Adds Cloudflare Turnstile to the create form.                                                                                                          |
| `MEDIA_CACHE_SECONDS`       | `0`                 | 0 – 31536000              | `max-age` on media responses for public, unlocked, non-burning pastes. 0 keeps everything `no-store`.                                                  |
| `STORAGE_PROVIDER`          | unset (auto)        | kv / r2 / s3              | Pins the blob backend. Unset means the precedence in [Blob storage](#blob-storage-which-bucket-and-why).                                               |
| `S3_ENDPOINT`               | unset               | –                         | S3-compatible endpoint: B2, Supabase Storage, MinIO. With the bucket and both keys, this backend wins over KV.                                         |
| `S3_BUCKET`, `S3_REGION`    | unset, `auto`       | –                         | Bucket name and region for the signature.                                                                                                              |
| `S3_PREFIX`                 | `pp/v1`             | –                         | Key prefix; bump it to move to a fresh layout in the same bucket.                                                                                      |
| `S3_VIRTUAL_HOST_STYLE`     | `off`               | –                         | `on` addresses `<bucket>.<host>`, which Supabase's S3 endpoint requires.                                                                               |
| `S3_PUBLIC_BASE`            | unset               | –                         | Public base for that bucket. With `STORAGE_DIRECT_LINKS=on` it becomes the `302` target.                                                               |
| `STORAGE_DIRECT_LINKS`      | `off`               | –                         | Hand images, video and audio straight from the bucket instead of streaming them here.                                                                  |
| `S3_PURGE_VERSIONS`         | `on`                | –                         | Delete every object version after the object itself, so a versioned bucket really shrinks. See [B2](#backblaze-b2--what-this-fork-runs-now).           |
| `STORAGE_FALLBACK`          | `auto`              | `off`, a provider name    | Read through to the store that is not primary, so a migration does not orphan old links. Deletes go to both. `off` also closes the KV share and cache. |
| `BLOB_POOL`                 | `on`                | `off`                     | `off` leaves the first complete store as the only writer and everything else read-only.                                                                |
| `BLOB_KV`                   | `auto`              | `off` / `share` / `cache` | What the namespace does: `auto` is `cache` when a bucket takes the writes, `share` when KV is the only store.                                          |
| `BLOB_KV_SHARE_MAX_BYTES`   | `262144` (256 KiB)  | 0 – 25 MiB                | `share`: largest body written to KV instead of the bucket. `0` disables the share.                                                                     |
| `BLOB_KV_CACHE_MAX_BYTES`   | `4194304` (4 MiB)   | 0 – 25 MiB                | `cache`: largest body copied into KV on a read. `0` disables the cache.                                                                                |
| `BLOB_KV_CACHE_TTL_SECONDS` | `259200` (3 days)   | 60 – 2592000              | `cache`: how long a copy lives on its own, whatever the sweep does about it.                                                                           |
| `BLOB_KV_WRITES_PER_DAY`    | `600`               | 0 – 1000                  | KV writes per UTC day across shares and cache fills. KV's free tier allows 1,000; the pool stops short of it and the bucket takes the rest.            |     |
| `SUPABASE_URL`              | unset               | –                         | Project URL for the runtime mirror. Needs a key before anything is constructed.                                                                        |
| `SUPABASE_TABLE`            | `pastes`            | –                         | Table name, if `pastes` collides with something in your project.                                                                                       |
| `SUPABASE_MIRROR`           | `auto`              | `on` / `off`              | `auto` mirrors when a `service_role` key is present; `on` without one is a boot error.                                                                 |
| `SUPABASE_KEEPALIVE`        | `on`                | –                         | The hourly call that stops a free project from pausing. `off` if you pay for the project.                                                              |
| `CLEANUP_BATCH_SIZE`        | `100`               | 1 – 1000                  | Rows per sweep step.                                                                                                                                   |
| `CLEANUP_MAX_BATCHES`       | `5`                 | 1 – 20                    | Steps per hourly run, so a sweep is always bounded.                                                                                                    |

**Secrets** (never in `wrangler.jsonc`, never in the repository):

| Secret                 | Required         | What it does                                                                                      |
| ---------------------- | ---------------- | ------------------------------------------------------------------------------------------------- |
| `APP_SECRET`           | for production   | Keys management-token hashes, password verifiers and unlock cookies. 16 characters or more.       |
| `TURNSTILE_SECRET_KEY` | with Turnstile   | Server-side validation of the Turnstile token.                                                    |
| `TURNSTILE_SITE_KEY`   | with Turnstile   | Passed to the widget as a variable, not a secret.                                                 |
| `S3_ACCESS_KEY_ID`     | with an S3 store | Key id for `S3_ENDPOINT`.                                                                         |
| `S3_SECRET_ACCESS_KEY` | with an S3 store | Secret for the same key pair. Store it as a secret, never a var.                                  |
| `SUPABASE_ANON_KEY`    | with Supabase    | The publishable key. Enough for the keep-alive call; the shipped schema gives it no table access. |
| `SUPABASE_SECRET_KEY`  | with the mirror  | The `service_role` key. It bypasses row-level security, so it is a secret and not a var.          |

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

**Nothing is permanent.** The expiry choices are 1 hour, 1 day, 7 days, 14 days and 30 days; the file tab adds a 3-day default of its own, which the API accepts as `3d` too. The API also accepts a raw number of seconds, and the server clamps it to the ceiling rather than trusting it. Client-supplied expiration is never taken at face value: a request for a year gets 30 days.

**Expiry is checked three times.** At creation the value is clamped; on every read it is compared against the clock (an expired paste answers `410` with a short page saying so, on every route); and an hourly sweep deletes the rows and their objects. A paste that lapses while somebody is looking at the reveal page stops working the moment they submit.

**Two people, one burn.** Burn-after-reading pastes show a reveal page first. A link preview, a crawler or a plain `GET` sees only the button, so nothing is spent. The button issues a `POST`, and the claim is a single atomic `UPDATE … WHERE consumed_at IS NULL RETURNING …`: exactly one caller can win, however many arrive at once. The others get `410`. An unread burn paste still expires on schedule.

**Encrypted pastes are stored as opaque bytes.** The server records the size, the creation time and the expiry, and nothing else. Titles and filenames travel inside the encrypted payload.

**Links never hop on their own.** A link lives at `/l/<id>` and shows where it goes, with the host named and the full URL spelled out, before anybody is sent there; continuing is a deliberate `POST` to `/l/<id>/go` which counts the visit. A burn link keeps its destination sealed until the continue that spends it — only absolute `http` and `https` addresses are accepted; credentials in the URL, control characters, other schemes and anything over 2048 characters are refused. There is no way to make a link auto-redirect.

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

The live, always-current version of this reference is served by every instance at `/docs`, with each example stamped with the address you read it on. What follows is the same contract, with a placeholder host.

The format is decided by the request, never by the User-Agent. An explicit `?format=` wins, then the `Accept` header, then a sensible default for the path: `/api/…` is JSON, pages are HTML. Created resources answer with their canonical page — `/p/<id>` for slips and files, `/l/<id>` for links — and the bare `/<id>` still works, forwarding to whichever it is. Lifetimes accept the menu (`1h`, `1d`, `7d`, `14d`, `30d`), the Slip aliases `1w` and `1mo`, or bare seconds.

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

### Links, stats and health

```bash
# Seal a short hop
curl -s -X POST https://paste.example.com/api/links   -H "Content-Type: application/json"   -d '{"url":"https://example.com/a-long-page","expiry":"1w","burn":false}'

# Count the visit and take the destination (what the button's POST does, as data)
curl -s -X POST https://paste.example.com/api/links/<id>/reveal

# What the front-page stat bar reads, and whether the instance is awake
curl -s https://paste.example.com/api/stats
curl -s https://paste.example.com/api/health
```

Links are deletable with the same management-token rules as pastes (`GET`/`DELETE /api/links/<id>`). A burn link's reveal spends it atomically: the second caller gets `410`.

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

The cron trigger in `wrangler.jsonc` runs `17 * * * *` — hourly at seventeen past the hour, in UTC. One run does four things (`src/services/maintenance.ts` and `src/services/cleanup.ts`):

1. **Expires rows in D1**: up to `CLEANUP_BATCH_SIZE` rows whose `expires_at` has passed, their stored objects deleted first, then the rows.
2. **Clears burn-after-reading rows** consumed more than five minutes ago — the grace period is so a reader still receives their bytes.
3. **Tends the mirror**, if one is configured: the keep-alive call, then the same expiry rule against Supabase (`purgeExpired`, same batch bounds).
4. Steps 1–3 repeat up to `CLEANUP_MAX_BATCHES` times, then stop. The run is always bounded, so a large backlog is cleared over several hours rather than in one unbounded loop.

Once a day, in the 04:00 UTC run, there is a fifth step: `sweepOrphans` walks **every store in the pool** — bucket, R2, namespace — and deletes objects no row points at, leaving anything younger than two hours alone in case it belongs to a request still in flight. That is the only step that lists, which is why it is daily rather than hourly: an hourly listing of a whole bucket is a lot of requests to find something that should not exist. A key whose age cannot be established is skipped rather than guessed, which is why KV values carry a `createdAt` stamp in their own metadata; entries written before that stamp existed are left for a later day.

Every step is idempotent and partial-failure safe: objects are removed before rows, a failed object delete leaves the row in place for the next run, and running the sweep twice in a row changes nothing. Expired pastes are unreachable whether or not the sweep has caught up, because reads check expiry themselves.

The sweep talks to the pool rather than to one store: a delete is issued to every member, so a body written before the bucket existed, or a cache copy that outlived its row, is removed by the same run that removes the live object — including every _version_ of an object on a versioned bucket, which is the part a plain `DELETE` does not do and the reason a free 10 GB bucket stays 10 GB free (`S3_PURGE_VERSIONS`). Nothing in retention depends on remembering where a file went, and that is the whole point of the shape.

To test it locally, or to force a sweep in production, see [Getting started](#5-develop) for the local trigger. In production, `npx wrangler tail` shows each run's summary line — `{ cron, supabase, supabaseDetail, mirrorRowsRemoved, orphans, ... }` — which is also where you would look to confirm the keep-alive is landing.

---

## Free plan notes

PurePaste is designed to sit comfortably inside Cloudflare's free tier.

- **Workers Free:** 100,000 requests per day and **10 ms of CPU per request**. The application does no expensive work in a request — no server-side key derivation, no full-body buffering beyond the limits above, no background writes on reads while view counting is off.
- **D1 Free:** 5 million rows read and 100,000 rows written per day, 5 GB stored. A paste is one insert and one or two indexed reads. **Turning view counting on converts every read into a write**, which is why it is off by default and why `/api/config` reports the setting.
- **R2 Free:** 10 GB-month storage, 1 million Class A operations, 10 million Class B operations per month, and no egress charge ever. Deletes are free operations, so cleanup costs nothing.
- **KV Free:** 1 GB stored and 100k reads a day, but only **1k writes, deletes and lists per day** — which is why the pool caps its own namespace use (`BLOB_KV_WRITES_PER_DAY`, 600 by default) and lets the bucket absorb whatever will not fit, rather than discovering the ceiling through a failed upload.
- **Backblaze B2 Free:** 10 GB stored, egress free up to three times average stored data, and unmetered when the bucket sits behind Cloudflare. A bucket is a plain S3 target here: `S3_ENDPOINT`, `S3_BUCKET`, `S3_REGION` and two secrets. **This is what the live deployment uses.** A versioned bucket only shrinks when the versions go too, so `S3_PURGE_VERSIONS` is on by default; a lifecycle rule is the alternative.
- **Supabase Free:** one 500 MB database and 1 GB of file storage, and **a project that sees no traffic for seven days is paused** — a cold start or a refusal for the next visitor. The hourly keep-alive call exists for that reason; read [Supabase](#supabase-a-runtime-mirror-not-a-backup) before turning the mirror on.
- **Rate limiting** uses the rate limiting binding (Wrangler 4.36+, available on both plans). Counters are per Cloudflare location rather than global, so the honest description is "close enough", not a guarantee.
- **Static assets** (CSS, fonts, the client bundle) are served without invoking the Worker at all, which keeps the request count for ordinary page views lower.

Sizes: a text paste of 10 MiB and a file of 25 MiB are the shipped ceilings (the live deployment raises `FILE_MAX_BYTES` to 50 MiB because its bytes sit in a bucket, where the KV value limit does not apply). Cloudflare's own request body limit is far higher (100 MB), so the application's limits are what bind, and they are enforced server-side.

---

## Backup, deletion and what you cannot undo

- **Deletion is immediate and irreversible.** The row and the stored object are removed on the spot. There is no recycle bin and no soft delete; on a versioned bucket the cron deletes the versions as well, because a bucket that keeps them is a bucket that is not really deleting anything.
- **There is no export.** Nothing is backed up by the application, and there is no admin interface to read other people's pastes. `wrangler d1 export` is the only way to take a copy of the database, and it will not include bodies stored in a bucket. The Supabase mirror is a runtime copy, not an export: it is written after the response, and the same sweep expires it.
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
  services/           object-store, storage-provider, s3-store, supabase-store,
                      metadata-store, paste-store, cleanup, views, turnstile, maintenance
  views/              layout and one module per page (server-rendered HTML)
  client/             browser bundle: crypto, markdown, qr, highlighting, history, pages
migrations/           D1 schema, applied by wrangler
supabase/schema.sql   optional runtime mirror, applied by hand in the dashboard
public/               static assets: stylesheet, icon, self-hosted fonts, licences
scripts/              dev, build-client, preflight
test/                 fifteen suites, run inside workerd
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
