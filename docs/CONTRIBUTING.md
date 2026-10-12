# Contributing

Slip is one Worker, one database, one cron and a strong opinion about what a paste service should not do. The code style is not the hard part — `npm run format` decides it and the config is nine lines long. The hard part is the part every change has to respect: nothing here keeps a copy of anything forever, nothing asks a visitor's browser to trust a third party, and the row in D1 is what is true.

## The commands

```
npm install
npm run dev            # client bundle in watch mode + wrangler dev on :8787
```

Before anything is worth reviewing, these four pass:

```
npm run typecheck      # wrangler types, then tsc over src, src/client and test
npm run lint           # eslint
npm run format:check   # prettier - and it covers .md, .css and .jsonc too
npm test               # vitest: 15 files, ~230 tests, ~25s
```

And for anything that touches a deployment:

```
npm run preflight      # checks the config offline: bindings, limits, secrets it can see
npm run deploy         # preflight, then build:client, then wrangler deploy
npm run migrate:local  # and :remote - see "Migrations" below
```

`npm run dev` also gives you the cron, which is the only sane way to test cleanup:

```
curl "http://localhost:8787/cdn-cgi/local/scheduled?format=json&cron=17+*+*+*+*"
```

It answers with the same report the real schedule logs, so an expiry sweep is a two-command test: create a paste with `expire=1h`, move its `expires_at` into the past in local D1, hit that URL.

## Shape of it

| Path             | What lives there                                                            |
| ---------------- | --------------------------------------------------------------------------- |
| `src/app.ts`     | The Hono app: routes, middleware order, the not-found and error shapes.     |
| `src/routes/`    | One file per surface: create, paste, manage, links.                         |
| `src/views/`     | Server-rendered HTML as template strings. No template engine, no hydration. |
| `src/client/`    | The one bundle the browser runs, opt-in per page through `body[data-page]`. |
| `src/services/`  | Storage, metadata, crypto, maintenance, the optional Postgres mirror.       |
| `src/lib/`       | Pure helpers. If it can be a function of its arguments, it goes here.       |
| `test/`          | Vitest, one file per behaviour, run against a real Worker binding set.      |
| `migrations/`    | Append-only D1 SQL.                                                         |
| `supabase/`      | The optional mirror's schema, and nothing else.                             |
| `public/assets/` | Exactly what the Worker serves verbatim: styles, scripts, fonts, licences.  |
| `docs/`          | The social-preview card for the repository, and the script that renders it. |

Three rules the whole codebase is built around.

**1. D1 is the truth.** A row says what exists, what it is called, when it dies and which store holds the bytes. Everything else — the blob stores, the Postgres mirror — is downstream of that row. Burn-after-read needs `UPDATE pastes SET consumed_at = … WHERE id = ? AND consumed_at IS NULL`, which is why the mirror is write-through after the response and never the source of a read: PostgREST cannot do a conditional claim, and a one-time paste that can be read twice is not one-time.

**2. No store is another store's backup.** A body goes into one blob member, the row records which one, reads fall through the others, and a delete — or an expiry sweep — fans out to all of them. If you are tempted to "keep a copy in KV as well, to be safe", stop: that is how a service with a 10 GiB free bucket ends up with forever storage and a manual cleanup job. The orphan sweep in `src/services/maintenance.ts` exists so that a body with no row still goes away.

**3. Expiry is enforced by the app.** Any feature that stores something has to answer, in the code, "when does this go away and what finds it". A TTL the platform happens to enforce (KV `expirationTtl`) is a convenience on top of the sweep, never the reason a row is trusted to disappear.

## Tests

- **Never hardcode a limit.** The test environment reads `vars` from `wrangler.jsonc`, so a number baked into a test passes today and fails when someone tunes an instance. Import `testConfig` from `./helpers`, or build a variant the way `test/limits.test.ts` does: `{ ...testConfig, fileMaxBytes: 1024 }`.
- A multi-member storage pool cannot come from the test bindings (the test Worker binds KV only). Build it directly: `new BlobPool([poolMember("s3", fakeA), poolMember("kv", fakeB)])`.
- Anything needing the execution context takes it through `deferrer(c)` (`src/lib/ctx.ts`) — `c.executionCtx` is a throwing getter outside a real request, and a deferred cache fill must stay deferred in tests too. A test that `await`s the fill is testing something the app does not do.
- Do not spread the env object into `worker.scheduled(...)`: it `DataCloneError`s on anything non-cloneable. Pass a literal `{ type: "scheduled", cron, scheduledTime, noCache: false }` and a hand-made `{ waitUntil, passThroughOnException }`.
- There is no network in tests. A code path that reaches out has to be behind a binding or a fake, and `getaddrinfo()` errors in a run mean a test is quietly trying to leave the sandbox.
- `objectKeys()` in the storage tests counts every `pp/v1/*` key in a shared namespace — those suites `beforeEach(resetStorage)` for a reason.

## Migrations and columns

`migrations/` is append-only: an applied file is history, including on the remote database, so add `0003_….sql` rather than editing `0002_blob_store.sql`.

`src/services/metadata-store.ts` builds its `SELECT` list, its `INSERT` column list and its placeholder list from one `COLUMNS` array. Add a name there and you must add the placeholder and the `toRecord` mapping in the same commit, or every create dies on a count mismatch. The mirror in `src/services/supabase-store.ts` then has to be asked deliberately: it must not send a column a deployed table does not have, because that is a 400 on every write, and an instance whose operator never re-ran the schema is a real instance.

## Adding a setting

1. Declare it in `src/env.ts` so the variable has a type and a comment.
2. Parse and clamp it in `resolveConfig` (`src/config.ts`) — clamp, don't trust: every limit here has an input that breaks it.
3. Give it a default in `wrangler.jsonc` if the deployment needs one, and make sure `preflight` likes it.
4. Add a row to the configuration table in `README.md`, and to `/docs` when a client or operator can observe the difference.
5. Add the boundary values to `test/limits.test.ts`: zero, one over, one under, and something absurd.

## Commits, and what a review looks for

- Imperative subject, about 72 characters, and the body says **why**. "Fix copy bug" tells a reader nothing in six months; "Wire a copy button once, not once per caller" does.
- One behaviour per commit. A reformat and a behaviour change are two commits, in that order.
- `npm run format` before you commit. The repository is prettier-clean at every commit, and a follow-up "style" commit is noise in the log.
- Markdown and CSS count as code here: a prose fix still runs through `format:check`.
- If a change alters what is stored, what is sent to a third party, or what a browser is asked to trust, open an issue first. Typos, failing tests, obvious bugs: send the pull request.
- Security goes to the private report form — see `SECURITY.md`, and never to an issue.

## Deliberately not here

These are not gaps to fill, and a pull request adding one will be closed with thanks rather than argued with:

- Range requests on `GET /p/:id/media`, so `<video>` cannot scrub. Byte serving belongs on the bucket or the CDN in front of it.
- Any listing of pastes, an admin panel, accounts, analytics, or a third-party CDN or font host. The pages fetch nothing that is not this origin.
- A "keep forever" TTL, an unexpiring object, or a store that mirrors another store as insurance.
- Virus scanning, content moderation, and DMCA machinery beyond an abuse contact at the host.
- Client-side frameworks, hydration, or a build step that turns the views into a single-page app.

Forks are the point of the licence. All of the above are one `src/` directory away in a fork, and MIT means nobody has to agree here first.

## Licence

The repository is MIT. Sending a patch means you license it under MIT as well and confirm you are allowed to — if you wrote it at work, check who owns it. Nothing you send is required to be tested, formatted or documented to be _read_, but it has to be all three to be merged.
