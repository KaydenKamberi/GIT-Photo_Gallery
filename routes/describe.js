// POST /api/describe-image — AI description for one gallery image.
//
// OWNER: Agent A (see CONTRACTS.md).

const fs = require('fs');
const path = require('path');
const { readJson, updateJson } = require('../lib/cache');
const flowers = require('../lib/flowers');
const groq = require('../lib/groq');

const CACHE_FILE = path.join(__dirname, '..', 'descriptions.json');

function buildPrompt(flower) {
  // The flower's name comes from the manifest, so the model describes the
  // photo instead of guessing the species.
  return [
    `This is a photo of ${flower.name.toLowerCase()}.`,
    'Write a one-sentence caption describing its appearance.',
    'Output only the caption.',
  ].join(' ');
}

async function describeImage(req, res) {
  try {
    const { file } = req.body;

    if (!file) {
      return res.status(400).json({ error: 'Image file is required' });
    }

    // The manifest is the allowlist. A filename is usable only if it is
    // literally listed in flowers.json, which rejects path traversal and
    // made-up filenames alike.
    const flower = flowers.findFlower(file);
    if (!flower) {
      return res.status(400).json({ error: 'Not a gallery image' });
    }

    // Cache is keyed by bare filename, so entries are stable across
    // localhost and any deployed domain.
    const cache = readJson(CACHE_FILE, {});
    if (cache[file]) {
      return res.json({ caption: cache[file] });
    }

    if (!groq.hasApiKey()) {
      return res.status(500).json({
        error: 'Server not configured with Groq API key',
      });
    }

    // Read the image off disk rather than fetching it over HTTP: the file is
    // right here, and the server no longer needs to make outbound requests to
    // URLs supplied by a client.
    let base64Image;
    try {
      base64Image = fs.readFileSync(flowers.imagePath(file)).toString('base64');
    } catch (error) {
      console.error('Could not read image ' + file + ':', error);
      return res.status(500).json({ error: 'Could not read the image file' });
    }

    const caption = await groq.complete({
      model: groq.visionModel(),
      maxTokens: 150,
      temperature: 0.3,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: buildPrompt(flower) },
            {
              type: 'image_url',
              image_url: {
                url: `data:${flowers.mimeType(file)};base64,${base64Image}`,
              },
            },
          ],
        },
      ],
    });

    // updateJson re-reads before writing, so a request that finished while
    // this one waited on Groq doesn't get clobbered.
    if (caption) {
      updateJson(CACHE_FILE, {}, fresh => {
        fresh[file] = caption;
        return fresh;
      });
    }

    res.json({ caption });
  } catch (error) {
    console.error('Error in describe-image:', error);
    res.status(error.status || 500).json({
      error: error.status ? error.message : 'Internal server error: ' + error.message,
    });
  }
}

module.exports = { describeImage, CACHE_FILE };
