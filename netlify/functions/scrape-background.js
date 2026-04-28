'use strict';

/**
 * Netlify Background Function — Cruise Scraper
 *
 * Returns HTTP 202 immediately, then fetches from all active providers
 * and stores combined results in Netlify Blobs for the cruises.js endpoint to serve.
 */

const { connectLambda, getStore } = require('@netlify/blobs');
const providers = require('../../providers');

exports.handler = async (event) => {
  if (event?.blobs) connectLambda(event);

  let store;
  try {
    store = getStore('cruises');
    await store.setJSON('status', { status: 'running', startedAt: new Date().toISOString() });

    const allCruises = [];
    for (const provider of providers) {
      console.log(`Fetching from ${provider.name}…`);
      try {
        const cruises = await provider.fetchCruises();
        console.log(`  ✓ ${cruises.length} from ${provider.name}`);
        allCruises.push(...cruises);
      } catch (err) {
        console.error(`  ✗ ${provider.name} failed: ${err.message}`);
      }
    }

    await store.setJSON('status', {
      status:    'ready',
      success:   true,
      count:     allCruises.length,
      cruises:   allCruises,
      scrapedAt: new Date().toISOString(),
    });

    console.log(`Stored ${allCruises.length} cruises.`);
  } catch (err) {
    console.error('Background scrape error:', err.message);
    if (store) {
      await store.setJSON('status', { status: 'error', success: false, error: err.message }).catch(() => {});
    }
  }
};
