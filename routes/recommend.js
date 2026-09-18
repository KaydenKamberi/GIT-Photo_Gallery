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
const { readJson, updateJson } = require('../lib/cache');
const flowers = require('../lib/flowers');
const groq = require('../lib/groq');

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

function upstreamError(message) {
  const error = new Error(message);
  error.status = 502;
  return error;
}

async function findReusableBouquet(question, feed) {
  const bouquets = Array.isArray(feed.bouquets) ? feed.bouquets : [];
  const entries = bouquets.map(({ name, occasion }) => ({ name, occasion }));
  const decision = await groq.completeJson({
    model: groq.textModel(),
    maxTokens: 120,
    temperature: 0.1,
    messages: [
      {
        role: 'system',
        content: [
          'Decide whether an existing bouquet already answers the user occasion.',
          'Return strict JSON only: {"match":false,"index":null}.',
          'For a match, set match to true and index to its zero-based array index.',
          'Match semantically equivalent or strongly overlapping uses, not just exact wording.',
          'For example, an existing romantic Valentine bouquet can answer a romantic dinner.',
          'Do not match entries that merely happen to contain related flowers.',
        ].join(' '),
      },
      {
        role: 'user',
        content: JSON.stringify({ question, entries }),
      },
    ],
  });

  if (!decision || typeof decision !== 'object') {
    throw upstreamError('The model returned an unusable deduplication result');
  }
  if (!decision.match) {
    return null;
  }

  const index = Number.isInteger(decision.index) ? decision.index : -1;
  if (index >= 0 && index < bouquets.length) {
    return bouquets[index];
  }

  // Never trust a model-generated bouquet here; a reuse must resolve to an
  // entry from the feed that was sent to the model.
  const matched = bouquets.find(bouquet => (
    (decision.name && bouquet.name === decision.name) ||
    (decision.occasion && bouquet.occasion === decision.occasion)
  ));
  if (!matched) {
    throw upstreamError('The model returned an unusable deduplication match');
  }
  return matched;
}

async function pickBouquet(question) {
  const catalog = buildCatalog();
  const allowedFiles = catalog.map(flower => flower.file);
  let result = null;

  for (let attempt = 0; attempt < 2; attempt++) {
    result = await groq.completeJson({
      model: groq.textModel(),
      maxTokens: 300,
      temperature: 0.3,
      messages: [
        {
          role: 'system',
          content: [
            'Recommend 2 or 3 flowers from the supplied gallery catalog.',
            'Return strict JSON only with: name, occasion, flowers, reason, note.',
            'Copy every filename exactly from the catalog.',
            `The complete allowed filename list is: ${JSON.stringify(allowedFiles)}.`,
            'Normalize the occasion.',
            'Use an empty note for a good fit, or an honest caveat for an imperfect fit.',
            'Preserve important constraints from the request instead of reducing them to a generic celebration.',
            'Unusual, fictional, or highly specific themes need a caveat when the catalog is not actually themed for them.',
            'Do not refuse imperfect requests and do not invent flowers.',
            attempt
              ? 'This is a retry because the previous answer had fewer than 2 valid filenames.'
              : '',
          ].join(' '),
        },
        {
          role: 'user',
          content: JSON.stringify({ question, catalog }),
        },
      ],
    });

    const candidates = result && Array.isArray(result.flowers)
      ? result.flowers
      : [];
    const valid = [...new Set(
      candidates.filter(file => flowers.isValidFile(file))
    )].slice(0, MAX_PICKS);
    const hasRequiredText = result &&
      typeof result.name === 'string' && Boolean(result.name.trim()) &&
      typeof result.occasion === 'string' && Boolean(result.occasion.trim()) &&
      typeof result.reason === 'string' && Boolean(result.reason.trim()) &&
      typeof result.note === 'string';

    if (hasRequiredText && valid.length >= MIN_PICKS) {
      return {
        name: result.name.trim(),
        occasion: result.occasion.trim(),
        flowers: valid,
        reason: result.reason.trim(),
        note: result.note.trim(),
      };
    }
  }

  throw upstreamError('The model did not return enough valid gallery flowers');
}

// GET /api/bouquets
function listBouquets(req, res) {
  res.json(readFeed());
}

// POST /api/recommend
async function recommend(req, res) {
  try {
    const question = req.body && req.body.question;
    if (typeof question !== 'string' || !question.trim()) {
      return res.status(400).json({ error: 'Question is required' });
    }
    if (question.length > MAX_QUESTION_LENGTH) {
      return res.status(400).json({
        error: `Question must be ${MAX_QUESTION_LENGTH} characters or fewer`,
      });
    }

    const reusable = await findReusableBouquet(question, readFeed());
    if (reusable) {
      return res.json({ bouquet: reusable, reused: true });
    }

    const picked = await pickBouquet(question);
    const bouquet = {
      id: `bouquet-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      name: picked.name,
      question,
      occasion: picked.occasion,
      flowers: picked.flowers,
      reason: picked.reason,
      note: picked.note,
      createdAt: new Date().toISOString(),
    };

    const saved = updateJson(BOUQUETS_FILE, EMPTY_FEED, fresh => {
      const bouquets = Array.isArray(fresh.bouquets) ? fresh.bouquets : [];
      return { bouquets: [bouquet, ...bouquets].slice(0, MAX_FEED_ENTRIES) };
    });
    if (!saved) {
      const error = new Error('Could not save the recommended bouquet');
      error.status = 500;
      throw error;
    }

    return res.json({ bouquet, reused: false });
  } catch (error) {
    console.error('Error in recommend:', error);
    return res.status(error.status || 500).json({
      error: error.status ? error.message : 'Internal server error: ' + error.message,
    });
  }
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
