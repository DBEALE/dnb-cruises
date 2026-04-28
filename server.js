'use strict';

/**
 * Local development server.
 *
 * Start : node server.js
 * Endpoints:
 *   GET /            – serves public/index.html
 *   GET /api/cruises – fetches live data from all active providers
 */

const express   = require('express');
const path      = require('path');
const providers = require('./providers');

const app  = express();
const PORT = process.env.PORT || 3000;

app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/cruises', async (req, res) => {
  try {
    const allCruises = [];
    for (const provider of providers) {
      console.log(`Fetching from ${provider.name}…`);
      try {
        const cruises = await provider.fetchCruises();
        console.log(`  ✓ ${cruises.length} cruises from ${provider.name}`);
        allCruises.push(...cruises);
      } catch (err) {
        console.error(`  ✗ ${provider.name} failed: ${err.message}`);
      }
    }
    console.log(`✓ Total: ${allCruises.length} cruises`);
    res.json({
      success:   true,
      count:     allCruises.length,
      cruises:   allCruises,
      scrapedAt: new Date().toISOString(),
    });
  } catch (err) {
    console.error('Error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`\n🚢  Cruise viewer running at http://localhost:${PORT}\n`);
  });
}

module.exports = app;
