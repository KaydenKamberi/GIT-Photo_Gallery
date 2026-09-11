require('dotenv').config();
const express = require('express');
const path = require('path');
const app = express();
const PORT = process.env.PORT || 3000;

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

// Google AI Studio API endpoint for image description
app.post('/api/describe-image', async (req, res) => {
  try {
    const { imageUrl } = req.body;
    
    if (!imageUrl) {
      return res.status(400).json({ error: 'Image URL is required' });
    }

    const googleApiKey = process.env.GOOGLE_AI_API_KEY;
    if (!googleApiKey) {
      return res.status(500).json({ 
        error: 'Server not configured with Google AI API key' 
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

    // Call Google AI Studio API (Gemini 1.5 Flash)
    const googleResponse = await fetch(
      `https://generativelanguage.googleapis.com/v1/models/gemini-1.5-flash-latest:generateContent?key=${googleApiKey}`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          contents: [{
            parts: [
              { text: "Write a short, descriptive caption for this image." },
              {
                inlineData: {
                  mimeType: "image/jpeg",
                  data: base64Image
                }
              }
            ]
          }],
          generationConfig: {
            maxOutputTokens: 100,
            temperature: 0.7,
          },
        }),
      }
    );

    if (!googleResponse.ok) {
      const errorData = await googleResponse.json();
      console.error('Google AI API error:', errorData);
      return res.status(500).json({ 
        error: 'Google AI API error: ' + (errorData.error?.message || JSON.stringify(errorData))
      });
    }

    const data = await googleResponse.json();
    const caption = data.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || '';
    
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
