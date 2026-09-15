require('dotenv').config();
const express = require('express');
const path = require('path');
const fs = require('fs');
const app = express();
const PORT = process.env.PORT || 3000;

// Cache file path
const CACHE_FILE = path.join(__dirname, 'descriptions.json');

// Helper to read cache
function readCache() {
  try {
    if (!fs.existsSync(CACHE_FILE)) {
      return {};
    }
    const data = fs.readFileSync(CACHE_FILE, 'utf8');
    return JSON.parse(data);
  } catch (error) {
    console.error('Error reading cache:', error);
    return {};
  }
}

// Helper to write cache
// Writes to a temp file then renames: rename is atomic, so a crash mid-write
// can't leave behind truncated JSON that readCache would discard entirely.
function writeCache(cache) {
  const tempFile = CACHE_FILE + '.tmp';
  try {
    fs.writeFileSync(tempFile, JSON.stringify(cache, null, 2), 'utf8');
    fs.renameSync(tempFile, CACHE_FILE);
  } catch (error) {
    console.error('Error writing cache:', error);
    try {
      fs.unlinkSync(tempFile);
    } catch (cleanupError) {
      // Temp file may not exist; nothing to clean up.
    }
  }
}

// Middleware to parse JSON bodies
app.use(express.json());

// Serve static files (HTML, CSS, client-side JS)
app.use(express.static(path.join(__dirname)));

// CORS middleware for API routes
app.use('/api/*', (req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  next();
});

// Groq API endpoint for image description
app.post('/api/describe-image', async (req, res) => {
  try {
    const { imageUrl } = req.body;
    
    if (!imageUrl) {
      return res.status(400).json({ error: 'Image URL is required' });
    }

    // Check cache first
    const cache = readCache();
    if (cache[imageUrl]) {
      return res.json({ caption: cache[imageUrl] });
    }

    const groqApiKey = process.env.GROQ_API_KEY;
    if (!groqApiKey) {
      return res.status(500).json({ 
        error: 'Server not configured with Groq API key' 
      });
    }

    // Fetch the image as base64
    const imageResponse = await fetch(imageUrl);
    if (!imageResponse.ok) {
      return res.status(400).json({ 
        error: 'Failed to fetch image from URL' 
      });
    }
    
    const imageBuffer = await imageResponse.arrayBuffer();
    const base64Image = Buffer.from(imageBuffer).toString('base64');

    // Call Groq API with Llama 3.2 11B Vision
    const groqResponse = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${groqApiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: process.env.GROQ_MODEL || 'qwen/qwen3.8-27b',
        reasoning_effort: 'none',
        reasoning_format: 'hidden',
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: 'Write a one-sentence caption for this flower image. Name the flower, then briefly describe its appearance. Output only the caption.' },
              { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${base64Image}` } }
            ]
          }
        ],
        max_tokens: 150,
        temperature: 0.3,
      }),
    });

    if (!groqResponse.ok) {
      const errorData = await groqResponse.json();
      console.error('Groq API error:', errorData);
      return res.status(500).json({ 
        error: 'Groq API error: ' + (errorData.error?.message || 'Unknown error') 
      });
    }

    const data = await groqResponse.json();
    const raw = data.choices[0]?.message?.content || '';
    const caption = raw.replace(/^[\s\S]*<\/think>/, '').trim();

    // Update cache. Re-read first: the snapshot taken before the API call is
    // now stale, and writing it back would clobber entries saved by requests
    // that finished while this one was waiting on Groq.
    if (caption) {
      const freshCache = readCache();
      freshCache[imageUrl] = caption;
      writeCache(freshCache);
    }
    
    res.json({ caption });
    
  } catch (error) {
    console.error('Error in describe-image:', error);
    res.status(500).json({ 
      error: 'Internal server error: ' + error.message 
    });
  }
});

// Start server
app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
