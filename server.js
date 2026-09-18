// Server wiring only. Endpoint logic lives in routes/, shared helpers in lib/.
//
// FROZEN FILE — see CONTRACTS.md. Do not edit while parallel work is in
// progress; ask the repo owner if you need a change here.

require('dotenv').config();
const express = require('express');
const path = require('path');

const { describeImage } = require('./routes/describe');
const { recommend, listBouquets } = require('./routes/recommend');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

// Serve static files (HTML, CSS, client-side JS, images)
app.use(express.static(path.join(__dirname)));

// CORS middleware for API routes
app.use('/api/*', (req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  next();
});

app.post('/api/describe-image', describeImage);
app.post('/api/recommend', recommend);
app.get('/api/bouquets', listBouquets);

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
