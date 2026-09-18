# Photo Gallery

A flower gallery with AI-written descriptions. Vanilla HTML/CSS/JS on the
front, a small Express server behind it. No build step, no framework.

## Run

```sh
npm install
npm start          # http://localhost:3000
```

Set `GROQ_API_KEY` in `.env` (or Replit Secrets) for the AI descriptions.
Without it the gallery still renders; description requests report that the
server is not configured.

Optional: `GROQ_MODEL` (vision, for image descriptions) and `GROQ_TEXT_MODEL`
(text, for bouquet recommendations).

## Check your work

```sh
npm run smoke
```

Starts a server on port 3001, checks the manifest, both pages, and every
endpoint's response shape, then drives the pages in a headless browser.
Needs no API key and makes no AI calls. Browser checks are skipped if
Playwright is not installed (`npm i --no-save playwright`).

## Layout

```
index.html          gallery, grouped into a section per color
image.html          single-image page with the AI caption
flowers.json        the catalog: filename, name, alt text, color
Images/             the photos
server.js           wiring only
lib/                shared helpers (cache, manifest, Groq)
routes/             endpoint handlers
scripts/smoke.js    smoke test
bouquets.json       saved bouquet recommendations
```

## Adding a flower

1. Put the photo in `Images/`, named after the flower (`white-lily.jpeg`).
2. Add an entry to the right color in `flowers.json`.

Both pages read `flowers.json`, so nothing else needs editing. A new color
group is another object in `colors`; array order is section order on the page.

## Working on the bouquet feature

**Read [CONTRACTS.md](CONTRACTS.md) first.** Multiple agents build on this
repo in parallel, and it defines who owns which files, the API contracts, and
the rules. Files marked `FROZEN` are read-only — if one needs to change, ask
the repo owner rather than editing it.
