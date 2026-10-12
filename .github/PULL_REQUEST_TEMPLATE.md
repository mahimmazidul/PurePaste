<!--
One behaviour per pull request, and the paragraph below is the part a reviewer reads
first. Delete a line that genuinely does not apply instead of leaving it unchecked.
Anything that changes what is stored, what leaves the origin, or what a browser is
asked to trust: open an issue before writing code (docs/CONTRIBUTING.md says why).
-->

## What changed

One paragraph. What a reader would notice, not which files were touched — `git` says that.

## Why now

The bug you hit, the gap in the docs, the limit that bit you. "It would be nicer" is a fine reason for a fork and a weak one for a pull request here.

## What it touches

- [ ] what is **stored** — a column, an object key, a value
- [ ] when it is **deleted** — expiry, the hourly sweep, the orphan pass
- [ ] a **read path** — `/raw`, `/download`, `/p/:id/media`, the pool's fall-through order
- [ ] what a **browser fetches** — a script, a style, a font, an origin in the CSP or `img-src`
- [ ] the **API surface** — a route, a field, a status, an error name, a limit
- [ ] none of the above: copy, comments, a test, a build script

For each box ticked, one line in the reply:

- **stored or deleted** — which store holds it, and how the sweep finds it again in a week. A body no row points at still has to go away, and no store is another store's backup: a write that "keeps a copy to be safe" is the one shape this repository refuses.
- **read path** — a burn-after-read paste must stay unspent by a preview, a locked one must stay locked, and the store named on the row is what decides where the bytes come from.
- **browser fetches** — the pages fetch nothing that is not this origin, and the CSP is built from `default-src 'none'`. If a line here adds an origin, quote where that was agreed.
- **API surface** — `/docs` and the README configuration table change in the same pull request, and the new error name has to read well inside a 400 body.

## Gates

- [ ] `npm run typecheck`
- [ ] `npm run lint`
- [ ] `npm run format:check`
- [ ] `npm test`
- [ ] `npm run preflight`
- [ ] `npm run dev`, and the page looked at in a browser at 1280px **and** 390px — for anything a visitor sees. Real states, not the empty page: a file selected, an image decoded, an error shown.
- [ ] the two-command cron test from `docs/CONTRIBUTING.md`, when a change can strand or delete a paste
- [ ] new behaviour has a test; a new or changed limit has its boundaries in `test/limits.test.ts` (zero, one under, one over, absurd)

## Dependencies

`hono` is the only runtime dependency and `highlight.js` the only third-party library in the browser bundle — that is the whole list, on purpose. (`qrcode-generator` was dropped in `slip`-land when the QR feature went away and nothing re-added it: `npm run build:client` output is byte-identical with the dependency installed or not, which is how the removal was checked.) A new one needs a paragraph about why nothing already here could do it, and it needs a licence that survives being vendored into `public/assets/` with a row on `/licenses`.

## Licence

- [ ] I wrote this, or I have permission to contribute it, and I license it under the repository's MIT licence.
