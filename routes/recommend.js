// POST /api/recommend — pick 2-3 gallery flowers for an occasion.
// GET  /api/bouquets  — the shared feed of saved bouquets.
//
// OWNER: Agent B (see CONTRACTS.md).
//
// A request runs two text-only model calls: one asking whether an existing
// feed entry already answers this occasion (reuse it if so, and write
// nothing), then one asking which 2-3 catalog flowers suit it.
//
// Every filename the model returns is checked against the manifest before it
// is stored. Models invent plausible flowers this gallery does not have, so
// an unvalidated pick would put a broken image in the feed for everyone.

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

  // Nothing to match against, so skip the call rather than paying for the
  // model to tell us an empty list contains nothing.
  if (!bouquets.length) {
    return null;
  }

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
  let lastFailure = 'The model did not return a usable recommendation';

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
    // "note" is optional by design: it is empty for a good fit, so models
    // routinely leave it out entirely. Treat a missing note as "", and only
    // reject one that is present but not a string. Requiring it outright
    // failed perfectly good recommendations.
    const note = result && result.note === undefined ? '' : result && result.note;
    const hasRequiredText = result &&
      typeof result.name === 'string' && Boolean(result.name.trim()) &&
      typeof result.occasion === 'string' && Boolean(result.occasion.trim()) &&
      typeof result.reason === 'string' && Boolean(result.reason.trim()) &&
      typeof note === 'string';

    if (hasRequiredText && valid.length >= MIN_PICKS) {
      return {
        name: result.name.trim(),
        occasion: result.occasion.trim(),
        flowers: valid,
        reason: result.reason.trim(),
        note: note.trim(),
      };
    }

    // Say which half failed. Blaming the flowers for a text problem sends
    // the next person debugging the wrong thing.
    lastFailure = valid.length < MIN_PICKS
      ? 'The model did not return enough valid gallery flowers'
      : 'The model response was missing required text fields';
  }

  throw upstreamError(lastFailure);
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
