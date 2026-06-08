  // ── State ──────────────────────────────────────────────────────────────────
  let allCruises   = [];
  let cruiseById   = new Map();   // id → cruise, for O(1) lookups from the sparkline observer
  let stickySummaryObserver = null;
  const SAVED_VIEWS_KEY = 'cruise-explorer-saved-views';

  // Region groupings used by the departureRegion filter. Picking
  // `group:europe` matches cruises departing from any of these atomic
  // regions; same pattern as the ship-size tier filter.
  const REGION_GROUP_MEMBERS = {
    'europe':       ['UK & Ireland', 'Northern Europe', 'Mediterranean'],
    'americas':     ['Americas', 'South America', 'Caribbean'],
    'asia-pacific': ['Asia & Far East', 'Australia & Pacific'],
  };

  // Display-options state (toggles persisted to localStorage). Declared up
  // here so the init IIFE can call loadSettings() without TDZ errors.
  const SETTINGS_KEY = 'cruise-explorer-settings';
  // First-time visitors see a cleaner table: sparklines + £/night column
  // start off; everything else stays on. Existing users keep whatever they
  // had — loadSettings() merges stored values on top of these defaults, so
  // someone who explicitly turned a setting on (and saved) won't get it
  // flipped back by this change.
  const SETTINGS_DEFAULTS = {
    sparklines: false,
    perNight:   false,
    wikiLinks:  true,
    classDots:  true,
    launchYear: true,
    shipIcons:  true,
  };
  let settings = { ...SETTINGS_DEFAULTS };
  let loadedProviders = [];
  let loadedProviderCounts = new Map();
  let loadedProviderScrapedAts = new Map();
  let sortColIndex = -1;
  let sortAsc      = true;
  let usdToGbp     = null;
  let showInGbp    = true;
  // First-paint cap on rendered rows. Rendering 3000+ at once costs ~2s and
  // every filter change triggers a full re-render; capping to a couple
  // hundred keeps the page interactive. Opt out with "Show all".
  const ROW_CAP    = 300;
  let showAll      = false;
  let shipWikiLinks     = {};
  let providerWikiLinks = {};
  let classWikiLinks    = {};
  const DEFAULT_PROVIDER = {
    id:        'royal-caribbean',
    name:      'Royal Caribbean',
    cruisesUrl:'./providers/royal-caribbean/cruises.json',
  };
  const PROVIDER_INDEX_URL = './providers/index.json';
  const LEGACY_CACHE_KEY = 'cached_cruises';

  // ── Ship class score ───────────────────────────────────────────────────────
  const CLASS_TIER   = { Icon: 5, Oasis: 4, Quantum: 4, Freedom: 3, Radiance: 2, Voyager: 2, Vision: 1, Edge: 4, Solstice: 3, Millennium: 2, Galapagos: 1, Prima: 4, 'Breakaway Plus': 4, Breakaway: 3, Epic: 3, Dawn: 2, Jewel: 2, Spirit: 2, America: 2, Sun: 1 };
  const TIER_COLOUR  = { 5: 'new', 4: 'new', 3: 'mid', 2: 'old', 1: 'old' };
  // Plain-language label per tier. Used in tooltips and the settings legend.
  const TIER_LABEL   = {
    5: 'Newest flagship',
    4: 'Modern flagship',
    3: 'Recent generation',
    2: 'Older generation',
    1: 'Legacy class',
  };

  function classDots(shipClass) {
    const tier = CLASS_TIER[shipClass];
    if (!tier) return '';
    const colour = TIER_COLOUR[tier];
    const dots = Array.from({ length: 5 }, (_, i) =>
      `<span class="${i < tier ? 'filled ' + colour : ''}"></span>`
    ).join('');
    const tip = `${shipClass} class — ${TIER_LABEL[tier]} (${tier}/5)`;
    return `<span class="class-dots" title="${escHtml(tip)}">${dots}</span>`;
  }

  function normalizeProvider(provider) {
    const id = provider?.id || DEFAULT_PROVIDER.id;
    return {
      id,
      name: provider?.name || id,
      cruisesUrl: provider?.cruisesUrl || provider?.cruisesPath || `./providers/${id}/cruises.json`,
    };
  }

  function populateDropdownFilters(cruises) {
    const config = {
      shipName: 'All ships',
      provider: 'All cruise lines',
    };

    for (const [field, label] of Object.entries(config)) {
      const values = Array.from(new Set((cruises || [])
        .map(cruise => String(cruise?.[field] || '').trim())
        .filter(Boolean)))
        .sort((left, right) => left.localeCompare(right, 'en', { numeric: true, sensitivity: 'base' }));

      const selects = document.querySelectorAll(`.col-filter[data-field="${field}"], .mob-filter[data-field="${field}"]`);
      const currentValue = Array.from(selects).find(select => select.value)?.value || '';

      selects.forEach(select => {
        select.innerHTML = `<option value="">${escHtml(label)}</option>` + values
          .map(value => `<option value="${escHtml(value)}">${escHtml(value)}</option>`)
          .join('');
        select.value = currentValue && values.includes(currentValue) ? currentValue : '';
      });
    }

    populateClassFilter(cruises);
  }

  // The Class dropdown gets two sections: ship-size tiers at the top
  // (Mega/Large/Medium/Small, value prefixed `tier:`), then every individual
  // class found in the data. applyFilters distinguishes by the prefix.
  function populateClassFilter(cruises) {
    const classes = Array.from(new Set((cruises || [])
      .map(c => String(c?.shipClass || '').trim()).filter(Boolean)))
      .sort((a, b) => a.localeCompare(b, 'en', { sensitivity: 'base' }));

    const TIER_OPTIONS = [
      ['mega',   'Mega (5,500+ pax)'],
      ['large',  'Large (3,000–5,500)'],
      ['medium', 'Medium (2,000–3,000)'],
      ['small',  'Small (≤2,000)'],
    ];
    const tierHtml = TIER_OPTIONS
      .map(([t, label]) => `<option value="tier:${t}">${escHtml(label)}</option>`)
      .join('');
    const classHtml = classes
      .map(c => `<option value="${escHtml(c)}">${escHtml(c)}</option>`)
      .join('');
    const html =
      `<option value="">All classes</option>` +
      `<optgroup label="By size">${tierHtml}</optgroup>` +
      `<optgroup label="By class">${classHtml}</optgroup>`;

    const selects = document.querySelectorAll(
      '.col-filter[data-field="shipClass"], .mob-filter[data-field="shipClass"]'
    );
    const currentValue = Array.from(selects).find(s => s.value)?.value || '';
    const stillValid = !currentValue ||
      currentValue.startsWith('tier:') ||
      classes.includes(currentValue);

    selects.forEach(s => {
      s.innerHTML = html;
      s.value = stillValid ? currentValue : '';
    });
  }

  function resolveStaticUrl(resourcePath) {
    if (/^https?:\/\//i.test(resourcePath)) return resourcePath;
    if (window.location.protocol !== 'file:') return resourcePath;
    const normalized = resourcePath.replace(/^\.\//, '').replace(/^\//, '');
    return `http://localhost:3000/${normalized}`;
  }

  function fetchStaticJson(resourcePath) {
    return fetch(resolveStaticUrl(resourcePath), { cache: 'no-store' });
  }

  async function loadProviderCatalog() {
    try {
      const res = await fetchStaticJson(PROVIDER_INDEX_URL);
      if (!res.ok) throw new Error('not-found');
      const manifest = await res.json();
      const providers = Array.isArray(manifest.providers) ? manifest.providers.map(normalizeProvider).filter(provider => provider.id) : [];
      if (!providers.length) throw new Error('empty');
      const defaultProviderId = manifest.defaultProviderId && providers.some(provider => provider.id === manifest.defaultProviderId)
        ? manifest.defaultProviderId
        : providers[0].id;
      return { providers, defaultProviderId };
    } catch {
      return {
        providers: [{ ...DEFAULT_PROVIDER }],
        defaultProviderId: DEFAULT_PROVIDER.id,
      };
    }
  }

  function getProviderCacheKey(providerId) {
    return `${LEGACY_CACHE_KEY}:${providerId}`;
  }

  function readCachedPayload(key) {
    try {
      const raw = localStorage.getItem(key);
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      return parsed && Array.isArray(parsed.cruises) ? parsed : null;
    } catch {
      return null;
    }
  }

  function loadCachedCruises(providerIds) {
    const ids = Array.isArray(providerIds) ? providerIds : [providerIds].filter(Boolean);
    const combined = [];
    const counts = new Map();
    const scrapedAts = new Map();
    let latestScrapedAt = null;
    let found = false;

    for (const providerId of ids) {
      const cached = readCachedPayload(getProviderCacheKey(providerId));
      if (!cached) continue;
      found = true;
      combined.push(...cached.cruises);
      counts.set(providerId, (counts.get(providerId) || 0) + cached.cruises.length);
      if (cached.scrapedAt) scrapedAts.set(providerId, cached.scrapedAt);
      if (cached.scrapedAt && (!latestScrapedAt || cached.scrapedAt > latestScrapedAt)) latestScrapedAt = cached.scrapedAt;
    }

    if (found) return { cruises: combined, scrapedAt: latestScrapedAt, counts, scrapedAts };
    const legacy = readCachedPayload(LEGACY_CACHE_KEY);
    return legacy ? { cruises: legacy.cruises, scrapedAt: legacy.scrapedAt, counts: new Map(), scrapedAts: new Map() } : null;
  }

  function saveCachedCruises(providerId, cruises, scrapedAt) {
    try {
      localStorage.setItem(getProviderCacheKey(providerId), JSON.stringify({ cruises, scrapedAt }));
    } catch {}
  }

  function saveLegacyCachedCruises(cruises, scrapedAt) {
    try {
      localStorage.setItem(LEGACY_CACHE_KEY, JSON.stringify({ cruises, scrapedAt }));
    } catch {}
  }

  // ── Init ───────────────────────────────────────────────────────────────────
  (function init() {
    showStatus('Loading cruise data…');
    loadData();
    fetchGBPRate();
    fetchShipWikiLinks();
    loadSettings();
    wireSettingsHandlers();
    wireMobileFilterSheet();
    wireSavedViewsHandlers();
    refreshMobileSavedSelect();
    wirePriceHistoryHandlers();
    wireStickySummary();

    fetch(resolveStaticUrl('./build-info.json'), { cache: 'no-store' })
      .then(r => r.ok ? r.json() : null)
      .then(info => {
        if (!info?.builtAt) return;
        const fmt = new Date(info.builtAt).toLocaleString('en-GB', {
          day: 'numeric', month: 'short', year: 'numeric',
          hour: '2-digit', minute: '2-digit', timeZone: 'UTC', timeZoneName: 'short',
        });
        document.getElementById('buildInfo').textContent = 'Site built: ' + fmt;
      })
      .catch(() => {});
  })();

  async function loadData() {
    const { providers } = await loadProviderCatalog();
    loadedProviders = providers;

    // Show cached data immediately while fetching fresh
    const cached = loadCachedCruises(providers.map(provider => provider.id));
    if (cached) {
      loadedProviderCounts = cached.counts || new Map();
      loadedProviderScrapedAts = cached.scrapedAts || new Map();
      applyCruiseResults(cached.cruises, cached.scrapedAt);
    }

    try {
      // Try pre-built provider JSON files (GitHub Pages / static hosting)
      const providerResults = await Promise.all(providers.map(async (provider) => {
        const res = await fetchStaticJson(provider.cruisesUrl);
        if (!res.ok) throw new Error(`not-found:${provider.id}`);
        const json = await res.json();
        if (!Array.isArray(json.cruises) || !json.cruises.length) throw new Error(`empty:${provider.id}`);
        return { provider, json };
      }));

      const allCruises = [];
      let latestScrapedAt = null;
      const providerCounts = new Map();
      const providerScrapedAts = new Map();
      for (const { provider, json } of providerResults) {
        saveCachedCruises(provider.id, json.cruises, json.scrapedAt);
        allCruises.push(...json.cruises);
        providerCounts.set(provider.id, json.cruises.length);
        if (json.scrapedAt) providerScrapedAts.set(provider.id, json.scrapedAt);
        if (json.scrapedAt && (!latestScrapedAt || json.scrapedAt > latestScrapedAt)) latestScrapedAt = json.scrapedAt;
      }
      loadedProviderCounts = providerCounts;
      loadedProviderScrapedAts = providerScrapedAts;
      saveLegacyCachedCruises(allCruises, latestScrapedAt);
      applyCruiseResults(allCruises, latestScrapedAt);
      hideStatus();
    } catch {
      if (!cached) showStatus('Could not load cruise data: unable to load the static cruise files.', true);
      else hideStatus();
    }
  }

  async function fetchShipWikiLinks() {
    try {
      const res = await fetch(resolveStaticUrl('./ship-wiki-links.json'), { cache: 'no-store' });
      if (!res.ok) return;
      const data = await res.json();
      shipWikiLinks     = data?.ships     || {};
      providerWikiLinks = data?.providers || {};
      classWikiLinks    = data?.classes   || {};
      if (allCruises.length) applyFilters();
    } catch {}
  }

  function lookupWikiUrl(table, value) {
    if (!value) return null;
    return table[value.trim().toLowerCase()] || null;
  }
  const shipWikiUrl     = name => lookupWikiUrl(shipWikiLinks,     name);
  const providerWikiUrl = name => lookupWikiUrl(providerWikiLinks, name);
  const classWikiUrl    = name => lookupWikiUrl(classWikiLinks,    name);

  function wikiLink(value, url, fallback = '—') {
    const text = escHtml(value || fallback);
    if (!url) return text;
    return `<a class="wiki-link" href="${escHtml(url)}" target="_blank" rel="noopener noreferrer" title="View on Wikipedia">${text}</a>`;
  }

  async function fetchGBPRate() {
    try {
      const res  = await fetch('https://open.er-api.com/v6/latest/USD');
      const data = await res.json();
      usdToGbp = data?.rates?.GBP;
      if (!usdToGbp) throw new Error();
      document.getElementById('rateNote').textContent = `1 USD = £${usdToGbp.toFixed(4)}`;
    } catch {
      usdToGbp = 0.79;
      document.getElementById('rateNote').textContent = '1 USD = £0.7900 (est.)';
    }
    if (allCruises.length) applyFilters();
  }

  // ── Status helpers ─────────────────────────────────────────────────────────
  function showStatus(msg, isError = false) {
    const bar = document.getElementById('statusBar');
    document.getElementById('statusText').textContent = msg;
    bar.className = 'visible' + (isError ? ' error' : '');
    bar.querySelector('.spinner').style.display = isError ? 'none' : '';
  }

  function hideStatus() {
    document.getElementById('statusBar').className = '';
  }

  // ── Apply results ──────────────────────────────────────────────────────────
  function applyCruiseResults(cruises, scrapedAt) {
    allCruises = cruises || [];
    cruiseById = new Map(allCruises.map(c => [c.id, c]));

    populateDropdownFilters(allCruises);

    // Header stats
    document.getElementById('totalCount').textContent = allCruises.length.toLocaleString();
    const ships = new Set(allCruises.map(c => c.shipName).filter(Boolean));
    document.getElementById('totalShips').textContent = ships.size;
    const providers = new Set(allCruises.map(c => c.provider).filter(Boolean));
    document.getElementById('totalProviders').textContent = providers.size.toLocaleString();
    if (scrapedAt) {
      document.getElementById('updatedAt').textContent = formatProviderUpdatedAt(scrapedAt).replace(/^Updated:\s*/, '');
    }

    // Apply any sort / filter state from the URL hash before the first render
    // so refreshes and shared links land on the same view.
    applyUrlState();
    applyFilters();
  }

  function formatProviderUpdatedAt(scrapedAt) {
    const d = new Date(scrapedAt);
    if (Number.isNaN(d.getTime())) return 'Updated: —';
    return 'Updated: ' + d.toLocaleString('en-GB', {
      day: 'numeric',
      month: 'short',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      timeZone: 'UTC',
      timeZoneName: 'short',
    });
  }

  // Ship-class → silhouette tier (drives CSS .tier-mega/large/medium/small).
  // Tiers chosen by typical passenger capacity per class.
  const SHIP_TIER_BY_CLASS = {
    // Mega — 5,500+ pax
    'Icon':           'mega',
    'Oasis':          'mega',
    // Large — 3,000–5,500 pax
    'Quantum':        'large',
    'Voyager':        'large',
    'Freedom':        'large',
    'Edge':           'large',
    'Breakaway':      'large',
    'Breakaway Plus': 'large',
    'Prima':          'large',
    'Royal':          'large',
    'Grand':          'large',
    // Medium — 2,000–3,000 pax
    'Radiance':       'medium',
    'Vision':         'medium',
    'Millennium':     'medium',
    'Solstice':       'medium',
    'Jewel':          'medium',
    'Dawn':           'medium',
    'Sun':            'medium',
    'Epic':           'medium',
    'Coral':          'medium',
    // Small — ≤2,000 pax
    'Spirit':         'small',
    'America':        'small',
    'Galapagos':      'small',
  };
  function shipIconTier(c) {
    return SHIP_TIER_BY_CLASS[c.shipClass] || 'medium';
  }

  function mobileShipHeader(c) {
    const yearHtml = c.shipLaunchYear
      ? `<span class="mobile-launch-year">${c.shipLaunchYear}</span>`
      : '';
    const tier = shipIconTier(c);
    // Empty span — CSS mask-image + background-color paints the silhouette
    // in the row's --brand colour (red / teal / blue / navy).
    const iconHtml = `<span class="ship-icon-wrap tier-${tier}" aria-hidden="true"></span>`;
    const nameHtml = wikiLink(c.shipName, shipWikiUrl(c.shipName));
    return `<span class="mobile-ship-header"><span>${iconHtml}${nameHtml}</span>${yearHtml}</span>`;
  }

  function mobileShipDetails(c) {
    const classHtml = c.shipClass
      ? `<span class="mobile-class"><span class="class-cell">${wikiLink(c.shipClass, classWikiUrl(c.shipClass))}${classDots(c.shipClass)}</span></span>`
      : '';
    const providerHtml = wikiLink(c.provider, providerWikiUrl(c.provider));
    return `<span class="mobile-ship-details"><span class="mobile-provider">${providerHtml}</span>${classHtml}</span>`;
  }

  // ── Render ─────────────────────────────────────────────────────────────────
  function buildPriceCell(c, url) {
    const roomTypes = [
      { key: 'inside',   label: 'Inside'  },
      { key: 'oceanView',label: 'Sea'     },
      { key: 'balcony',  label: 'Balcony' },
      { key: 'suite',    label: 'Suite'   },
    ];
    const prices = c.prices || {};
    const hasMulti = roomTypes.some(rt => prices[rt.key] != null);

    if (hasMulti) {
      // Each cabin = its price row (clickable to book) plus a thin
      // sparkline of that specific cabin's history beneath it.
      const blocks = roomTypes
        .filter(rt => prices[rt.key] != null)
        .map(rt => {
          const formatted = formatPriceDisplay(prices[rt.key], c.currency);
          const row = `<div class="price-row"><span class="price-lbl">${escHtml(rt.label)}</span><span class="price-val">${escHtml(formatted)}</span></div>`;
          const linkedRow = url
            ? `<a class="cabin-price-link" href="${url}" target="_blank" rel="noopener noreferrer" title="Book this cruise">${row}</a>`
            : row;
          const spark = cabinSparklineButton(c, rt.key);
          return `<div class="cabin-block">${linkedRow}${spark}</div>`;
        })
        .join('');
      return `<div class="price-cell-content"><div class="prices-grid">${blocks}</div></div>`;
    }

    // Single-price fallback: keep the original "lowest cabin / biggest fall"
    // sparkline below the price.
    let priceHtml;
    const price = formatPriceDisplay(c.priceFrom, c.currency);
    if (price === '—') {
      priceHtml = '—';
    } else {
      const inner = `<span class="price-val price-from">${escHtml(price)}</span>`;
      priceHtml = url ? `<a href="${url}" target="_blank" rel="noopener noreferrer" title="Book this cruise">${inner}</a>` : inner;
    }
    const sparkHtml = sparklineButton(c);
    return `<div class="price-cell-content">${priceHtml}${sparkHtml}</div>`;
  }

  // Per-cabin sparkline — same shape as sparklineButton but locked to one
  // bucket. Returns '' when that cabin has fewer than 2 observations.
  // Returns the SVG markup for one cabin's history, or null when there
  // aren't enough points. Pure — no DOM/state reads beyond the cruise itself.
  function buildCabinSparkSvg(c, bucket) {
    const history = Array.isArray(c.priceHistory) ? c.priceHistory : [];
    if (history.length < 2) return null;
    const prices = history.map(e => entryPrice(e, bucket)).map(v => Number.isFinite(v) ? v : null);
    const valid  = prices.filter(v => v !== null);
    if (valid.length < 2) return null;

    const w = 60, h = 8, padX = 1, padY = 1;
    const min = Math.min(...valid), max = Math.max(...valid);
    const range = max - min || 1;
    let path = '', inPath = false;
    prices.forEach((p, i) => {
      if (p === null) { inPath = false; return; }
      const x = padX + (i / (history.length - 1)) * (w - 2 * padX);
      const y = (h - padY) - ((p - min) / range) * (h - 2 * padY);
      path += (inPath ? ' L' : ' M') + `${x.toFixed(1)},${y.toFixed(1)}`;
      inPath = true;
    });
    if (!path) return null;
    const first = valid[0], last = valid[valid.length - 1];
    const trend = last < first ? 'spark-down' : (last > first ? 'spark-up' : 'spark-flat');
    return {
      svg: `<svg class="${trend}" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" preserveAspectRatio="none"><path d="${path.trim()}" fill="none" stroke-width="1.2" stroke-linejoin="round" stroke-linecap="round" /></svg>`,
      count: valid.length,
    };
  }

  // Cheap pre-check so we don't render a placeholder for cabins with no story.
  function cabinHasPlottableHistory(c, bucket) {
    const history = Array.isArray(c.priceHistory) ? c.priceHistory : [];
    if (history.length < 2) return false;
    let n = 0;
    for (const e of history) if (Number.isFinite(entryPrice(e, bucket))) n++;
    return n >= 2;
  }

  function cabinSparklineButton(c, bucket) {
    if (!cabinHasPlottableHistory(c, bucket)) return '';
    const label = BUCKET_LABEL[bucket] || bucket;
    // Placeholder — observer populates the SVG when the row scrolls into view.
    return `<button type="button" class="price-spark cabin-spark" data-cruise-id="${escHtml(c.id || '')}" data-spark-bucket="${escHtml(bucket)}" title="${escHtml(label + ' — click for details')}" aria-label="Show ${escHtml(label)} price history"></button>`;
  }

  // Picks the cabin bucket with the most extreme pct change from first to
  // last observation. direction = 'fall' picks most-negative; 'rise' picks
  // most-positive. Returns null when nothing moved in that direction —
  // caller then falls back to the cheapest-cabin trend.
  function extremeChangeBucket(history, direction) {
    let chosen = null, extremePct = 0;
    for (const b of historyBuckets(history)) {
      const first = history.find(e => entryPrice(e, b) != null);
      const last  = [...history].reverse().find(e => entryPrice(e, b) != null);
      if (!first || !last || first === last) continue;
      const f = entryPrice(first, b), l = entryPrice(last, b);
      if (!Number.isFinite(f) || !Number.isFinite(l) || f === 0) continue;
      const pct = ((l - f) / f) * 100;
      const isMore = direction === 'rise' ? pct > extremePct : pct < extremePct;
      if (isMore) { extremePct = pct; chosen = b; }
    }
    return chosen;
  }

  // Renders a small inline-SVG sparkline button. By default plots the cabin
  // that has fallen the most over the cruise's observed history; when the
  // user is explicitly sorted by "Biggest price rise" we flip and plot the
  // biggest-rise cabin instead. Falls back to cheapest-cabin trend when
  // nothing has moved in the relevant direction.
  // SVG for the legacy fallback sparkline (single line, picks the biggest-fall
  // cabin per current sort direction; falls back to lowest-cabin trend).
  function buildSingleSparkSvg(c) {
    const history = Array.isArray(c.priceHistory) ? c.priceHistory : [];
    if (history.length < 2) return null;

    const isRiseSort = sortColIndex === 16 && !sortAsc;
    const direction  = isRiseSort ? 'rise' : 'fall';
    const chosen = extremeChangeBucket(history, direction);
    const getter = chosen ? (e => entryPrice(e, chosen)) : entryMinPrice;
    const label  = chosen ? BUCKET_LABEL[chosen] : 'Lowest cabin';

    const prices = history.map(getter).map(v => Number.isFinite(v) ? v : null);
    const valid  = prices.filter(v => v !== null);
    if (valid.length < 2) return null;

    const w = 60, h = 16, padX = 1, padY = 2;
    const min = Math.min(...valid), max = Math.max(...valid);
    const range = max - min || 1;
    let path = '', inPath = false;
    prices.forEach((p, i) => {
      if (p === null) { inPath = false; return; }
      const x = padX + (i / (history.length - 1)) * (w - 2 * padX);
      const y = (h - padY) - ((p - min) / range) * (h - 2 * padY);
      path += (inPath ? ' L' : ' M') + `${x.toFixed(1)},${y.toFixed(1)}`;
      inPath = true;
    });
    if (!path) return null;
    const first = valid[0], last = valid[valid.length - 1];
    const trend = last < first ? 'spark-down' : (last > first ? 'spark-up' : 'spark-flat');
    return {
      svg: `<svg class="${trend}" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" preserveAspectRatio="none"><path d="${path.trim()}" fill="none" stroke-width="1.5" stroke-linejoin="round" stroke-linecap="round" /></svg>`,
      title: `${label} trend over ${history.length} observations — click for details`,
    };
  }

  function sparklineButton(c) {
    const history = Array.isArray(c.priceHistory) ? c.priceHistory : [];
    if (history.length < 2) return '';
    // Placeholder — observer populates the SVG and the rich title when visible.
    return `<button type="button" class="price-spark" data-cruise-id="${escHtml(c.id || '')}" data-spark-bucket="" title="Click for price history" aria-label="Show price history"></button>`;
  }

  // Lazily fills sparkline placeholders with their SVGs when they enter the
  // viewport. Cuts initial DOM cost by ~3-4× since only the first viewport
  // worth of buttons ever materialises immediately.
  let sparkObserver = null;
  function ensureSparkObserver() {
    if (sparkObserver || typeof IntersectionObserver === 'undefined') return;
    sparkObserver = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        const btn = entry.target;
        sparkObserver.unobserve(btn);
        fillSparkButton(btn);
      }
    }, { rootMargin: '200px 0px' });
  }
  function fillSparkButton(btn) {
    if (btn.dataset.sparkFilled === '1') return;
    const c = cruiseById.get(btn.dataset.cruiseId);
    if (!c) { btn.dataset.sparkFilled = '1'; return; }
    const bucket = btn.dataset.sparkBucket;
    const result = bucket ? buildCabinSparkSvg(c, bucket) : buildSingleSparkSvg(c);
    if (!result) { btn.dataset.sparkFilled = '1'; return; }
    btn.innerHTML = result.svg;
    if (result.title) btn.title = result.title;
    else if (bucket && result.count != null) {
      const label = BUCKET_LABEL[bucket] || bucket;
      btn.title = `${label} — ${result.count} observations, click for details`;
    }
    btn.dataset.sparkFilled = '1';
  }
  function observeNewSparks() {
    if (!sparkObserver) ensureSparkObserver();
    // Fallback: no IntersectionObserver → fill everything synchronously.
    if (!sparkObserver) {
      document.querySelectorAll('.price-spark:not([data-spark-filled])').forEach(fillSparkButton);
      return;
    }
    document.querySelectorAll('.price-spark:not([data-spark-filled])').forEach(btn => sparkObserver.observe(btn));
  }

  // Wraps a departure-region name in a colour-coded pill. The CSS class
  // matches a slugified version of the region so adding a new region just
  // needs a single CSS rule.
  function regionBadge(region) {
    if (!region) return '—';
    const slug = String(region).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
    return `<span class="region-badge region-${escHtml(slug)}">${escHtml(region)}</span>`;
  }

  // Collapse trailing country names when every port in an arrow-separated
  // itinerary shares it. "Sydney, Australia → Brisbane, Australia" becomes
  // "Sydney → Brisbane" — much easier to scan on mobile where lines wrap.
  // Anything without " → " (e.g. RC's "Western Caribbean Getaway: <port>"
  // format) is passed through unchanged.
  function simplifyItinerary(text) {
    if (!text || !text.includes(' → ')) return text || '';
    const ports = text.split(' → ');
    if (ports.length < 2) return text;
    const lastSegment = p => {
      const parts = p.split(', ');
      return parts.length > 1 ? parts[parts.length - 1].trim() : null;
    };
    const tail = lastSegment(ports[0]);
    if (!tail) return text;
    if (!ports.every(p => lastSegment(p) === tail)) return text;
    return ports
      .map(p => p.split(', ').slice(0, -1).join(', ').trim())
      .join(' → ');
  }

  function renderBody(list) {
    const tbody = document.getElementById('cruiseBody');
    if (!list || list.length === 0) {
      tbody.innerHTML = '<tr class="empty-row"><td colspan="14">No cruises match your filters.</td></tr>';
      return;
    }
    tbody.innerHTML = list.map((c, i) => {
      const date     = formatDateDisplay(c.departureDate);
      const duration = formatDurationDisplay(c.duration);
      const url      = c.bookingUrl ? escHtml(absoluteUrl(c.bookingUrl)) : '';
      const bookCell = url
        ? `<a href="${url}" target="_blank" rel="noopener noreferrer">Book<svg class="book-ext" viewBox="0 0 14 14" fill="currentColor" aria-hidden="true"><path d="M8 1h5v5h-2V4.4L5.7 9.7 4.3 8.3 9.6 3H8V1zM2 3h4v2H4v6h6V9h2v4H2V3z"/></svg></a>`
        : '—';
      const priceCell = buildPriceCell(c, url);
      const perNight  = getPricePerNight(c);
      const perNightCell = Number.isFinite(perNight)
        ? `${escHtml(formatPriceDisplay(perNight, c.currency))}<span class="per-night-suffix">/night</span>`
        : '—';

      return `<tr data-provider="${escHtml(c.provider || '')}">
        <td class="col-num" data-label="#">${i + 1}</td>
        <td class="col-ship ship-name" data-label="Ship">${mobileShipHeader(c)}${mobileShipDetails(c)}</td>
        <td class="col-provider" data-label="Cruise line">${wikiLink(c.provider, providerWikiUrl(c.provider))}</td>
        <td class="col-class" data-label="Class"><span class="class-cell">${wikiLink(c.shipClass, classWikiUrl(c.shipClass))}${classDots(c.shipClass)}</span></td>
        <td class="col-launch" data-label="Launch">${c.shipLaunchYear || '—'}</td>
        <td class="col-itinerary" data-label="Itinerary">${escHtml(simplifyItinerary(c.itinerary) || '—')}</td>
        <td class="col-destination" data-label="Destination">${escHtml(c.destination || '—')}</td>
        <td class="col-date" data-label="Departure">${escHtml(date)}</td>
        <td class="col-duration duration" data-label="Nights">${escHtml(duration)}</td>
        <td class="col-port" data-label="Departure port">${escHtml(c.departurePort || '—')}</td>
        <td class="col-region" data-label="Region">${regionBadge(c.departureRegion)}</td>
        <td class="col-price price" data-label="Price">${priceCell}</td>
        <td class="col-per-night per-night" data-label="£/night">${perNightCell}</td>
        <td class="col-book book" data-label="Book">${bookCell}</td>
      </tr>`;
    }).join('');
    observeNewSparks();
  }

  // ── Price-history dialog ───────────────────────────────────────────────────
  function openPriceHistory(cruiseId) {
    const dialog = document.getElementById('priceHistoryDialog');
    const cruise = allCruises.find(c => c.id === cruiseId);
    const history = cruise && Array.isArray(cruise.priceHistory) ? cruise.priceHistory : [];
    if (!cruise || history.length < 2) return;

    document.getElementById('phTitle').textContent = cruise.shipName || 'Price history';
    const subParts = [cruise.itinerary, formatDateDisplay(cruise.departureDate)].filter(Boolean);
    document.getElementById('phSub').textContent = subParts.join(' — ');

    const buckets = historyBuckets(history); // empty → all legacy entries
    document.getElementById('phChart').innerHTML       = renderHistoryChart(history, cruise.currency, buckets);
    document.getElementById('phTableHead').innerHTML   = renderHistoryTableHead(buckets);
    document.getElementById('phTableBody').innerHTML   = renderHistoryTableBody(history, cruise.currency, buckets);

    if (typeof dialog.showModal === 'function') dialog.showModal();
    else dialog.setAttribute('open', '');
  }

  function renderHistoryChart(history, currency, buckets) {
    const w = 460, h = 160, padL = 50, padR = 10, padT = 10, padB = 22;
    const innerW = w - padL - padR;
    const innerH = h - padT - padB;

    // For legacy-only histories, treat the single value as one virtual series.
    const seriesSpec = buckets.length
      ? buckets.map(b => ({ key: b, label: BUCKET_LABEL[b], color: BUCKET_COLOR[b], getValue: e => entryPrice(e, b) }))
      : [{ key: 'legacy', label: 'Price', color: LEGACY_COLOR, getValue: e => entryPrice(e, null) }];

    // Global min/max across every series for a shared Y axis.
    let min = Infinity, max = -Infinity;
    for (const s of seriesSpec) {
      for (const e of history) {
        const v = s.getValue(e);
        if (Number.isFinite(v)) { if (v < min) min = v; if (v > max) max = v; }
      }
    }
    if (!Number.isFinite(min) || !Number.isFinite(max)) return '<div style="color:var(--gray-400);font-size:.85rem">No price data to plot.</div>';
    const range = max - min || 1;

    const paths = seriesSpec.map(s => {
      let d = '', inPath = false;
      history.forEach((e, i) => {
        const v = s.getValue(e);
        if (!Number.isFinite(v)) { inPath = false; return; }
        const x = padL + (i / (history.length - 1)) * innerW;
        const y = padT + innerH - ((v - min) / range) * innerH;
        d += (inPath ? ' L' : ' M') + `${x.toFixed(1)},${y.toFixed(1)}`;
        inPath = true;
      });
      return `<path d="${d.trim()}" fill="none" stroke="${s.color}" stroke-width="1.8" stroke-linejoin="round" stroke-linecap="round" />`;
    }).join('');

    const yLabel = (val) => escHtml(formatPriceDisplay(val, currency));
    const xLabel = (idx) => {
      const d = new Date(history[idx].at);
      if (Number.isNaN(d.getTime())) return '';
      return escHtml(d.toLocaleDateString('en-GB', { day:'numeric', month:'short', timeZone:'UTC' }));
    };

    const legend = seriesSpec.length > 1
      ? `<div class="ph-legend">${seriesSpec.map(s => `<span class="ph-legend-item"><span class="ph-legend-swatch" style="background:${s.color}"></span>${escHtml(s.label)}</span>`).join('')}</div>`
      : '';

    return `${legend}<svg viewBox="0 0 ${w} ${h}" preserveAspectRatio="xMidYMid meet">
      <line class="ph-axis-line" x1="${padL}" y1="${padT}"            x2="${padL}"  y2="${padT + innerH}" />
      <line class="ph-axis-line" x1="${padL}" y1="${padT + innerH}"   x2="${w - padR}" y2="${padT + innerH}" />
      <text class="ph-axis-text" x="${padL - 4}" y="${padT + 4}"          text-anchor="end">${yLabel(max)}</text>
      <text class="ph-axis-text" x="${padL - 4}" y="${padT + innerH}"     text-anchor="end">${yLabel(min)}</text>
      <text class="ph-axis-text" x="${padL}"     y="${h - 6}"             text-anchor="start">${xLabel(0)}</text>
      <text class="ph-axis-text" x="${w - padR}" y="${h - 6}"             text-anchor="end">${xLabel(history.length - 1)}</text>
      ${paths}
    </svg>`;
  }

  function renderHistoryTableHead(buckets) {
    if (!buckets.length) {
      return `<tr><th>When (UTC)</th><th style="text-align:right">Price</th><th style="text-align:right">Change</th></tr>`;
    }
    const cabinHeads = buckets.map(b => `<th style="text-align:right">${escHtml(BUCKET_LABEL[b])}</th>`).join('');
    return `<tr><th>When (UTC)</th>${cabinHeads}</tr>`;
  }

  function renderHistoryTableBody(history, currency, buckets) {
    // Rows are chronological — earliest at the top, latest at the bottom.
    // Delta on each row compares to the immediately-prior observation, so
    // ▲/▼ reads "this scrape was higher/lower than the previous one".
    return history.map((entry, i) => {
      const prev = i > 0 ? history[i - 1] : null;
      const d = new Date(entry.at);
      const when = Number.isNaN(d.getTime()) ? '—' : d.toLocaleString('en-GB', {
        day:'numeric', month:'short', year:'numeric', hour:'2-digit', minute:'2-digit', timeZone:'UTC',
      });

      if (!buckets.length) {
        // Legacy single-value rendering — keep the Change column.
        const cur = entryPrice(entry, null);
        const prv = prev ? entryPrice(prev, null) : null;
        let delta = '—', deltaClass = '';
        if (cur != null && prv != null) {
          const diff = cur - prv;
          if (diff !== 0) {
            delta = (diff > 0 ? '+' : '−') + escHtml(formatPriceDisplay(Math.abs(diff), currency));
            deltaClass = diff > 0 ? 'up' : 'down';
          }
        }
        return `<tr>
          <td>${escHtml(when)}</td>
          <td class="ph-price">${escHtml(formatPriceDisplay(cur, currency))}</td>
          <td class="ph-delta ${deltaClass}">${delta}</td>
        </tr>`;
      }

      const cells = buckets.map(b => {
        const cur = entryPrice(entry, b);
        const prv = prev ? entryPrice(prev, b) : null;
        if (cur == null) return '<td class="ph-price ph-missing">—</td>';
        let arrow = '';
        if (prv != null && cur !== prv) {
          arrow = cur > prv
            ? '<span class="ph-arrow up" aria-hidden="true">▲</span>'
            : '<span class="ph-arrow down" aria-hidden="true">▼</span>';
        }
        return `<td class="ph-price">${escHtml(formatPriceDisplay(cur, currency))}${arrow}</td>`;
      }).join('');

      return `<tr><td>${escHtml(when)}</td>${cells}</tr>`;
    }).join('');
  }

  // ── Display options (settings dialog + localStorage) ─────────────────────
  // SETTINGS_KEY / SETTINGS_DEFAULTS / settings are declared up with the
  // other module-level state so init's loadSettings() doesn't hit the
  // temporal-dead-zone.
  function loadSettings() {
    try {
      const raw = localStorage.getItem(SETTINGS_KEY);
      if (raw) settings = { ...SETTINGS_DEFAULTS, ...JSON.parse(raw) };
    } catch {}
    applySettingsToDom();
  }
  function saveSettings() {
    try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); } catch {}
  }
  // Drive visibility via classes on <body> so toggling is instant — no
  // re-render needed. Sparklines are lazy anyway; placeholder buttons just
  // get display:none when off.
  function applySettingsToDom() {
    document.body.classList.toggle('hide-sparklines', !settings.sparklines);
    document.body.classList.toggle('hide-per-night',  !settings.perNight);
    document.body.classList.toggle('hide-wiki-links', !settings.wikiLinks);
    document.body.classList.toggle('hide-class-dots', !settings.classDots);
    document.body.classList.toggle('hide-launch-year',!settings.launchYear);
    document.body.classList.toggle('hide-ship-icons', !settings.shipIcons);
  }
  // `focusPhone=true` opens the dialog with the phone field highlighted —
  // used when the user taps 🔔 on a saved view but hasn't set a phone yet.
  function openSettings(focusPhone) {
    const dlg = document.getElementById('settingsDialog');
    if (!dlg) return;
    dlg.querySelectorAll('input[data-setting]').forEach(cb => {
      cb.checked = !!settings[cb.dataset.setting];
    });
    const phoneInput = document.getElementById('settingsPhone');
    if (phoneInput) phoneInput.value = rememberedPhone();
    document.getElementById('settingsPhoneStatus').textContent = '';
    if (typeof dlg.showModal === 'function') dlg.showModal();
    else dlg.setAttribute('open', '');
    if (focusPhone && phoneInput) {
      phoneInput.classList.add('flash');
      setTimeout(() => { phoneInput.classList.remove('flash'); phoneInput.focus(); }, 150);
    }
  }
  function wireSettingsHandlers() {
    const dlg = document.getElementById('settingsDialog');
    if (!dlg || dlg.dataset.wired) return;
    dlg.dataset.wired = '1';

    dlg.querySelectorAll('input[data-setting]').forEach(cb => {
      cb.addEventListener('change', () => {
        settings[cb.dataset.setting] = cb.checked;
        applySettingsToDom();
        saveSettings();
      });
    });

    // Phone number — save on every change, lightly validate, show inline status.
    const phoneInput  = document.getElementById('settingsPhone');
    const phoneStatus = document.getElementById('settingsPhoneStatus');
    if (phoneInput && phoneStatus) {
      phoneInput.addEventListener('input', () => {
        const v = phoneInput.value.trim();
        if (!v) {
          rememberPhone('');
          phoneStatus.textContent = 'Cleared';
          phoneStatus.className = 'settings-phone-status muted';
        } else if (/^\+\d{7,15}$/.test(v)) {
          rememberPhone(v);
          phoneStatus.textContent = 'Saved';
          phoneStatus.className = 'settings-phone-status ok';
        } else {
          phoneStatus.textContent = 'Use international format, e.g. +447700900123';
          phoneStatus.className = 'settings-phone-status err';
        }
      });
    }

    document.getElementById('settingsClose').addEventListener('click', () => dlg.close());
    document.getElementById('settingsReset').addEventListener('click', () => {
      settings = { ...SETTINGS_DEFAULTS };
      dlg.querySelectorAll('input[data-setting]').forEach(cb => {
        cb.checked = !!settings[cb.dataset.setting];
      });
      applySettingsToDom();
      saveSettings();
      // Reset does NOT clear the phone number — that's user data, not a
      // display preference. They can clear it themselves by emptying the field.
    });
    dlg.addEventListener('click', ev => { if (ev.target === dlg) dlg.close(); });
  }

  // ── Saved views (localStorage) ────────────────────────────────────────────
  // SAVED_VIEWS_KEY is declared up with the other module-level state so
  // init's refreshMobileSavedSelect() doesn't hit the temporal-dead-zone.

  function loadSavedViews() {
    try {
      const raw = localStorage.getItem(SAVED_VIEWS_KEY);
      const arr = raw ? JSON.parse(raw) : [];
      return Array.isArray(arr) ? arr : [];
    } catch { return []; }
  }
  function persistSavedViews(views) {
    try { localStorage.setItem(SAVED_VIEWS_KEY, JSON.stringify(views)); } catch {}
  }
  function openSavedViews() {
    const dlg = document.getElementById('savedViewsDialog');
    if (!dlg) return;
    renderSavedViewsList();
    setSuggestedSavedViewName();
    setSavedViewStatus('', null);
    if (typeof dlg.showModal === 'function') dlg.showModal();
    else dlg.setAttribute('open', '');
    setTimeout(() => {
      const input = document.getElementById('svNameInput');
      input?.focus();
      input?.select();
    }, 50);
  }
  // Quick-pick dropdown for saved views on mobile (sits where the Sort
  // dropdown used to live). Picking a view applies it; "Manage…" opens
  // the management dialog. Rebuilt whenever views change.
  function refreshMobileSavedSelect() {
    const sel = document.getElementById('mobileSavedSelect');
    if (!sel) return;
    const views = loadSavedViews()
      .slice()
      .sort((a, b) => (b.savedAt || '').localeCompare(a.savedAt || ''));
    const opts = ['<option value="">Saved views…</option>'];
    opts.push('<option value="__save__">＋ Save current view…</option>');
    if (views.length) {
      opts.push('<optgroup label="Your views">');
      for (const v of views) opts.push(`<option value="${escHtml(v.id)}">${escHtml(compactSavedViewMenuName(v.name))}</option>`);
      opts.push('</optgroup>');
      opts.push('<option value="__manage__">Manage saved views…</option>');
    }
    sel.innerHTML = opts.join('');
    sel.value = '';
  }

  function compactSavedViewMenuName(name) {
    const text = String(name || 'Untitled view').replace(/\s+/g, ' ').trim();
    if (text.length <= 32) return text;
    return `${text.slice(0, 29).trim()}...`;
  }

  function mobileSavedSelectChange() {
    const sel = document.getElementById('mobileSavedSelect');
    if (!sel) return;
    const v = sel.value;
    sel.value = '';   // act like a menu — reset to placeholder
    if (!v) return;
    if (v === '__manage__' || v === '__save__') {
      openSavedViews();
      // For "Save current view", focus the name input so the user can type
      // straight away. The dialog is already focused on the name input by
      // default, this is a no-op safety in case that ever changes.
      if (v === '__save__') setTimeout(() => document.getElementById('svNameInput')?.focus(), 80);
    } else {
      applySavedView(v);
    }
  }

  function renderSavedViewsList() {
    const list  = document.getElementById('svList');
    const empty = document.getElementById('svEmpty');
    const views = loadSavedViews();
    if (!views.length) {
      list.innerHTML = '';
      empty.hidden = false;
      return;
    }
    empty.hidden = true;
    list.innerHTML = views
      .slice() // don't mutate
      .sort((a, b) => (b.savedAt || '').localeCompare(a.savedAt || ''))
      .map(v => {
        const notifyOn   = !!v.notify;
        const notifyCls  = notifyOn ? 'sv-notify on' : 'sv-notify';
        const notifyHint = notifyOn
          ? 'Subscribed — reply STOP on WhatsApp to unsubscribe'
          : 'Get a WhatsApp message when new cruises match this view';
        return `<li class="sv-item">
          <button type="button" class="sv-apply" data-id="${escHtml(v.id)}">
            <span class="sv-name">${escHtml(v.name)}</span>
            <span class="sv-hash">${escHtml(humanSummariseHash(v.hash))}</span>
          </button>
          <button type="button" class="${notifyCls}" data-id="${escHtml(v.id)}" aria-label="${escHtml(notifyHint)}" title="${escHtml(notifyHint)}" ${notifyOn ? 'disabled' : ''}>🔔</button>
          <button type="button" class="sv-delete" data-id="${escHtml(v.id)}" aria-label="Delete ${escHtml(v.name)}" title="Delete">×</button>
        </li>`;
      })
      .join('');
  }
  // Human-readable one-liner for a saved view's URL hash, shown beneath the name.
  const SAVED_VIEW_SORT_LABELS = {
    1: 'Ship',
    7: 'Departure',
    8: 'Nights',
    11: 'Price',
    12: 'Price (Inside)',
    13: 'Price (Sea)',
    14: 'Price (Balcony)',
    15: 'Price (Suite)',
    16: 'Price change',
    17: 'GBP/night',
  };

  function humanSummariseHash(hash) {
    if (!hash) return 'No filters';
    const p = new URLSearchParams(hash);
    const parts = [];
    const sort = p.get('sort');
    if (sort) {
      const [col, dir] = sort.split('-');
      parts.push(`Sort: ${SAVED_VIEW_SORT_LABELS[col] || ('col '+col)} ${dir === 'asc' ? '↑' : '↓'}`);
    }
    for (const [k, v] of p) {
      if (k === 'sort' || k === 'all' || k === 'gbp') continue;
      parts.push(`${k}=${v}`);
    }
    return parts.length ? parts.join(' · ') : 'No filters';
  }

  function savedViewFilterLabel(key, value) {
    const v = String(value || '').trim();
    if (!v) return '';
    if (key === 'provider') return v;
    if (key === 'shipName') return v;
    if (key === 'shipClass') {
      if (v.startsWith('tier:')) {
        const tier = v.slice(5);
        return tier ? `${tier[0].toUpperCase()}${tier.slice(1)} ships` : '';
      }
      return `${v} class`;
    }
    if (key === 'departureRegion') return v;
    if (key === 'departurePort') return `From ${v}`;
    if (key === 'destination') return v;
    if (key === 'itinerary') return v;
    if (key === 'departureDate') return v;
    if (key === 'minLaunch') return `Ships ${v}+`;
    if (key === 'duration') return `${v}+ nights`;
    if (key === 'maxPrice') return `Under GBP ${Number(v).toLocaleString('en-GB')}`;
    return v;
  }

  function buildSuggestedSavedViewName(hash) {
    const p = new URLSearchParams(hash || '');
    const preferredFields = [
      'provider',
      'shipName',
      'shipClass',
      'destination',
      'departureRegion',
      'departurePort',
      'itinerary',
      'departureDate',
      'duration',
      'maxPrice',
      'minLaunch',
    ];
    const parts = preferredFields
      .map(field => savedViewFilterLabel(field, p.get(field)))
      .filter(Boolean)
      .slice(0, 3);

    const sort = p.get('sort');
    if (sort) {
      const [col, dir] = sort.split('-');
      const label = SAVED_VIEW_SORT_LABELS[col] || `Column ${col}`;
      parts.push(`${label} ${dir === 'asc' ? 'low-high' : 'high-low'}`);
    }

    const name = parts.length ? parts.join(' · ') : 'All sailings';
    return name.length > 60 ? `${name.slice(0, 57).trim()}...` : name;
  }

  function setSuggestedSavedViewName() {
    const input = document.getElementById('svNameInput');
    if (!input) return;
    input.value = buildSuggestedSavedViewName(serializeUrlState());
  }

  function saveCurrentView(name) {
    const trimmed = String(name || '').trim();
    if (!trimmed) return;
    const hash = serializeUrlState(); // existing helper
    const views = loadSavedViews();
    views.push({
      id:      `v_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
      name:    trimmed,
      hash,
      savedAt: new Date().toISOString(),
    });
    persistSavedViews(views);
    renderSavedViewsList();
    refreshMobileSavedSelect();
    setSuggestedSavedViewName();
  }
  function applySavedView(id) {
    const view = loadSavedViews().find(v => v.id === id);
    if (!view) return;
    // Reset state, write the saved hash, re-apply.
    document.querySelectorAll('.col-filter, .mob-filter').forEach(el => { el.value = ''; });
    sortColIndex = -1; sortAsc = true; showAll = false;
    try {
      history.replaceState(null, '',
        window.location.pathname + window.location.search +
        (view.hash ? '#' + view.hash : ''));
    } catch {}
    applyUrlState();
    applyFilters();
    document.getElementById('savedViewsDialog')?.close();
  }
  function deleteSavedView(id) {
    persistSavedViews(loadSavedViews().filter(v => v.id !== id));
    renderSavedViewsList();
  }

  // One-tap subscribe from a saved view. The phone number lives in Settings
  // → reuse it silently. Without a phone, bounce the user to Settings with
  // the phone field highlighted.
  async function openNotifyForView(viewId) {
    const view  = loadSavedViews().find(v => v.id === viewId);
    if (!view) return;
    const phone = rememberedPhone();
    if (!phone) {
      // Close saved-views, open Settings with the phone field flashed.
      document.getElementById('savedViewsDialog')?.close();
      openSettings(true);
      setSavedViewStatus('Add your WhatsApp number in Settings, then tap 🔔 again.', 'err');
      return;
    }
    await subscribeSavedView(view, phone);
  }

  async function subscribeSavedView(view, phone) {
    setSavedViewStatus(`Subscribing for "${view.name}"…`, 'pending');
    try {
      const res = await fetch(SUBSCRIBE_URL, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          whatsappNumber: phone,
          criteria:       criteriaFromHash(view.hash),
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Subscription failed');
      markViewNotifyEnabled(view.id);
      setSavedViewStatus(`Subscribed! You'll get WhatsApp alerts for "${view.name}". Reply STOP to unsubscribe.`, 'ok');
    } catch (err) {
      setSavedViewStatus(err.message || 'Subscription failed', 'err');
    }
  }

  function setSavedViewStatus(text, kind) {
    const el = document.getElementById('svStatus');
    if (!el) return;
    if (!text) { el.hidden = true; el.textContent = ''; return; }
    el.hidden = false;
    el.textContent = text;
    el.className = 'sv-status ' + (kind || '');
  }
  function markViewNotifyEnabled(viewId) {
    const views = loadSavedViews();
    const v = views.find(x => x.id === viewId);
    if (!v) return;
    v.notify = true;
    v.notifySubscribedAt = new Date().toISOString();
    persistSavedViews(views);
    renderSavedViewsList();
    refreshMobileSavedSelect();
  }
  // Parse a saved view's URL hash back into the same criteria shape the
  // subscribe API expects (matches what getCurrentCriteria emits live).
  function criteriaFromHash(hash) {
    const c = {};
    if (!hash) return c;
    const p = new URLSearchParams(hash);
    const FIELDS = ['shipName','provider','shipClass','itinerary','destination',
                    'departureDate','duration','departurePort','departureRegion'];
    const NUMERIC = ['minLaunch','duration','maxPrice'];
    for (const f of FIELDS) {
      const v = p.get(f);
      if (v) c[f] = v;
    }
    for (const f of NUMERIC) {
      const v = p.get(f);
      if (v != null && v !== '') {
        const n = parseFloat(v);
        if (!Number.isNaN(n)) c[f] = n;
      }
    }
    return c;
  }

  // Phone number remembered across saved-view subscribes.
  const PHONE_KEY = 'cruise-explorer-phone';
  function rememberedPhone() {
    try { return localStorage.getItem(PHONE_KEY) || ''; } catch { return ''; }
  }
  function rememberPhone(phone) {
    try { localStorage.setItem(PHONE_KEY, phone); } catch {}
  }
  function wireSavedViewsHandlers() {
    const dlg = document.getElementById('savedViewsDialog');
    if (!dlg || dlg.dataset.wired) return;
    dlg.dataset.wired = '1';
    document.getElementById('svClose')?.addEventListener('click', () => dlg.close());
    document.getElementById('svSaveForm')?.addEventListener('submit', ev => {
      ev.preventDefault();
      saveCurrentView(document.getElementById('svNameInput').value);
      document.getElementById('svNameInput')?.select();
    });
    document.getElementById('svList')?.addEventListener('click', ev => {
      const apply  = ev.target.closest('.sv-apply');
      const del    = ev.target.closest('.sv-delete');
      const notify = ev.target.closest('.sv-notify');
      if (apply) applySavedView(apply.dataset.id);
      else if (del) deleteSavedView(del.dataset.id);
      else if (notify && !notify.disabled) openNotifyForView(notify.dataset.id);
    });
    dlg.addEventListener('click', ev => { if (ev.target === dlg) dlg.close(); });
  }

  function wirePriceHistoryHandlers() {
    const tbody = document.getElementById('cruiseBody');
    if (tbody && !tbody.dataset.phWired) {
      tbody.dataset.phWired = '1';
      tbody.addEventListener('click', (ev) => {
        const btn = ev.target.closest('.price-spark');
        if (!btn) return;
        ev.preventDefault();
        openPriceHistory(btn.dataset.cruiseId);
      });
    }
    const dialog = document.getElementById('priceHistoryDialog');
    const closeBtn = document.getElementById('phClose');
    if (dialog && closeBtn && !dialog.dataset.phWired) {
      dialog.dataset.phWired = '1';
      closeBtn.addEventListener('click', () => dialog.close());
      // Click on backdrop also closes
      dialog.addEventListener('click', (ev) => {
        if (ev.target === dialog) dialog.close();
      });
    }
  }

  // ── Sort ───────────────────────────────────────────────────────────────────
  // Header click: toggle direction if same column, else switch to it ascending.
  function sortTable(colIndex) {
    sortAsc = sortColIndex === colIndex ? !sortAsc : true;
    sortColIndex = colIndex;
    syncSortControls();
    applyFilters();
  }

  // Dropdown change: switch to the chosen column ascending. Direction is then
  // controlled by the toggle button next to the dropdown.
  function applySortColumn(val) {
    if (!val) {
      sortColIndex = -1;
      sortAsc = true;
    } else {
      sortColIndex = parseInt(val, 10);
      sortAsc = true;
    }
    syncSortControls();
    applyFilters();
  }
  function mobileSortChange()    { applySortColumn(document.getElementById('mobileSortSelect').value); }
  function sortSelectChange(sel) { applySortColumn(sel.value); }

  // Direction toggle button.
  function toggleSortDir() {
    if (sortColIndex < 0) return;   // no-op until a sort column is picked
    sortAsc = !sortAsc;
    syncSortControls();
    applyFilters();
  }

  // Keep all sort UI in step: both dropdowns show the column, both ↑/↓
  // buttons reflect the current direction, and the header gets its arrow class.
  function syncSortControls() {
    const val = sortColIndex >= 0 ? String(sortColIndex) : '';
    for (const id of ['sortSelect', 'mobileSortSelect']) {
      const el = document.getElementById(id);
      if (el && el.value !== val) el.value = val;
    }
    const enabled = sortColIndex >= 0;
    const arrow = sortAsc ? '↑' : '↓';
    const titleText = !enabled
      ? 'Pick a sort column first'
      : (sortAsc ? 'Ascending — click to reverse' : 'Descending — click to reverse');
    for (const id of ['sortDirBtn', 'mobileSortDirBtn']) {
      const btn = document.getElementById(id);
      if (!btn) continue;
      btn.textContent = arrow;
      btn.disabled = !enabled;
      btn.title = titleText;
    }
    document.querySelectorAll('.sort-row th').forEach((th, i) => {
      th.classList.remove('sort-asc', 'sort-desc');
      if (i === sortColIndex) th.classList.add(sortAsc ? 'sort-asc' : 'sort-desc');
    });
  }

  // Debounced filter trigger. Typing in a text/number filter would otherwise
  // re-filter + re-render on every keystroke (3000 cruises × 300 rendered =
  // ~50ms of work per keystroke, which feels laggy under fast typing).
  // 180ms is below the perceptual "instant" threshold but long enough to
  // coalesce typing bursts.
  const FILTER_DEBOUNCE_MS = 180;
  let _filterDebounceTimer = null;
  function debouncedApplyFilters() {
    if (_filterDebounceTimer) clearTimeout(_filterDebounceTimer);
    _filterDebounceTimer = setTimeout(() => {
      _filterDebounceTimer = null;
      applyFilters();
    }, FILTER_DEBOUNCE_MS);
  }

  function mobileFilterSync(el) {
    // Sync the visible value to its desktop twin immediately so both panels
    // stay in step while typing, but defer the actual filter pass.
    const target = document.querySelector(`.col-filter[data-field="${el.dataset.field}"]`);
    if (target) target.value = el.value;
    debouncedApplyFilters();
  }

  function toggleMobileFilters() {
    const dlg = document.getElementById('mobFilters');
    const btn = document.getElementById('mobFilterToggle');
    if (!dlg) return;
    if (dlg.open) {
      dlg.close();
      btn?.setAttribute('aria-expanded', 'false');
    } else {
      if (typeof dlg.showModal === 'function') dlg.showModal();
      else dlg.setAttribute('open', '');
      btn?.setAttribute('aria-expanded', 'true');
    }
  }
  function closeMobileFilters() {
    const dlg = document.getElementById('mobFilters');
    if (dlg?.open) dlg.close();
    document.getElementById('mobFilterToggle')?.setAttribute('aria-expanded', 'false');
  }
  function wireMobileFilterSheet() {
    const dlg = document.getElementById('mobFilters');
    if (!dlg || dlg.dataset.wired) return;
    dlg.dataset.wired = '1';
    document.getElementById('mobFiltersClose')?.addEventListener('click', closeMobileFilters);
    // Backdrop click closes
    dlg.addEventListener('click', (ev) => { if (ev.target === dlg) closeMobileFilters(); });
  }

  function clearMobileFilters() {
    document.querySelectorAll('.mob-filter').forEach(el => { el.value = ''; });
    document.querySelectorAll('.col-filter').forEach(el => { el.value = ''; });
    applyFilters();
  }

  function getCellValue(c, col) {
    switch (col) {
      case 1:  return c.shipName        || '';
      case 2:  return c.provider        || '';
      case 3:  return c.shipClass       || '';
      case 4:  return c.shipLaunchYear  || null;
      case 5:  return c.itinerary       || '';
      case 6:  return c.destination     || '';
      case 7:  return c.departureDate   || '';
      case 8:  return Number.isFinite(parseFloat(c.duration)) ? parseFloat(c.duration) : null;
      case 9:  return c.departurePort   || '';
      case 10: return c.departureRegion || '';
      case 11: return getLowestRoomPrice(c);
      case 12: return getRoomPrice(c, 'inside');
      case 13: return getRoomPrice(c, 'oceanView');
      case 14: return getRoomPrice(c, 'balcony');
      case 15: return getRoomPrice(c, 'suite');
      case 16: return getPricePctChange(c);
      case 17: return getPricePerNight(c);
      default: return '';
    }
  }

  function compare(a, b, descending = false) {
    const aMissing = a === null || a === undefined || a === '' || Number.isNaN(a);
    const bMissing = b === null || b === undefined || b === '' || Number.isNaN(b);
    if (aMissing || bMissing) {
      if (aMissing && bMissing) return 0;
      return aMissing ? 1 : -1;
    }

    let result = 0;
    if (typeof a === 'number' && typeof b === 'number') {
      result = a - b;
    } else {
      result = String(a).localeCompare(String(b), 'en', { numeric: true, sensitivity: 'base' });
    }

    return descending ? -result : result;
  }

  // ── Filter ─────────────────────────────────────────────────────────────────
  function applyFilters() {
    const colFilters = {};
    document.querySelectorAll('.col-filter').forEach(el => {
      const v = el.value.trim();
      if (v) colFilters[el.dataset.field] = v;
    });

    const filtered = allCruises.filter(c => {
      const text = ['shipName', 'provider', 'itinerary', 'destination', 'departurePort'];
      for (const f of text) {
        if (colFilters[f] && !(c[f] || '').toLowerCase().includes(colFilters[f].toLowerCase())) return false;
      }
      // shipClass filter is bi-modal: `tier:<size>` filters by computed
      // size tier from SHIP_TIER_BY_CLASS; anything else is a substring
      // match against the class name (unchanged behaviour).
      const cls = colFilters.shipClass;
      if (cls) {
        if (cls.startsWith('tier:')) {
          if (SHIP_TIER_BY_CLASS[c.shipClass] !== cls.slice(5)) return false;
        } else if (!(c.shipClass || '').toLowerCase().includes(cls.toLowerCase())) {
          return false;
        }
      }
      // departureRegion is similarly bi-modal: `group:<area>` matches any
      // of the regions in REGION_GROUP_MEMBERS; anything else is a
      // substring match against the region name.
      const region = colFilters.departureRegion;
      if (region) {
        if (region.startsWith('group:')) {
          const members = REGION_GROUP_MEMBERS[region.slice(6)];
          if (!members || !members.includes(c.departureRegion)) return false;
        } else if (!(c.departureRegion || '').toLowerCase().includes(region.toLowerCase())) {
          return false;
        }
      }
      if (colFilters.departureDate && !formatDateDisplay(c.departureDate).toLowerCase().includes(colFilters.departureDate.toLowerCase())) return false;
      if (colFilters.minLaunch) {
        const min = parseInt(colFilters.minLaunch, 10);
        if (!isNaN(min) && (!c.shipLaunchYear || c.shipLaunchYear < min)) return false;
      }
      if (colFilters.duration) {
        const min = parseFloat(colFilters.duration);
        if (!isNaN(min) && (parseFloat(c.duration) || 0) < min) return false;
      }
      if (colFilters.maxPrice) {
        const max = parseFloat(colFilters.maxPrice);
        const p   = getGBPPrice(c);
        if (!isNaN(max) && (isNaN(p) || p > max)) return false;
      }
      return true;
    });

    // When no sort is explicitly chosen ("Default"), fall back to price-low
    // ascending (col 11 = lowest cabin) so the "first 300 of N" cap is always
    // anchored to a meaningful ordering — never an arbitrary chunk of the
    // provider load order.
    const effectiveSortCol = sortColIndex >= 0 ? sortColIndex : 11;
    const effectiveSortAsc = sortColIndex >= 0 ? sortAsc : true;
    const sorted = [...filtered].sort((a, b) =>
      compare(getCellValue(a, effectiveSortCol), getCellValue(b, effectiveSortCol), !effectiveSortAsc)
    );

    const capped = !showAll && sorted.length > ROW_CAP ? sorted.slice(0, ROW_CAP) : sorted;
    const allLabel = `${allCruises.length.toLocaleString()}`;
    const showAllLink = `<button type="button" class="show-all-btn" onclick="enableShowAll()">Show all</button>`;
    const sortHint = `<span class="sort-hint"> — tap a column header to sort.</span>`;
    let summary;
    if (capped.length < sorted.length) {
      summary = `Showing first ${capped.length.toLocaleString()} of ${sorted.length.toLocaleString()} sailings · ${showAllLink}${sortHint}`;
    } else if (filtered.length === allCruises.length) {
      summary = `Showing all ${allLabel} sailings${sortHint}`;
    } else {
      summary = `Showing ${filtered.length.toLocaleString()} of ${allLabel} sailings.`;
    }
    document.getElementById('summary').innerHTML = summary;
    syncStickySummary(capped.length, sorted.length, filtered.length === allCruises.length);

    renderBody(capped);
    writeUrlState();
  }

  // Plain-text version of the summary for the sticky-pill button.
  function syncStickySummary(shownCount, totalAvailable, isAllUnfiltered) {
    const el = document.getElementById('stickySummaryText');
    if (!el) return;
    el.textContent = shownCount < totalAvailable
      ? `Showing first ${shownCount.toLocaleString()} of ${totalAvailable.toLocaleString()}`
      : isAllUnfiltered
        ? `Showing all ${totalAvailable.toLocaleString()} sailings`
        : `Showing ${totalAvailable.toLocaleString()} of ${allCruises.length.toLocaleString()}`;
  }

  // Reveal the sticky pill only when the original summary bar is off-screen.
  // (stickySummaryObserver is declared up with the other module-level state
  // so init's wireStickySummary() doesn't hit TDZ.)
  function wireStickySummary() {
    if (stickySummaryObserver || typeof IntersectionObserver === 'undefined') return;
    const sticky = document.getElementById('stickySummary');
    const fab    = document.getElementById('backToTopFab');
    const summaryBar = document.querySelector('.summary-bar');
    if (!sticky || !summaryBar) return;
    stickySummaryObserver = new IntersectionObserver((entries) => {
      // When the summary bar leaves the viewport, both the sticky pill and
      // the back-to-top FAB fade in. They have different positions
      // (top vs. bottom-right) so they don't conflict.
      for (const e of entries) {
        const offscreen = !e.isIntersecting;
        sticky.classList.toggle('visible', offscreen);
        if (fab) fab.classList.toggle('visible', offscreen);
      }
    }, { rootMargin: '0px 0px 0px 0px' });
    stickySummaryObserver.observe(summaryBar);
  }

  function enableShowAll() {
    showAll = true;
    applyFilters();
  }

  // ── URL state ──────────────────────────────────────────────────────────────
  // Serialize filters / sort / showAll / gbp into the URL hash so a refresh
  // and the back button preserve them, and the view is shareable. Only
  // non-default values are written — a clean URL = default state.
  function serializeUrlState() {
    const p = new URLSearchParams();
    if (sortColIndex >= 0) p.set('sort', `${sortColIndex}-${sortAsc ? 'asc' : 'desc'}`);
    if (showAll)           p.set('all', '1');
    if (!showInGbp)        p.set('gbp', '0');
    document.querySelectorAll('.col-filter').forEach(el => {
      if (el.value) p.set(el.dataset.field, el.value);
    });
    return p.toString();
  }

  function writeUrlState() {
    const s = serializeUrlState();
    const desired = s ? '#' + s : window.location.pathname + window.location.search;
    const newHref = s ? (window.location.pathname + window.location.search + '#' + s)
                      : (window.location.pathname + window.location.search);
    if (window.location.hash !== (s ? '#' + s : '')) {
      try { history.replaceState(null, '', newHref); } catch {}
    }
  }

  function applyUrlState() {
    const hash = window.location.hash.replace(/^#/, '');
    if (!hash) return;
    const p = new URLSearchParams(hash);

    const sortVal = p.get('sort');
    if (sortVal && /^\d+-(asc|desc)$/.test(sortVal)) {
      const [col, dir] = sortVal.split('-');
      sortColIndex = parseInt(col, 10);
      sortAsc = dir === 'asc';
      syncSortControls();
    }
    if (p.get('all') === '1') showAll = true;
    // `gbp=0` was the old USD-display toggle. The toggle's been removed
    // from the UI (prices always display in GBP) but we still parse the
    // URL param so legacy bookmarks don't crash. Effectively a no-op now.
    // Filter inputs (both the desktop col-filter row and the mobile filter panel).
    document.querySelectorAll('.col-filter, .mob-filter').forEach(el => {
      const v = p.get(el.dataset.field);
      if (v != null) el.value = v;
    });
  }

  // toggleGBP was the UI handler for the now-removed Prices-in-GBP switch.
  // showInGbp stays `true` permanently; client-side USD→GBP conversion still
  // happens for providers that return USD (Celebrity, NCL).

  function getGBPPrice(c) {
    const n = parseFloat(c.priceFrom);
    if (isNaN(n)) return NaN;
    return (showInGbp && usdToGbp && c.currency === 'USD') ? n * usdToGbp : n;
  }

  // GBP-normalised price for one cabin bucket; NaN when that cabin isn't priced.
  function getRoomPrice(c, bucket) {
    const raw = c.prices?.[bucket];
    const n = parseFloat(raw);
    if (!Number.isFinite(n)) return NaN;
    return (showInGbp && usdToGbp && c.currency === 'USD') ? n * usdToGbp : n;
  }

  // Cabin buckets in the order we present them everywhere.
  const PRICE_BUCKETS  = ['inside', 'oceanView', 'balcony', 'suite'];
  const BUCKET_LABEL   = { inside: 'Inside', oceanView: 'Sea view', balcony: 'Balcony', suite: 'Suite' };
  const BUCKET_COLOR   = { inside: '#2563eb', oceanView: '#0891b2', balcony: '#16a34a', suite: '#9333ea' };
  const LEGACY_COLOR   = '#2563eb';

  // Reads a single bucket's price out of a priceHistory entry. Falls back
  // to the legacy { at, price } shape (treats it as inside-equivalent for
  // continuity with older snapshots) so all callers see one interface.
  function entryPrice(entry, bucket) {
    if (!entry) return null;
    if (entry.prices) {
      const v = parseFloat(entry.prices[bucket]);
      return Number.isFinite(v) ? v : null;
    }
    if (entry.price != null) {
      const v = parseFloat(entry.price);
      return Number.isFinite(v) ? v : null;
    }
    return null;
  }

  // Min across populated cabins for one entry — the "from" trend point.
  function entryMinPrice(entry) {
    if (!entry) return null;
    if (entry.prices) {
      let min = Infinity;
      for (const b of PRICE_BUCKETS) {
        const v = parseFloat(entry.prices[b]);
        if (Number.isFinite(v) && v < min) min = v;
      }
      return min === Infinity ? null : min;
    }
    if (entry.price != null) {
      const v = parseFloat(entry.price);
      return Number.isFinite(v) ? v : null;
    }
    return null;
  }

  // Set of cabin buckets that appear in at least one entry; falls back to
  // a synthetic 'price' bucket for histories made entirely of legacy entries.
  function historyBuckets(history) {
    const buckets = [];
    for (const b of PRICE_BUCKETS) {
      if (history.some(e => e?.prices && e.prices[b] != null)) buckets.push(b);
    }
    return buckets;
  }

  // Percentage change from the first to the latest "min cabin" price.
  // Negative for drops, positive for rises. NaN when there isn't yet a
  // second observation (so the cruise sorts to the bottom either way).
  // Using % rather than absolute £ surfaces genuinely-discounted cruises:
  // a 30% drop on a £500 sailing ranks above a 5% drop on a £5,000 one.
  function getPricePctChange(c) {
    const hist = Array.isArray(c.priceHistory) ? c.priceHistory : [];
    if (hist.length < 2) return NaN;
    const first = entryMinPrice(hist[0]);
    const last  = entryMinPrice(hist[hist.length - 1]);
    if (!Number.isFinite(first) || !Number.isFinite(last) || first === 0) return NaN;
    return ((last - first) / first) * 100;
  }

  // Min across all populated cabin buckets, with priceFrom as fallback for
  // providers that don't publish a per-cabin breakdown. Used as the cruise's
  // "from" sort key — guarantees Price: Low→High always reflects the
  // cheapest cabin available, not whatever priceFrom happens to be.
  function getLowestRoomPrice(c) {
    let min = Infinity;
    for (const bucket of ['inside', 'oceanView', 'balcony', 'suite']) {
      const p = getRoomPrice(c, bucket);
      if (Number.isFinite(p) && p < min) min = p;
    }
    return min === Infinity ? getGBPPrice(c) : min;
  }

  // Lowest-cabin price normalised to a per-night figure. Cruises of different
  // lengths become directly comparable. NaN when nights or price unknown.
  function getPricePerNight(c) {
    const price  = getLowestRoomPrice(c);
    const nights = parseInt(c.duration, 10);
    if (!Number.isFinite(price) || !Number.isFinite(nights) || nights <= 0) return NaN;
    return price / nights;
  }

  // ── Formatting ─────────────────────────────────────────────────────────────
  function formatPriceDisplay(raw, currency) {
    const n = parseFloat(raw);
    if (!raw || isNaN(n)) return '—';
    if (showInGbp && usdToGbp && currency === 'USD') {
      return '£' + Math.round(n * usdToGbp).toLocaleString('en-GB');
    }
    const sym = currency === 'GBP' ? '£' : currency === 'EUR' ? '€' : '$';
    return sym + Math.round(n).toLocaleString('en-GB');
  }

  function formatDurationDisplay(raw) {
    if (!raw) return '—';
    const n = raw.toString().replace(/\D/g, '');
    return n && n !== '0' ? n + 'N' : '—';
  }

  function formatDateDisplay(raw) {
    if (!raw) return '—';
    if (/[a-zA-Z]/.test(raw) && raw.length > 4) return raw;
    const d = new Date(raw);
    return isNaN(d) ? raw : d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
  }

  function absoluteUrl(url) {
    if (!url) return '#';
    if (url.startsWith('http')) return url;
    return 'https://www.royalcaribbean.com' + (url.startsWith('/') ? url : '/' + url);
  }

  function escHtml(str) {
    return String(str)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  // ── Notify subscribe endpoint ──────────────────────────────────────────────
  // Phone number lives in the Settings dialog (stored in localStorage); the
  // bell on each saved view subscribes one-tap via subscribeSavedView()
  // above. No on-page notify modal any more.
  const SUBSCRIBE_URL = 'https://yttgqscwgmsnewdjqbcc.supabase.co/functions/v1/subscribe';
