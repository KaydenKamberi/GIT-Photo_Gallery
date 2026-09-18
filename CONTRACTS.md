# CONTRACTS.md

Working agreement for building the bouquet recommendation feature with more
than one AI agent at a time (Claude, Mistral, Replit AI).

**Everything in this file is frozen.** Code against what is written here, not
against what another agent happens to have pushed. If you need something here
to change, stop and ask the repo owner — do not change it and keep going.

---

## 1. Who owns what

Each file has exactly one owner. Do not edit a file you do not own, even to
fix an obvious bug in it — report it instead.

| Owner | Files | Job |
|---|---|---|
| **Agent A** | `routes/describe.js`, `image.html` | Phase 1: convert the description endpoint to the `{ file }` contract |
| **Agent B** | `routes/recommend.js` | Phase 2: implement `POST /api/recommend` |
| **Agent C** | `index.html` | Phase 3: sidebar, ask bar, feed, highlight |
| **Nobody** | `lib/*`, `server.js`, `flowers.json`, `scripts/smoke.js`, this file | Frozen — read-only to all agents |

`bouquets.json` is shared data, not code. Nobody edits it by hand during the
build; see §6.

**If you are an agent reading this for the first time:** find your row, read
§2 and §3, read the `STATUS` comment at the top of your file, and stay inside
it.

---

## 2. API contracts

### `POST /api/describe-image` — Agent A

Request:

```json
{ "file": "red-roses.jpeg" }
```

Response `200`:

```json
{ "caption": "A bouquet of deep red roses with dark green leaves." }
```

Rules:

- `file` must pass `flowers.isValidFile()`. Anything else → `400`
  `{ "error": "Not a gallery image" }`. This is the allowlist that replaces
  the old arbitrary-URL fetch — do not add a fallback that accepts a URL.
- Read the image from disk with `flowers.imagePath(file)`. Do not fetch it
  over HTTP.
- Build the data URI with `flowers.mimeType(file)`, not a hardcoded
  `image/jpeg`.
- Cache key is the bare filename (`red-roses.jpeg`), never a URL.
- Pass the flower's name into the prompt — we know it now, so the model
  should not be guessing the species.
- Cache writes go through `cache.updateJson`, never `readJson` + `writeJson`.

Existing `descriptions.json` entries are keyed by old URLs and become
orphaned. That is expected; do not write a migration.

### `POST /api/recommend` — Agent B

Request:

```json
{ "question": "flowers for valentines day" }
```

Response `200`:

```json
{
  "bouquet": { "...": "a bouquet object, see §3" },
  "reused": false
}
```

`reused: true` means an existing entry already answered this occasion and
nothing new was stored. The frontend shows those differently, so this field is
required on every success response.

Rules:

- Reject a missing/empty `question`, or one over `MAX_QUESTION_LENGTH` (100)
  characters → `400` with an `error`.
- **Dedup call first.** Ask the text model whether any existing entry already
  answers this occasion, sending existing `name` + `occasion` values. On a
  hit, return that entry with `reused: true` and write nothing.
- **Pick call second.** Send the catalog from `buildCatalog()` and require
  strict JSON back: `{ name, occasion, flowers, reason, note }`.
- **Validate every returned filename** with `flowers.isValidFile()`. The model
  will sometimes return a plausible flower that is not in this gallery
  (`white-lily.jpeg`). Drop invalid entries. If fewer than `MIN_PICKS` (2)
  survive, retry the pick once; if it fails again, return `502` rather than
  storing a broken bouquet. Never store an unvalidated filename.
- Cap picks at `MAX_PICKS` (3).
- When the gallery does not really cover the request, still return picks and
  put the honest caveat in `note`. Do not refuse, and do not pretend a bad
  match is a good one.
- Append through `cache.updateJson` and trim to `MAX_FEED_ENTRIES` (30),
  newest first.
- Use `groq.textModel()`, not the vision model. Neither call needs to see an
  image.

### `GET /api/bouquets` — already implemented

Returns the whole feed: `{ "bouquets": [ ... ] }`, newest first. Agent C can
rely on this now; it reads the seeded file.

### Error shape

Every error response from every endpoint:

```json
{ "error": "human readable message" }
```

`400` bad input · `500` server misconfigured (no API key) · `502` upstream
model failed or returned unusable output · `501` not implemented yet.

