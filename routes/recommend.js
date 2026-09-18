// POST /api/recommend — pick 2-3 gallery flowers for an occasion.
// GET  /api/bouquets  — the shared feed of saved bouquets.
//
// OWNER: Agent B (see CONTRACTS.md).
//
// STATUS: stub. GET /api/bouquets already works against the seeded feed, so
// the frontend (Agent C) can build the sidebar against real-shaped data now.
// POST /api/recommend returns 501 until Agent B implements it.
//
// What Phase 2 has to do, per CONTRACTS.md:
//   1. Validate the question: non-empty, <= MAX_QUESTION_LENGTH characters.
//   2. Dedup call - ask the text model whether an existing entry already
//      answers this occasion. On a hit, return it with reused: true and
//      write nothing.
//   3. Pick call - send the flower catalog (see buildCatalog below) and ask
//      for strict JSON: { name, occasion, flowers, reason, note }.
//   4. Validate every returned filename with flowers.isValidFile(). Models
//      invent plausible filenames that are not in this gallery. Drop the
//      invalid ones; if fewer than MIN_PICKS survive, retry once, then fail
//      rather than storing a broken entry.
//   5. Append via cache.updateJson (NOT readJson + writeJson) and trim the
//      feed to MAX_FEED_ENTRIES, newest first.
//
// lib/groq.js has completeJson() for prompts that must return JSON, and
// lib/cache.js has updateJson() for the read-modify-write.

const path = require('path');
const { readJson } = require('../lib/cache');
const flowers = require('../lib/flowers');

const BOUQUETS_FILE = path.join(__dirname, '..', 'bouquets.json');

// Limits from CONTRACTS.md. Change them there first.
const MAX_QUESTION_LENGTH = 100;
const MAX_FEED_ENTRIES = 30;
const MIN_PICKS = 2;
const MAX_PICKS = 3;

const EMPTY_FEED = { bouquets: [] };

// The catalog handed to the model when picking. Descriptions come from the
// same cache the gallery fills in, and a flower that has not been described
// yet simply goes in with its name and color - thinner context, not an error.
function buildCatalog() {
  const descriptions = readJson(
    path.join(__dirname, '..', 'descriptions.json'),
    {}
  );
  return flowers.listFlowers().map(flower => ({
    file: flower.file,
    name: flower.name,
    color: flower.colorLabel,
    description: descriptions[flower.file] || null,
  }));
}

function readFeed() {
  return readJson(BOUQUETS_FILE, EMPTY_FEED);
}

// GET /api/bouquets
function listBouquets(req, res) {
  res.json(readFeed());
}

// POST /api/recommend
async function recommend(req, res) {
  res.status(501).json({
    error: 'Recommendations are not implemented yet.',
  });
}

module.exports = {
  recommend,
  listBouquets,
  buildCatalog,
  readFeed,
  BOUQUETS_FILE,
  MAX_QUESTION_LENGTH,
  MAX_FEED_ENTRIES,
  MIN_PICKS,
  MAX_PICKS,
  EMPTY_FEED,
};
