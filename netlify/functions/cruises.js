'use strict';

/**
 * Netlify Function — Cruise Results Endpoint
 *
 * Returns the current scraping status stored in Netlify Blobs by the
 * `scrape-background` background function.
 *
 * Possible response shapes:
 *   { status: 'idle' }                          – no scrape has been triggered yet
 *   { status: 'running', startedAt: '...' }     – scrape is in progress
 *   { status: 'ready', cruises: [...], ... }    – results are available
 *   { status: 'error', error: '...' }           – scrape failed
 */

const { getStore } = require('@netlify/blobs');

exports.handler = async () => {
  try {
    const store = getStore('cruises');
    const data = await store.get('status', { type: 'json' });

    if (!data) {
      return {
        statusCode: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'idle' }),
      };
    }

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    };
  } catch (err) {
    console.error('cruises function error:', err.message);
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'error', error: err.message }),
    };
  }
};
