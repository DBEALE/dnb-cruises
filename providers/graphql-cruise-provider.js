'use strict';

const { randomUUID } = require('node:crypto');

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

class GraphQLCruiseProvider {
  constructor({
    name,
    id,
    graphUrl,
    pageSize,
    operationName,
    query,
    requestHeaders,
    requestTimeoutLabel,
    progressPrefix,
    dedupeById = true,
    requestDelayMs = 100,
  }) {
    this.name = name;
    this.id = id;
    this.graphUrl = graphUrl;
    this.pageSize = pageSize;
    this.operationName = operationName;
    this.query = query;
    this.requestHeaders = requestHeaders || {};
    this.requestTimeoutLabel = requestTimeoutLabel || name;
    this.progressPrefix = progressPrefix || name;
    this.dedupeById = dedupeById;
    this.requestDelayMs = requestDelayMs;
  }

  buildRequestBody(skip) {
    return {
      operationName: this.operationName,
      variables: this.buildRequestVariables(skip),
      query: this.query,
    };
  }

  buildRequestVariables(skip) {
    return {
      pagination: { count: this.pageSize, skip },
    };
  }

  buildRequestHeaders() {
    return {
      'content-type': 'application/json',
      accept: 'application/json',
      'accept-language': 'en-GB,en;q=0.9',
      'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      origin: this.origin,
      referer: this.referer,
      'x-session-id': randomUUID(),
      ...this.requestHeaders,
    };
  }

  // Subclasses may override if their GraphQL shape differs from the default.
  get origin() {
    return '';
  }

  // Subclasses may override if their GraphQL shape differs from the default.
  get referer() {
    return '';
  }

  // Subclasses must override.
  normalizeCruise() {
    throw new Error('normalizeCruise() must be implemented by subclasses');
  }

  async fetchPage({ pagination }, attempt = 1) {
    const response = await fetch(this.graphUrl, {
      method: 'POST',
      headers: this.buildRequestHeaders(),
      body: JSON.stringify(this.buildRequestBody(pagination.skip)),
    });

    if (!response.ok) {
      if (attempt < 4) {
        const delay = attempt * 3000;
        console.log(`  ${this.progressPrefix} HTTP ${response.status} — retrying in ${delay / 1000}s (attempt ${attempt}/3)…`);
        await sleep(delay);
        return this.fetchPage({ pagination }, attempt + 1);
      }
      throw new Error(`${this.requestTimeoutLabel} API returned HTTP ${response.status} after 3 retries`);
    }

    const payload = await response.json();
    const results = payload?.data?.cruiseSearch?.results;
    if (!results) {
      throw new Error(payload?.errors?.[0]?.message || `No results in ${this.requestTimeoutLabel} API response`);
    }

    return results;
  }

  async fetchCruises() {
    const cruises = [];
    const seenIds = new Set();
    let skip = 0;
    let total = null;

    while (total === null || skip < total) {
      const count = total == null ? this.pageSize : Math.min(this.pageSize, total - skip);
      const results = await this.fetchPage({ pagination: { count, skip } });

      total = Number.isFinite(results.total) ? results.total : total;
      const pageCruises = Array.isArray(results.cruises) ? results.cruises : [];
      if (pageCruises.length === 0) break;

      for (const cruise of pageCruises) {
        const normalized = this.normalizeCruise(cruise);
        if (!normalized?.id || !normalized.shipName) continue;
        if (this.dedupeById) {
          if (seenIds.has(normalized.id)) continue;
          seenIds.add(normalized.id);
        }
        cruises.push(normalized);
      }

      skip += pageCruises.length;
      console.log(`  ${this.progressPrefix} ${cruises.length} / ${total}`);
      if (total === null && pageCruises.length < this.pageSize) break;
      await sleep(this.requestDelayMs);
    }

    return cruises;
  }
}

module.exports = GraphQLCruiseProvider;