// POST /api/describe-image — AI description for one gallery image.
//
// OWNER: Agent A (see CONTRACTS.md).
//
// STATUS: this is the pre-existing implementation, moved here unchanged by
// the Phase 0 refactor. It still takes { imageUrl } and fetches the image
// over HTTP. Phase 1 converts it to the { file } contract in CONTRACTS.md:
// validate against the manifest, read the bytes from disk, key the cache by
// filename, and pass the flower's name into the prompt. lib/flowers.js
// already has everything that needs (isValidFile, imagePath, mimeType).

const path = require('path');
const { readJson, updateJson } = require('../lib/cache');
const groq = require('../lib/groq');

const CACHE_FILE = path.join(__dirname, '..', 'descriptions.json');

async function describeImage(req, res) {
  try {
    const { imageUrl } = req.body;

    if (!imageUrl) {
      return res.status(400).json({ error: 'Image URL is required' });
    }

    // Check cache first
    const cache = readJson(CACHE_FILE, {});
    if (cache[imageUrl]) {
      return res.json({ caption: cache[imageUrl] });
    }

    if (!groq.hasApiKey()) {
      return res.status(500).json({
        error: 'Server not configured with Groq API key',
      });
    }

    // Fetch the image as base64
    const imageResponse = await fetch(imageUrl);
    if (!imageResponse.ok) {
      return res.status(400).json({ error: 'Failed to fetch image from URL' });
    }

    const imageBuffer = await imageResponse.arrayBuffer();
    const base64Image = Buffer.from(imageBuffer).toString('base64');

    const caption = await groq.complete({
      model: groq.visionModel(),
      maxTokens: 150,
      temperature: 0.3,
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'text',
              text: 'Write a one-sentence caption for this flower image. Name the flower, then briefly describe its appearance. Output only the caption.',
            },
            {
              type: 'image_url',
              image_url: { url: `data:image/jpeg;base64,${base64Image}` },
            },
          ],
        },
      ],
    });

    // updateJson re-reads before writing, so a request that finished while
    // this one waited on Groq doesn't get clobbered.
    if (caption) {
      updateJson(CACHE_FILE, {}, fresh => {
        fresh[imageUrl] = caption;
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