---

## 3. `bouquets.json` schema

```json
{
  "bouquets": [
    {
      "id": "string, unique",
      "name": "Valentine's Classic",
      "question": "flowers for valentines day",
      "occasion": "Valentine's Day",
      "flowers": ["red-roses.jpeg", "red-tulips.jpeg"],
      "reason": "Why these flowers suit the occasion.",
      "note": "",
      "createdAt": "2026-09-16T12:00:00.000Z"
    }
  ]
}
```

- `occasion` is the model's normalized reading of the ask. **Dedup matches on
  this, not on `question`.**
- `question` is the raw text the user typed, kept for transparency.
- `name` is the AI-written bouquet title, and what the sidebar shows.
- `flowers` holds 2–3 filenames, every one of them present in `flowers.json`.
- `note` is `""` when the picks are a genuinely good fit, otherwise the honest
  caveat.
- Newest entry first.

---

## 4. `flowers.json` schema (existing, frozen)

```json
{
  "imageDir": "Images",
  "colors": [
    {
      "id": "red",
      "label": "Reds",
      "swatch": "#d32f2f",
      "flowers": [
        { "file": "red-roses.jpeg", "name": "Red Roses", "alt": "..." }
      ]
    }
  ]
}
```

Section order on the page follows `colors` order. Do not add flowers during
the build — a changing catalog while three agents test against it wastes
everyone's time.

---

## 5. Shared helpers — use these, do not reimplement

**`lib/cache.js`**
- `readJson(path, fallback)` — never throws
- `writeJson(path, data)` — atomic (temp file + rename)
- `updateJson(path, fallback, mutator)` — **use this for any read-modify-write.**
  It re-reads immediately before writing. A snapshot taken before an `await`
  is stale by the time the model responds, and writing it back silently drops
  whatever another request saved meanwhile. This bug has already been fixed
  once in this repo; do not reintroduce it.

**`lib/flowers.js`**
- `listFlowers()` — flat array with `color` and `colorLabel` attached
- `findFlower(file)` / `isValidFile(file)` — the allowlist
- `imagePath(file)` — absolute disk path, throws for non-gallery files
- `mimeType(file)` — from the extension

**`lib/groq.js`**
- `complete({ messages, model, maxTokens, temperature })` — returns text with
  `<think>` stripped; throws with `error.status` set
- `completeJson(...)` — same, parsed as JSON; returns `null` if unparseable
- `visionModel()` / `textModel()` — respect `GROQ_MODEL` / `GROQ_TEXT_MODEL`

Route handlers should rethrow `lib/groq` errors and use `error.status` for the
response code.

---

## 6. Git workflow

1. Branch off the integration branch, not `main`. One branch per agent:
   `agent-a/describe`, `agent-b/recommend`, `agent-c/sidebar`.
2. Before pushing: rebase on the integration branch, then run
   `node scripts/smoke.js`. **Push only if it is green.**
3. Never commit `bouquets.json`. The server writes to it, so every agent
   running locally generates a different version and you will spend more time
   resolving that one file than writing the feature. Run this once, locally:

   ```sh
   git update-index --skip-worktree bouquets.json
   ```

   The owner commits the real feed at the end.
4. Never commit `.env`, `descriptions.json`, or `node_modules/`.
5. Do not merge another agent's branch into yours. The owner integrates.

---

## 7. Smoke test

```sh
npm start &          # or let the script find a server already running
node scripts/smoke.js
```

It checks static files, manifest integrity, both endpoints' shapes, and drives
both pages in a headless browser. Checks for unimplemented phases report
`PENDING` and do not fail the run, so it is green from day one and gets
stricter as each phase lands.

It does not verify AI output quality — no API key is needed, and none of the
checks call Groq. Judging whether a bouquet is any good is a human job.

---

## 8. Ground rules

- **Do not edit a file you do not own.** Report the problem instead.
- **Do not change anything in this document.** Ask.
- **Do not add dependencies.** The project is vanilla Node + Express on
  purpose. No build step, no framework, no bundler.
- **Do not add flowers or change `flowers.json`** during the build.
- **Match the surrounding style.** Two-space indent, `const`, plain functions,
  comments that explain *why* rather than restating the code.
- **If the contract is wrong, say so before building on it.** A contract
  everyone silently works around is worse than no contract.
