# Slip — a quiet place for text

A humane, eye-soothing pastebin. Warm paper tones, serif display type, honest
microcopy — no gradients, no glass, no slop.

Everything expires. Nothing is listed or indexed. The link is the only way in.

## Features

- **Slips** — text, code or Markdown with a self-growing editor, 28 languages,
  lifetimes from one hour to thirty days
- **Reading view** — syntax highlighting tuned per theme, aligned line-number
  gutter, wrap toggle, copy / save / raw
- **Password protection** — scrypt-hashed, verified with a timing-safe compare
- **Burn after reading** — a preview-proof gate; the slip is destroyed on reveal
- **Links** — short links that show their destination before they send you on
- **Custom names** — `/p/my-note`, and a device-local drawer holding your delete keys

## Stack

Next.js (App Router) · PostgreSQL via Drizzle ORM · Tailwind CSS v4 ·
highlight.js · react-markdown

## Getting started

```sh
cp .env.example .env   # fill in DATABASE_URL
npm install
npx drizzle-kit push   # create tables
npm run dev
```

## Layout

- `src/lib` — domain logic (ids, passwords, time, pastes, links, constants)
- `src/app/api` — route handlers (create / meta / reveal / delete)
- `src/app/p/[id]`, `src/app/l/[id]` — slip and link pages (+ `/raw`)
- `src/components` — composer, view, gates, interstitial, chrome
