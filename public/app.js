  // ── State ──────────────────────────────────────────────────────────────────
  let allCruises   = [];
  let cruiseById   = new Map();   // id → cruise, for O(1) lookups from the sparkline observer
  let stickySummaryObserver = null;
  const SAVED_VIEWS_KEY = 'cruise-explorer-saved-views';
  const FAVORITES_KEY = 'cruise-explorer-favorite-cruises';
  const FAVORITES_VIEW_ID = '__favorites__';
  const CRUISE_SEARCH_META = Symbol('cruiseSearchMeta');

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
    darkMode:   false,
    sparklines: false,
    perNight:   false,
    priceStars: true,
    lowestPriceHighlight: true,
    linkTarget: 'wikipedia',
    classDots:  true,
    launchYear: true,
    shipIcons:  true,
    // Days after a cruise's arrival to include when opening a follow-on search
    // from its destination port. Raise it to allow a stayover before the next
    // sailing. See followOnSearchHash().
    followOnDays: 3,
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
  let selectedCruiseId = '';
  let favoriteCruiseIds = new Set();
  let favoritesOnly = false;
  let shipWikiLinks     = {};
  let providerWikiLinks = {};
  let classWikiLinks    = {};
  const VISITOR_ID_KEY = 'cruise-explorer-visitor-id';
  const VISITOR_COUNT_URL = 'https://yttgqscwgmsnewdjqbcc.supabase.co/functions/v1/visitor-count';
  const RECENT_WINDOW_MS = {
    '24h': 24 * 60 * 60 * 1000,
    '7d':  7 * 24 * 60 * 60 * 1000,
  };

  // User-facing changelog. Add new entries at the top whenever features,
  // controls, or layout changes ship so the Site changes dialog stays useful.
  const SITE_CHANGES = [
    {
      date: '4 Jul 2026',
      title: 'Adjustable follow-on search window',
      items: [
        'Display options now include a "Follow-on search window" (default 3 days). Raise it — up to 14 — to look further ahead for an onward cruise from the destination port, handy if you want a stayover before the next sailing.',
      ],
    },
    {
      date: '3 Jul 2026',
      title: 'Instant repeat visits',
      items: [
        'Cruise data is now cached in your browser, so returning to the site shows the last-loaded sailings instantly — even briefly offline — while fresh prices load in the background.',
      ],
    },
    {
      date: '3 Jul 2026',
      title: 'Faster first load',
      items: [
        'The cruise table now loads about 70% less data up front — price history is fetched separately and fills in the sparklines and price stars a moment after the table appears.',
      ],
    },
    {
      date: '3 Jul 2026',
      title: 'Faster filter editing',
      items: [
        'Filter typing now reuses precomputed search keys so large cruise lists stay responsive while you edit filters.',
      ],
    },
    {
      date: '3 Jul 2026',
      title: 'Simpler port matching',
      items: [
        'Port filters and follow-on cruise searches now compare simplified port names, so variants like Southampton (for London), England match Southampton.',
      ],
    },
    {
      date: '3 Jul 2026',
      title: 'Follow-on cruise search',
      items: [
        'Cruise rows now include a destination-port action that opens a new search for sailings departing that port within three days of arrival.',
      ],
    },
    {
      date: '3 Jul 2026',
      title: 'P&O scrape resilience',
      items: [
        'P&O Cruises scraping now sends fuller browser-style request headers and keeps successful cabin pages when another cabin page times out.',
      ],
    },
    {
      date: '3 Jul 2026',
      title: 'Complete itinerary endpoints',
      items: [
        'Itineraries now keep their departure and final return ports while destination ports use the actual final endpoint across supported providers.',
      ],
    },
    {
      date: '30 Jun 2026',
      title: 'Shorter WhatsApp alerts',
      items: [
        'WhatsApp cruise alerts now split into compact message parts and omit long booking links so Twilio accepts large match batches.',
      ],
    },
    {
      date: '27 Jun 2026',
      title: 'Provider scrape reliability',
      items: [
        'Fixed the P&O Cruises fetch path so app-shell responses are rejected before the scraper falls back to a rendered browser page.',
        'Capped slow Norwegian Cruise Line booking-page fallback checks, retried empty scrape responses, and made persistent empty results fail closed instead of overwriting good data.',
        'Scrapes now run providers one at a time to avoid browser-provider contention during scheduled refreshes.',
        'Added longer Royal Caribbean backoff, slower enrichment, NCL empty-page reloads, and sequential P&O cabin fetches to reduce provider-side blocking.',
        'The site now uses fresh provider files even when another provider is missing, so one failed scrape no longer leaves every provider showing stale dates from browser cache.',
      ],
    },
    {
      date: '24 Jun 2026',
      title: 'P&O Cruises scraper fixed',
      items: [
        'Fixed the P&O Cruises scraper: the direct HTTP fetch now falls through to the Jina AI reader when the website returns a JavaScript app shell without rendered cruise tiles.',
        'Added a Playwright last-resort fallback for P&O so future website changes are handled gracefully.',
      ],
    },
    {
      date: '22 Jun 2026',
      title: 'P&O Cruises added',
      items: [
        'Added P&O Cruises sailings with Inside, Sea view, Balcony and Suite prices.',
      ],
    },
    {
      date: '21 Jun 2026',
      title: 'Correct price per night',
      items: [
        'Fixed £/night values for cruises supplied in USD so their prices are converted to GBP only once.',
      ],
    },
    {
      date: '21 Jun 2026',
      title: 'Cleaner main header',
      items: [
        'The latest sync date and time has been removed from the main header; provider update times remain available in Display options.',
      ],
    },
    {
      date: '21 Jun 2026',
      title: 'Favorite cruises',
      items: [
        'Tap any ship icon to favorite or unfavorite that sailing; favorites show a red heart over the ship.',
        'A permanent Favorites view now appears first in the saved-views lists.',
      ],
    },
    {
      date: '21 Jun 2026',
      title: 'Mobile action order',
      items: [
        'Swapped the mobile Sort & filter and Share buttons so filtering appears first.',
      ],
    },
    {
      date: '21 Jun 2026',
      title: 'More compact mobile header',
      items: [
        'Moved the Cruise Explorer title and its waves up, with the info and display buttons overlaid to leave more room for results.',
      ],
    },
    {
      date: '21 Jun 2026',
      title: 'Clearer active filters',
      items: [
        'Active filters in the mobile Sort & filter screen are now highlighted and counted in the header.',
      ],
    },
    {
      date: '21 Jun 2026',
      title: 'More room for saved view names',
      items: [
        'Reduced spacing around the mobile share and filter buttons so saved view names have more room.',
      ],
    },
    {
      date: '21 Jun 2026',
      title: 'Dark mode',
      items: [
        'Added a saved dark mode option to Display options.',
        'Removed the prominent internal gridlines from dark-mode mobile cruise cards.',
      ],
    },
    {
      date: '20 Jun 2026',
      title: 'Provider scrape status',
      items: [
        'Display options now shows the last successful scrape date and time for each cruise provider.',
        'Added one cross-provider smoke test covering a representative sailing from every registered provider.',
      ],
    },
    {
      date: '20 Jun 2026',
      title: 'NCL data refresh restored',
      items: [
        'Fixed the Norwegian Cruise Line card extractor so scheduled NCL data updates can run again.',
      ],
    },
    {
      date: '19 Jun 2026',
      title: 'Mobile share cleanup',
      items: [
        'Mobile now shows only the compact Share search button instead of displaying the same action twice.',
      ],
    },
    {
      date: '19 Jun 2026',
      title: 'More display options',
      items: [
        'Price stars and lowest-price highlighting can now be switched on or off independently.',
        'Ship, cruise-line, and class links now use one destination menu: Wikipedia, Cruise Company, or None.',
      ],
    },
    {
      date: '19 Jun 2026',
      title: 'Mobile price layout',
      items: [
        'When enabled, the price-per-night value now sits above the cabin prices beside First seen on mobile cards.',
      ],
    },
    {
      date: '19 Jun 2026',
      title: 'Price count',
      items: [
        'The page header now shows how many current cabin prices are available across all cruise lines.',
        'The total is calculated during each scrape and cached with the provider data for fast display.',
      ],
    },
    {
      date: '19 Jun 2026',
      title: 'Price-history cleanup',
      items: [
        'Removed old single-value price-history entries now that every history observation uses cabin-specific prices.',
        'Princess histories also remove only their oldest suspicious snapshots where every populated cabin type had the same price.',
      ],
    },
    {
      date: '19 Jun 2026',
      title: 'Share cruises and searches',
      items: [
        'Each cruise now has a compact Share button beside its launch year that opens a link showing only that sailing.',
        'The current filters and sort order can now be shared from the search toolbar.',
        'Peak-price stars now use three tiers without shifting price alignment: gold at 50% below peak, silver at 30%, and outline-only at 15%.',
        'Display options now includes a guide explaining the price-star colours and thresholds.',
      ],
    },
    {
      date: '17 Jun 2026',
      title: 'Mobile filter close button',
      items: [
        'The mobile Sort & filter sheet now leaves top clearance so its close button stays reachable.',
      ],
    },
    {
      date: '17 Jun 2026',
      title: 'NCL price-history cleanup',
      items: [
        'Norwegian Cruise Line histories now drop earliest seeded entries that made cabin prices appear identical.',
      ],
    },
    {
      date: '17 Jun 2026',
      title: 'Price history mobile fit',
      items: [
        'The price-history dialog now uses the visible mobile viewport so the close button stays reachable.',
      ],
    },
    {
      date: '17 Jun 2026',
      title: 'Best price marker',
      items: [
        'Cabin prices now highlight the price amount when it is the lowest seen and at least two previous prices were higher.',
      ],
    },
    {
      date: '17 Jun 2026',
      title: 'Home port highlighting',
      items: [
        'Settings now has a Home port field stored alongside your other browser-only details.',
        'Matching home ports are highlighted in itineraries, departure ports, and destination ports.',
      ],
    },
    {
      date: '13 Jun 2026',
      title: 'Recent price and cruise filters',
      items: [
        'Added filters for cruises reduced in price during the past 24 hours or week.',
        'Added filters for cruises first found during the past 24 hours or week.',
        'Added a sort for the largest price reduction during the past 24 hours.',
      ],
    },
    {
      date: '10 Jun 2026',
      title: 'Bigger transparent favicon',
      items: [
        'The browser tab icon now uses a larger ship mark with no background fill.',
      ],
    },
    {
      date: '10 Jun 2026',
      title: 'Header ship favicon',
      items: [
        'The browser tab icon now uses the same ship mark as the Cruise Explorer header.',
      ],
    },
    {
      date: '9 Jun 2026',
      title: 'NCL sea days',
      items: [
        'Norwegian Cruise Line sea days now derive from intermediate ports in the booking URL.',
        'Long "from X to Y" NCL slugs no longer collapse to nights minus one.',
      ],
    },
    {
      date: '9 Jun 2026',
      title: 'Sea days and scenic cruising',
      items: [
        'Scenic cruising no longer counts as a sea day.',
        'Princess itineraries now infer sea days from the full route instead of counting scenic labels.',
      ],
    },
    {
      date: '9 Jun 2026',
      title: 'Softer itinerary badges',
      items: [
        'Itinerary keyword badges now use a subtler gold treatment.',
      ],
    },
    {
      date: '9 Jun 2026',
      title: 'Itinerary word matching',
      items: [
        'Typing multiple words into the itinerary filter now requires every word to appear in the result.',
        'Each matching word is highlighted with its own gold badge in the itinerary column.',
      ],
    },
    {
      date: '9 Jun 2026',
      title: 'Layered header waves',
      items: [
        'The Cruise Explorer header has its layered water and white crest wave back.',
        'The press-triggered sweep still runs on top of the restored layers.',
      ],
    },
    {
      date: '9 Jun 2026',
      title: 'Class dots everywhere',
      items: [
        'Ship class rows now always show dot markers, even when a class is not in the lookup table.',
      ],
    },
    {
      date: '9 Jun 2026',
      title: 'Quieter first-seen text',
      items: [
        'First-seen dates on cruise cards now read as lighter supporting text.',
      ],
    },
    {
      date: '9 Jun 2026',
      title: 'Press wave restored',
      items: [
        'Pressing the Cruise Explorer title now triggers a single wave sweep again.',
        'The sweep is slower and stays to one wave instead of the earlier layered effect.',
      ],
    },
    {
      date: '9 Jun 2026',
      title: 'Tighter mobile controls',
      items: [
        'The Views and Sort rows in the mobile control strip now sit closer to the divider line.',
      ],
    },
    {
      date: '9 Jun 2026',
      title: 'Launch year star and mute',
      items: [
        'Ships under five years old now get a gold star on their launch-year badge.',
        'Ships over twenty years old now show a much greyer launch-year badge.',
      ],
    },
    {
      date: '9 Jun 2026',
      title: 'Filter clear buttons',
      items: [
        'Each search criterion now has its own clear button in the desktop and mobile filter panels.',
      ],
    },
    {
      date: '9 Jun 2026',
      title: 'Fixed dialog close buttons',
      items: [
        'Display options and Site changes now keep their close buttons visible while their contents scroll.',
      ],
    },
    {
      date: '9 Jun 2026',
      title: 'Ship newness year badges',
      items: [
        'Ship launch years now get a stronger badge treatment for newer ships.',
      ],
    },
    {
      date: '9 Jun 2026',
      title: 'Launch year debounce',
      items: [
        'Typing a launch year now waits a little longer before re-filtering the list.',
      ],
    },
    {
      date: '9 Jun 2026',
      title: 'Softer first-seen text',
      items: [
        'First-seen dates on cruise cards now use a smaller, quieter text style.',
      ],
    },
    {
      date: '9 Jun 2026',
      title: 'Single title wave',
      items: [
        'The Cruise Explorer header now uses one calm wave instead of layered wave shapes.',
        'The wave moves about half as fast as before.',
      ],
    },
    {
      date: '9 Jun 2026',
      title: 'Price alignment',
      items: [
        'Price-history amounts now use a fixed numeric width so the columns are easier to compare at a glance.',
        'Arrows still show changes, but the numbers line up cleanly across each row.',
        'Change arrows now use a reserved slot so they do not move the price text.',
      ],
    },
    {
      date: '9 Jun 2026',
      title: 'Price history scrolling',
      items: [
        'The price-history window now keeps the close button visible while the price rows scroll.',
        'Price-history rows now show the latest observation first.',
      ],
    },
    {
      date: '9 Jun 2026',
      title: 'Visitor counts',
      items: [
        'The footer now shows unique visitors and total visits for the site.',
        'Visits are counted with an anonymous browser ID stored locally.',
      ],
    },
    {
      date: '9 Jun 2026',
      title: 'Async filter updates',
      items: [
        'Filter controls now schedule their recalculation asynchronously instead of rendering immediately.',
        'Typing into text fields such as Destination is debounced so the list updates after a short pause.',
      ],
    },
    {
      date: '9 Jun 2026',
      title: 'Filter clear feedback',
      items: [
        'The mobile Sort & filter Clear all button now shows a busy state while filters are reset.',
        'This gives visible feedback when a large cruise list takes a moment to recalculate.',
      ],
    },
    {
      date: '8 Jun 2026',
      title: 'NCL cabin pricing',
      items: [
        'Norwegian Cruise Line cards now read the live search-result itinerary room buckets.',
        'Inside, ocean view, balcony, and suite prices can now show separately when NCL exposes them.',
      ],
    },
    {
      date: '8 Jun 2026',
      title: 'Celebrity room-tab pricing',
      items: [
        'Celebrity cards now read the room-type prices from the type-and-subtype page tabs.',
        'That keeps the displayed cabin prices aligned with the live room-selection page.',
      ],
    },
    {
      date: '8 Jun 2026',
      title: 'Celebrity room type detection',
      items: [
        'Celebrity live room-page prices now use the visible room copy to identify the cabin type.',
        'That lets the live price replace the matching cabin bucket instead of only updating the from-price.',
      ],
    },
    {
      date: '8 Jun 2026',
      title: 'Celebrity room-page price capture',
      items: [
        'Celebrity cards now read the live room page price when the booking flow exposes it in the HTML.',
        'That live room price can now override the older scraped price on the card.',
      ],
    },
    {
      date: '8 Jun 2026',
      title: 'Footer cleanup',
      items: [
        'Removed the Royal Caribbean data source footer line from the page.',
      ],
    },
    {
      date: '8 Jun 2026',
      title: 'Celebrity room-selection prices',
      items: [
        'Celebrity cruise cards now use live room-selection pricing when it is available.',
        'The displayed from-price falls back to the GraphQL scrape only when the room-selection page has no cabin prices.',
      ],
    },
    {
      date: '8 Jun 2026',
      title: 'Summary line filter details',
      items: [
        'The Showing sailings line now includes a short summary of the active filters.',
        'The count still leads, so the overall result size stays easy to scan.',
      ],
    },
    {
      date: '8 Jun 2026',
      title: 'Header and sort alignment polish',
      items: [
        'Centered the mobile Sort label with its dropdown.',
        'Added white crests to the title wave overlay and made it slightly more opaque.',
      ],
    },
    {
      date: '8 Jun 2026',
      title: 'Mobile sort shortcut',
      items: [
        'Added a second sort dropdown directly under the Views dropdown on the main mobile page.',
        'The new sort control stays synced with the existing toolbar and filter-sheet sort controls.',
      ],
    },
    {
      date: '8 Jun 2026',
      title: 'Departure date range filter',
      items: [
        'Replaced the free-text departure filter with a start/end date popup.',
        'Departure filtering now includes sailings on the start and end dates.',
      ],
    },
    {
      date: '8 Jun 2026',
      title: 'Princess company links fixed',
      items: [
        'Princess ship links now use the official UK ship pages from the Princess fleet page.',
        'Unknown or retired Princess ships fall back to the Princess UK fleet page.',
      ],
    },
    {
      date: '8 Jun 2026',
      title: 'Link destination option',
      items: [
        'Added a Display options toggle for ship, cruise line, and class links.',
        'Links can now point to cruise-company pages instead of Wikipedia.',
      ],
    },
    {
      date: '8 Jun 2026',
      title: 'Cleaner mobile cruise cards',
      items: [
        'Removed the duplicate destination row from mobile cards.',
        'Tightened the region badge so each card uses less vertical space.',
      ],
    },
    {
      date: '8 Jun 2026',
      title: 'First seen and recently found sorting',
      items: [
        'Added first-seen date and time to cruise cards.',
        'Added a Recently found sort that defaults to newest-first.',
      ],
    },
    {
      date: '8 Jun 2026',
      title: 'Saved view names',
      items: [
        'Suggested saved-view names are now shorter and easier to scan.',
        'Full filter and sort details stay visible underneath each saved view.',
        'Long saved-view names are shortened in the compact mobile dropdown.',
      ],
    },
    {
      date: '8 Jun 2026',
      title: 'Header and display options',
      items: [
        'Replaced provider panels with a cruise-line count in the main stats.',
        'Moved the USD exchange rate into Display options.',
        'Moved the animated waves behind the Cruise Explorer title.',
      ],
    },
    {
      date: '8 Jun 2026',
      title: 'Navigation polish',
      items: [
        'Added a back-to-top button after scrolling.',
        'Simplified repeated country names in arrow-separated itineraries.',
      ],
    },
  ];

  const DEFAULT_PROVIDER = {
    id:        'royal-caribbean',
    name:      'Royal Caribbean',
    cruisesUrl:'./providers/royal-caribbean/cruises.json',
  };
  const PROVIDER_INDEX_URL = './providers/index.json';
  const LEGACY_CACHE_KEY = 'cached_cruises';

  // ── Ship class score ───────────────────────────────────────────────────────
  // Class-dot scores are grouped by the typical passenger capacity on the
  // corresponding Wikipedia class/capacity pages. Higher-capacity classes
  // get more filled dots; older/smaller classes get fewer.
  const CLASS_TIER   = {
    Icon: 5,
    Oasis: 4,
    Quantum: 4,
    Edge: 4,
    Prima: 4,
    'Breakaway Plus': 4,
    Freedom: 3,
    Solstice: 3,
    Breakaway: 3,
    Epic: 3,
    Grand: 3,
    Radiance: 2,
    Voyager: 2,
    Millennium: 2,
    Dawn: 2,
    Jewel: 2,
    Spirit: 2,
    America: 2,
    Coral: 2,
    Royal: 4,
    Vision: 1,
    Galapagos: 1,
    Sun: 1,
  };
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
    const tier = CLASS_TIER[shipClass] || 0;
    const colour = tier ? TIER_COLOUR[tier] : 'old';
    const dots = Array.from({ length: 5 }, (_, i) =>
      `<span class="${i < tier ? 'filled ' + colour : ''}"></span>`
    ).join('');
    const label = shipClass || 'Unknown';
    const tip = tier
      ? `${label} class — ${TIER_LABEL[tier]} (${tier}/5)`
      : `${label} class — Class score unavailable`;
    const extraClass = tier ? '' : ' unknown';
    return `<span class="class-dots${extraClass}" title="${escHtml(tip)}">${dots}</span>`;
  }

  function normalizeProvider(provider) {
    const id = provider?.id || DEFAULT_PROVIDER.id;
    const cruisesUrl = provider?.cruisesUrl || provider?.cruisesPath || `./providers/${id}/cruises.json`;
    return {
      id,
      name: provider?.name || id,
      cruisesUrl,
      // Price history is served from a sibling file so the initial cruises.json
      // stays small. Derived by convention when the manifest omits it.
      historyUrl: provider?.historyUrl || cruisesUrl.replace(/cruises\.json$/, 'price-history.json'),
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

  // ── Cache storage (IndexedDB, with a localStorage fallback) ──────────────────
  // The cruise + price-history payloads run to several MB — past localStorage's
  // ~5 MB per-origin quota, and stringifying/writing them is synchronous and
  // blocks the main thread. Persist them in IndexedDB instead: async,
  // non-blocking, and a far larger quota. When IndexedDB is unavailable
  // (private-mode quirks, the test sandbox) every op transparently falls back
  // to localStorage so behaviour is unchanged, just quota-limited.
  const CACHE_DB_NAME = 'cruise-explorer-cache';
  const CACHE_STORE   = 'kv';
  let _cacheDbPromise = null;

  function openCacheDb() {
    if (_cacheDbPromise) return _cacheDbPromise;
    _cacheDbPromise = new Promise((resolve) => {
      try {
        const idb = globalThis.indexedDB;
        if (!idb) { resolve(null); return; }
        const request = idb.open(CACHE_DB_NAME, 1);
        request.onupgradeneeded = () => {
          const db = request.result;
          if (!db.objectStoreNames.contains(CACHE_STORE)) db.createObjectStore(CACHE_STORE);
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror   = () => resolve(null);
      } catch {
        resolve(null);
      }
    });
    return _cacheDbPromise;
  }

  async function cacheGet(key) {
    const db = await openCacheDb();
    if (!db) {
      try { const raw = localStorage.getItem(key); return raw ? JSON.parse(raw) : null; }
      catch { return null; }
    }
    return new Promise((resolve) => {
      try {
        const request = db.transaction(CACHE_STORE, 'readonly').objectStore(CACHE_STORE).get(key);
        request.onsuccess = () => resolve(request.result ?? null);
        request.onerror   = () => resolve(null);
      } catch { resolve(null); }
    });
  }

  async function cacheSet(key, value) {
    const db = await openCacheDb();
    if (!db) {
      // QuotaExceededError is swallowed here just as before — but now only the
      // fallback path, holding the far smaller slim payloads, can hit it.
      try { localStorage.setItem(key, JSON.stringify(value)); } catch {}
      return;
    }
    await new Promise((resolve) => {
      try {
        const tx = db.transaction(CACHE_STORE, 'readwrite');
        tx.objectStore(CACHE_STORE).put(value, key);
        tx.oncomplete = () => resolve();
        tx.onerror    = () => resolve();
        tx.onabort    = () => resolve();
      } catch { resolve(); }
    });
  }

  // Older builds cached the multi-MB payloads in localStorage. Once IndexedDB
  // is in use, reclaim that quota by dropping the stale keys. No-op (keeps the
  // keys) when we're still falling back to localStorage as the cache.
  async function pruneLegacyLocalStorageCache() {
    const db = await openCacheDb();
    if (!db) return;
    try {
      const doomed = [];
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        if (key && (key === LEGACY_CACHE_KEY || key.startsWith(`${LEGACY_CACHE_KEY}:`))) doomed.push(key);
      }
      for (const key of doomed) localStorage.removeItem(key);
    } catch {}
  }

  function getProviderCacheKey(providerId) {
    return `${LEGACY_CACHE_KEY}:${providerId}`;
  }

  async function readCachedPayload(key) {
    const parsed = await cacheGet(key);
    return parsed && Array.isArray(parsed.cruises) ? parsed : null;
  }

  function countCurrentPrices(cruises) {
    return (Array.isArray(cruises) ? cruises : []).reduce((total, cruise) => {
      return total + PRICE_BUCKETS.filter(bucket => {
        const value = parseFloat(cruise?.prices?.[bucket]);
        return Number.isFinite(value) && value > 0;
      }).length;
    }, 0);
  }

  function snapshotPriceCount(payload) {
    const cachedCount = Number(payload?.priceCount);
    return Number.isFinite(cachedCount) && cachedCount >= 0
      ? cachedCount
      : countCurrentPrices(payload?.cruises);
  }

  async function loadCachedCruises(providerIds) {
    const ids = Array.isArray(providerIds) ? providerIds : [providerIds].filter(Boolean);
    const combined = [];
    const counts = new Map();
    const scrapedAts = new Map();
    let priceCount = 0;
    let latestScrapedAt = null;
    let found = false;

    for (const providerId of ids) {
      const cached = await readCachedPayload(getProviderCacheKey(providerId));
      if (!cached) continue;
      found = true;
      combined.push(...cached.cruises);
      counts.set(providerId, (counts.get(providerId) || 0) + cached.cruises.length);
      priceCount += snapshotPriceCount(cached);
      if (cached.scrapedAt) scrapedAts.set(providerId, cached.scrapedAt);
      if (cached.scrapedAt && (!latestScrapedAt || cached.scrapedAt > latestScrapedAt)) latestScrapedAt = cached.scrapedAt;
    }

    if (found) return { cruises: combined, scrapedAt: latestScrapedAt, counts, scrapedAts, priceCount };
    const legacy = await readCachedPayload(LEGACY_CACHE_KEY);
    return legacy ? { cruises: legacy.cruises, scrapedAt: legacy.scrapedAt, counts: new Map(), scrapedAts: new Map(), priceCount: snapshotPriceCount(legacy) } : null;
  }

  // Writes are best-effort and fire-and-forget: the returned promise resolves
  // once the (non-blocking) IndexedDB write lands, but callers need not await.
  function saveCachedCruises(providerId, cruises, scrapedAt, priceCount) {
    return cacheSet(getProviderCacheKey(providerId), { cruises, scrapedAt, priceCount });
  }

  function saveLegacyCachedCruises(cruises, scrapedAt, priceCount) {
    return cacheSet(LEGACY_CACHE_KEY, { cruises, scrapedAt, priceCount });
  }

  // ── Price-history hydration ─────────────────────────────────────────────────
  // Price history is served from a per-provider price-history.json sibling to
  // keep cruises.json small. The table renders first from the slim file, then
  // history is hydrated onto the in-memory cruise objects and the table is
  // re-rendered so sparklines / price stars / drop filters light up. Cruises
  // that arrive with history already inline (legacy files, tests) keep it —
  // hydration only fills gaps.
  function getProviderHistoryCacheKey(providerId) {
    return `${LEGACY_CACHE_KEY}:history:${providerId}`;
  }

  async function readCachedHistory(providerId) {
    const parsed = await cacheGet(getProviderHistoryCacheKey(providerId));
    return parsed && parsed.history && typeof parsed.history === 'object' ? parsed.history : null;
  }

  function saveCachedHistory(providerId, history) {
    return cacheSet(getProviderHistoryCacheKey(providerId), { history });
  }

  // Fills history onto loaded cruises from an { [id]: entries[] } map, without
  // clobbering any history a cruise already carries. Returns how many cruises
  // gained history so callers can skip a needless re-render.
  function attachHistoryMap(history) {
    if (!history || typeof history !== 'object') return 0;
    let added = 0;
    for (const id in history) {
      const entries = history[id];
      if (!Array.isArray(entries) || !entries.length) continue;
      const cruise = cruiseById.get(id);
      if (cruise && (!Array.isArray(cruise.priceHistory) || cruise.priceHistory.length === 0)) {
        cruise.priceHistory = entries;
        added++;
      }
    }
    return added;
  }

  // Near-instant hydration from the previous session's cached history.
  async function hydrateHistoryFromCache(providers) {
    let added = 0;
    for (const provider of providers) {
      added += attachHistoryMap(await readCachedHistory(provider.id));
    }
    if (added && allCruises.length) applyFilters();
  }

  // Fresh hydration from the network, one file per provider in parallel. A
  // missing/404 history file (e.g. inline-history fixtures) is simply skipped.
  async function hydrateHistoryFromNetwork(providers) {
    const results = await Promise.allSettled(providers.map(async (provider) => {
      const res = await fetchStaticJson(provider.historyUrl);
      if (!res.ok) throw new Error(`no-history:${provider.id}`);
      const json = await res.json();
      return { provider, history: json && json.history };
    }));

    let added = 0;
    for (const result of results) {
      if (result.status !== 'fulfilled' || !result.value.history) continue;
      saveCachedHistory(result.value.provider.id, result.value.history);
      added += attachHistoryMap(result.value.history);
    }
    if (added && allCruises.length) applyFilters();
  }

  // ── Init ───────────────────────────────────────────────────────────────────
  (function init() {
    favoriteCruiseIds = loadFavoriteCruiseIds();
    showStatus('Loading cruise data…');
    loadData();
    pruneLegacyLocalStorageCache();
    fetchGBPRate();
    fetchShipWikiLinks();
    loadSettings();
    wireSettingsHandlers();
    wireMobileFilterSheet();
    wireSavedViewsHandlers();
    renderSiteChanges();
    wireSiteChangesHandlers();
    wireDepartureRangeHandlers();
    refreshMobileSavedSelect();
    wirePriceHistoryHandlers();
    wireHeaderWavePress();
    wireStickySummary();
    recordVisitorCount();

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
    const cached = await loadCachedCruises(providers.map(provider => provider.id));
    if (cached) {
      loadedProviderCounts = cached.counts || new Map();
      loadedProviderScrapedAts = cached.scrapedAts || new Map();
      applyCruiseResults(cached.cruises, cached.scrapedAt, cached.priceCount);
      hydrateHistoryFromCache(providers);
    }

    // Try pre-built provider JSON files (GitHub Pages / static hosting).
    // Treat providers independently: one missing/failed JSON file should not
    // keep every other provider stuck on stale localStorage data.
    const settledProviderResults = await Promise.allSettled(providers.map(async (provider) => {
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
    let priceCount = 0;

    for (let i = 0; i < settledProviderResults.length; i++) {
      const settled = settledProviderResults[i];
      const provider = providers[i];
      const json = settled.status === 'fulfilled'
        ? settled.value.json
        : await readCachedPayload(getProviderCacheKey(provider.id));

      if (!json || !Array.isArray(json.cruises) || !json.cruises.length) continue;

      if (settled.status === 'fulfilled') {
        const providerPriceCount = snapshotPriceCount(json);
        saveCachedCruises(provider.id, json.cruises, json.scrapedAt, providerPriceCount);
      }

      const providerPriceCount = snapshotPriceCount(json);
      allCruises.push(...json.cruises);
      priceCount += providerPriceCount;
      providerCounts.set(provider.id, json.cruises.length);
      if (json.scrapedAt) providerScrapedAts.set(provider.id, json.scrapedAt);
      if (json.scrapedAt && (!latestScrapedAt || json.scrapedAt > latestScrapedAt)) latestScrapedAt = json.scrapedAt;
    }

    if (allCruises.length) {
      loadedProviderCounts = providerCounts;
      loadedProviderScrapedAts = providerScrapedAts;
      saveLegacyCachedCruises(allCruises, latestScrapedAt, priceCount);
      applyCruiseResults(allCruises, latestScrapedAt, priceCount);
      hideStatus();
      // Table is up; fill sparklines/stars from last session's cache instantly,
      // then refresh from the network. Both no-op when history is already inline.
      hydrateHistoryFromCache(providers);
      hydrateHistoryFromNetwork(providers);
    } else {
      if (!cached) showStatus('Could not load cruise data: unable to load the static cruise files.', true);
      else hideStatus();
    }
  }

  function getVisitorId() {
    try {
      const existing = localStorage.getItem(VISITOR_ID_KEY);
      if (existing && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(existing)) {
        return existing;
      }
      const webCrypto = globalThis.crypto;
      const randomByte = () => {
        if (webCrypto?.getRandomValues) return webCrypto.getRandomValues(new Uint8Array(1))[0];
        return Math.floor(Math.random() * 256);
      };
      const id = webCrypto?.randomUUID?.()
        || '10000000-1000-4000-8000-100000000000'.replace(/[018]/g, c =>
          (Number(c) ^ randomByte() & 15 >> Number(c) / 4).toString(16)
        );
      localStorage.setItem(VISITOR_ID_KEY, id);
      return id;
    } catch {
      return '';
    }
  }

  async function recordVisitorCount() {
    const target = document.getElementById('visitorStats');
    if (!target) return;
    const visitorId = getVisitorId();
    if (!visitorId) {
      target.textContent = 'Visitors unavailable';
      return;
    }

    try {
      const res = await fetch(VISITOR_COUNT_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ visitorId }),
      });
      if (!res.ok) throw new Error(`visitor-count ${res.status}`);
      const data = await res.json();
      const unique = Number(data?.uniqueVisitors);
      const total = Number(data?.totalVisits);
      if (!Number.isFinite(unique) || !Number.isFinite(total)) throw new Error('invalid visitor counts');
      target.textContent = `Visitors: ${unique.toLocaleString('en-GB')} unique · ${total.toLocaleString('en-GB')} total`;
    } catch {
      target.textContent = 'Visitors unavailable';
    }
  }

  let headerWavePressTimer = null;
  function triggerHeaderWavePress() {
    const wave = document.querySelector('.header-wave');
    if (!wave) return;

    clearTimeout(headerWavePressTimer);
    wave.classList.remove('is-sweeping');
    void wave.offsetWidth;
    wave.classList.add('is-sweeping');
    headerWavePressTimer = setTimeout(() => wave.classList.remove('is-sweeping'), 2900);
  }

  function wireHeaderWavePress() {
    const title = document.querySelector('header h1');
    if (!title || title.dataset.wiredWavePress) return;
    title.dataset.wiredWavePress = '1';

    title.addEventListener('pointerdown', ev => {
      if (ev.button != null && ev.button !== 0) return;
      triggerHeaderWavePress();
    });
    title.addEventListener('keydown', ev => {
      if (ev.key !== 'Enter' && ev.key !== ' ') return;
      ev.preventDefault();
      triggerHeaderWavePress();
    });
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

  function slugifyPath(value) {
    return String(value || '')
      .trim()
      .toLowerCase()
      .replace(/&/g, 'and')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/(^-|-$)/g, '');
  }

  function providerOfficialBase(provider) {
    switch (String(provider || '').toLowerCase()) {
      case 'royal caribbean': return 'https://www.royalcaribbean.com/gbr/en';
      case 'celebrity cruises': return 'https://www.celebritycruises.com/gb';
      case 'norwegian cruise line': return 'https://www.ncl.com/uk/en';
      case 'princess cruises': return 'https://www.princess.com/en-uk';
      case 'p&o cruises': return 'https://www.pocruises.com';
      default: return '';
    }
  }

  function companyProviderUrl(provider) {
    switch (String(provider || '').toLowerCase()) {
      case 'royal caribbean': return 'https://www.royalcaribbean.com/gbr/en/cruises';
      case 'celebrity cruises': return 'https://www.celebritycruises.com/gb/cruises';
      case 'norwegian cruise line': return 'https://www.ncl.com/uk/en/vacations';
      case 'princess cruises': return 'https://www.princess.com/en-uk/cruise-search/results/?resType=C';
      case 'p&o cruises': return 'https://www.pocruises.com/find-a-cruise';
      default: return '';
    }
  }

  function companyShipUrl(c) {
    const provider = String(c?.provider || '').toLowerCase();
    const slug = slugifyPath(c?.shipName);
    if (!slug) return '';
    if (provider === 'royal caribbean') return `https://www.royalcaribbean.com/gbr/en/cruise-ships/${slug}`;
    if (provider === 'celebrity cruises') return `https://www.celebritycruises.com/gb/cruise-ships/${slug}`;
    if (provider === 'norwegian cruise line') return `https://www.ncl.com/uk/en/cruise-ship/${slug}`;
    if (provider === 'p&o cruises') return `https://www.pocruises.com/cruise-ships/${slug}/overview`;
    if (provider === 'princess cruises') {
      const princessShipSlugs = {
        'caribbean-princess': 'cb-caribbean-princess',
        'coral-princess': 'co-coral-princess',
        'crown-princess': 'kp-crown-princess',
        'diamond-princess': 'di-diamond-princess',
        'discovery-princess': 'xp-discovery-princess',
        'emerald-princess': 'ep-emerald-princess',
        'enchanted-princess': 'ex-enchanted-princess',
        'grand-princess': 'ap-grand-princess',
        'island-princess': 'ip-island-princess',
        'majestic-princess': 'mj-majestic-princess',
        'regal-princess': 'gp-regal-princess',
        'royal-princess': 'rp-royal-princess',
        'ruby-princess': 'ru-ruby-princess',
        'sapphire-princess': 'sa-sapphire-princess',
        'sky-princess': 'yp-sky-princess',
        'star-princess': 'st-star-princess',
        'sun-princess': 'su-sun-princess',
      };
      const princessSlug = princessShipSlugs[slug];
      return princessSlug
        ? `https://www.princess.com/en-uk/ships-and-experience/ships/${princessSlug}`
        : 'https://www.princess.com/en-uk/ships-and-experience/ships';
    }
    return '';
  }

  function companyClassUrl(c) {
    const base = providerOfficialBase(c?.provider);
    const query = `${c?.shipClass || ''} class ships`.trim();
    if (!base || !query) return '';
    if (String(c?.provider || '').toLowerCase() === 'princess cruises') {
      return `https://www.princess.com/en-uk/search/?q=${encodeURIComponent(query)}`;
    }
    return `${base}/search?keyword=${encodeURIComponent(query)}`;
  }

  function shipLinkUrl(c) {
    if (settings.linkTarget === 'none') return '';
    return settings.linkTarget === 'company' ? companyShipUrl(c) : shipWikiUrl(c?.shipName);
  }

  function providerLinkUrl(c) {
    if (settings.linkTarget === 'none') return '';
    return settings.linkTarget === 'company' ? companyProviderUrl(c?.provider) : providerWikiUrl(c?.provider);
  }

  function classLinkUrl(c) {
    if (settings.linkTarget === 'none') return '';
    return settings.linkTarget === 'company' ? companyClassUrl(c) : classWikiUrl(c?.shipClass);
  }

  function wikiLink(value, url, fallback = '—') {
    const text = escHtml(value || fallback);
    if (!url) return text;
    const title = settings.linkTarget === 'company' ? 'View on cruise company website' : 'View on Wikipedia';
    return `<a class="wiki-link" href="${escHtml(url)}" target="_blank" rel="noopener noreferrer" title="${escHtml(title)}">${text}</a>`;
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
  function applyCruiseResults(cruises, scrapedAt, priceCount = null) {
    allCruises = cruises || [];
    allCruises.forEach(searchMeta);
    cruiseById = new Map(allCruises.map(c => [c.id, c]));

    populateDropdownFilters(allCruises);

    // Header stats
    document.getElementById('totalCount').textContent = allCruises.length.toLocaleString();
    document.getElementById('totalPrices').textContent = Number.isFinite(priceCount)
      ? priceCount.toLocaleString()
      : '—';
    const ships = new Set(allCruises.map(c => c.shipName).filter(Boolean));
    document.getElementById('totalShips').textContent = ships.size;
    const providers = new Set(allCruises.map(c => c.provider).filter(Boolean));
    document.getElementById('totalProviders').textContent = providers.size.toLocaleString();
    renderProviderScrapeTimes();

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

  function renderProviderScrapeTimes() {
    const list = document.getElementById('settingsProviderScrapes');
    if (!list) return;
    if (!loadedProviders.length) {
      list.innerHTML = '<li><span>Providers</span><time>Loading...</time></li>';
      return;
    }

    list.innerHTML = loadedProviders.map(provider => {
      const raw = loadedProviderScrapedAts.get(provider.id) || '';
      const formatted = raw
        ? formatProviderUpdatedAt(raw).replace(/^Updated:\s*/, '')
        : 'Not available';
      const dateTime = raw && Number.isFinite(new Date(raw).getTime())
        ? ` datetime="${escHtml(new Date(raw).toISOString())}"`
        : '';
      return `<li><span>${escHtml(provider.name)}</span><time${dateTime}>${escHtml(formatted)}</time></li>`;
    }).join('');
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

  function launchYearNewnessClass(year) {
    const n = Number(year);
    if (!Number.isFinite(n)) return 'unknown';
    const age = new Date().getFullYear() - n;
    if (age < 5) return 'newest';
    if (age < 12) return 'new';
    if (age < 20) return 'recent';
    return 'legacy';
  }

  function launchYearBadge(year, extraClass = '') {
    if (!year) return '—';
    const tier = launchYearNewnessClass(year);
    const classes = ['launch-year-badge', `newness-${tier}`, extraClass].filter(Boolean).join(' ');
    const label = tier === 'newest'
      ? `${year} - under 5 years old`
      : tier === 'legacy'
        ? `${year} - 20+ years old`
        : `${year} - ${tier} ship`;
    const star = tier === 'newest'
      ? '<span class="launch-year-star" aria-hidden="true">★</span>'
      : '';
    return `<span class="${classes}" title="${escHtml(label)}">${escHtml(year)}${star}</span>`;
  }

  function cruiseShareButton(c, extraClass = '') {
    const date = formatDateDisplay(c.departureDate);
    const label = `Share ${c.shipName || 'cruise'} departing ${date}`;
    const classes = ['cruise-share-btn', extraClass].filter(Boolean).join(' ');
    return `<button type="button" class="${classes}" data-share-cruise="${escHtml(c.id || '')}" aria-label="${escHtml(label)}" title="${escHtml(label)}">${shareIcon()}</button>`;
  }

  function followOnIcon() {
    return '<svg viewBox="0 0 20 20" fill="currentColor" aria-hidden="true"><path d="M13.5 3.5a.75.75 0 0 1 1.06 0l3 3a.75.75 0 0 1 0 1.06l-3 3a.75.75 0 1 1-1.06-1.06l1.72-1.72H8.5a3.75 3.75 0 0 0 0 7.5h1a.75.75 0 0 1 0 1.5h-1a5.25 5.25 0 0 1 0-10.5h6.72L13.5 4.56a.75.75 0 0 1 0-1.06Z"/></svg>';
  }

  function followOnButton(c, destinationPort = '') {
    if (!c?.id || !destinationPort || !followOnArrivalDateKey(c)) return '';
    const days = normalizeFollowOnDays(settings.followOnDays);
    const label = `Find cruises from ${destinationPort} departing within ${days} day${days === 1 ? '' : 's'} of arrival`;
    return `<button type="button" class="cruise-follow-on-btn" data-follow-on-cruise="${escHtml(c.id)}" aria-label="${escHtml(label)}" title="${escHtml(label)}">${followOnIcon()}</button>`;
  }

  function loadFavoriteCruiseIds() {
    try {
      const raw = localStorage.getItem(FAVORITES_KEY);
      const ids = raw ? JSON.parse(raw) : [];
      return new Set(Array.isArray(ids) ? ids.map(String).filter(Boolean) : []);
    } catch { return new Set(); }
  }

  function persistFavoriteCruiseIds() {
    try { localStorage.setItem(FAVORITES_KEY, JSON.stringify([...favoriteCruiseIds])); } catch {}
  }

  function favoriteCruiseButton(c) {
    const id = String(c?.id || '');
    const isFavorite = favoriteCruiseIds.has(id);
    const action = isFavorite ? 'Remove from favorites' : 'Add to favorites';
    const label = `${action}: ${c?.shipName || 'cruise'}`;
    const tier = shipIconTier(c);
    return `<button type="button" class="ship-favorite-btn tier-${tier}" data-favorite-cruise="${escHtml(id)}" aria-pressed="${isFavorite}" aria-label="${escHtml(label)}" title="${escHtml(label)}"><span class="ship-icon-wrap tier-${tier}" aria-hidden="true"></span><span class="favorite-heart" aria-hidden="true">❤️</span></button>`;
  }

  function toggleFavoriteCruise(cruiseId) {
    const id = String(cruiseId || '');
    if (!id) return;
    if (favoriteCruiseIds.has(id)) favoriteCruiseIds.delete(id);
    else favoriteCruiseIds.add(id);
    persistFavoriteCruiseIds();
    applyFilters();
  }

  function mobileShipHeader(c) {
    const yearHtml = c.shipLaunchYear
      ? launchYearBadge(c.shipLaunchYear, 'mobile-launch-year')
      : '';
    const actionsHtml = `<span class="mobile-ship-actions">${yearHtml}${cruiseShareButton(c, 'mobile-cruise-share')}</span>`;
    // The button keeps the existing masked ship silhouette and adds the
    // favorite heart as a separate overlay.
    const iconHtml = favoriteCruiseButton(c);
    const nameHtml = wikiLink(c.shipName, shipLinkUrl(c));
    return `<span class="mobile-ship-header"><span>${iconHtml}${nameHtml}</span>${actionsHtml}</span>`;
  }

  function mobileShipDetails(c) {
    const classHtml = c.shipClass
      ? `<span class="mobile-class"><span class="class-cell">${wikiLink(c.shipClass, classLinkUrl(c))}${classDots(c.shipClass)}</span></span>`
      : '';
    const providerHtml = wikiLink(c.provider, providerLinkUrl(c));
    return `<span class="mobile-ship-details"><span class="mobile-provider">${providerHtml}</span>${classHtml}</span>`;
  }

  // ── Render ─────────────────────────────────────────────────────────────────
  function cabinBestPriceInfo(c, bucket, currentRaw = null) {
    const current = parseFloat(currentRaw ?? c?.prices?.[bucket]);
    if (!Number.isFinite(current)) return { isBest: false, higherCount: 0 };

    const history = Array.isArray(c?.priceHistory) ? c.priceHistory : [];
    const values = history
      .map(entry => entryPrice(entry, bucket))
      .filter(Number.isFinite);
    if (values.length < 2) return { isBest: false, higherCount: 0 };

    const min = Math.min(current, ...values);
    const higherCount = values.filter(value => value > current).length;
    return {
      isBest: current === min && higherCount > 1,
      higherCount,
    };
  }

  function pricePeakDropInfo(c, currentRaw, bucket = '') {
    const current = parseFloat(currentRaw);
    if (!Number.isFinite(current) || current <= 0) return { hasStar: false, starTier: '', dropPct: 0, peak: null };

    const history = Array.isArray(c?.priceHistory) ? c.priceHistory : [];
    const values = history
      .map(entry => bucket ? entryPrice(entry, bucket) : entryMinPrice(entry))
      .filter(value => Number.isFinite(value) && value > 0);
    const peak = Math.max(current, ...values);
    const dropPct = peak > 0 ? ((peak - current) / peak) * 100 : 0;
    const starTier = dropPct >= 50 ? 'gold'
      : dropPct >= 30 ? 'silver'
        : dropPct >= 15 ? 'outline'
          : '';
    return {
      hasStar: Boolean(starTier),
      starTier,
      dropPct,
      peak,
    };
  }

  function peakDropStar(info, currency) {
    if (!info?.hasStar) {
      return '<span class="peak-drop-star-slot" aria-hidden="true"></span>';
    }
    const drop = Math.round(info.dropPct);
    const peak = formatPriceDisplay(info.peak, currency);
    const label = `${drop}% below recorded peak of ${peak}`;
    return `<span class="peak-drop-star-slot is-visible tier-${escHtml(info.starTier)}" title="${escHtml(label)}" aria-label="${escHtml(label)}">★</span>`;
  }

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
          const best = cabinBestPriceInfo(c, rt.key, prices[rt.key]);
          const rowClass = best.isBest ? 'price-row best-price-row' : 'price-row';
          const priceClass = best.isBest ? 'price-val best-price-val' : 'price-val';
          const peakDrop = pricePeakDropInfo(c, prices[rt.key], rt.key);
          const bestTitle = best.isBest
            ? ` title="Lowest ${escHtml(rt.label)} price seen; ${best.higherCount} previous prices were higher" aria-label="${escHtml(formatted)} - best price"`
            : '';
          const amount = `<span class="price-amount"><span class="${priceClass}"${bestTitle}>${escHtml(formatted)}</span>${peakDropStar(peakDrop, c.currency)}</span>`;
          const row = `<div class="${rowClass}"><span class="price-lbl">${escHtml(rt.label)}</span>${amount}</div>`;
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
      const peakDrop = pricePeakDropInfo(c, c.priceFrom);
      const inner = `<span class="price-amount single-price-amount"><span class="price-val price-from">${escHtml(price)}</span>${peakDropStar(peakDrop, c.currency)}</span>`;
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
  // Single-line sparkline picks the biggest-fall cabin per current sort
  // direction, falling back to the lowest-cabin trend.
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

  function itinerarySearchTerms(query) {
    return Array.from(new Set(
      String(query || '')
        .toLowerCase()
        .split(/\s+/)
        .map(term => term.trim())
        .filter(Boolean)
    ));
  }

  function escapeRegex(text) {
    return String(text || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  function simplifyPortName(value) {
    let text = String(value || '')
      .replace(/\s+/g, ' ')
      .trim();
    if (!text) return '';

    const londonPort = text.match(/^London\s*\((Southampton|Dover|Tilbury|Greenwich)\)/i);
    if (londonPort) text = londonPort[1];

    text = text
      .replace(/\s*\((?:for|near)\s+[^)]*\)/gi, '')
      .replace(/\s*\([^)]*\)/g, '')
      .split(',')[0]
      .replace(/^port\s+(?:of\s+)?/i, '')
      .replace(/\bFt\.\s+/i, 'Fort ')
      .replace(/\bSt\.\s+/i, 'Saint ')
      .replace(/\s+/g, ' ')
      .trim();

    return text;
  }

  function lowerText(value) {
    return String(value || '').trim().toLowerCase();
  }

  function buildCruiseSearchMeta(c) {
    const destinationPort = getDestinationPortDisplay(c);
    return {
      shipName: lowerText(c?.shipName),
      provider: lowerText(c?.provider),
      destination: lowerText(c?.destination),
      itinerary: lowerText(c?.itinerary),
      departurePort: lowerText(c?.departurePort),
      departurePortSimple: lowerText(simplifyPortName(c?.departurePort)),
      destinationPort: lowerText(destinationPort),
      destinationPortSimple: lowerText(simplifyPortName(destinationPort)),
      departureDateKey: cruiseDepartureDateKey(c?.departureDate),
    };
  }

  function searchMeta(c) {
    if (!c) return buildCruiseSearchMeta(null);
    if (!c[CRUISE_SEARCH_META]) {
      Object.defineProperty(c, CRUISE_SEARCH_META, {
        value: buildCruiseSearchMeta(c),
        enumerable: false,
        configurable: true,
      });
    }
    return c[CRUISE_SEARCH_META];
  }

  function portMetaMatchesFilter(port, simplePort, filterValue) {
    const query = lowerText(filterValue);
    if (!query) return true;
    const simpleQuery = lowerText(simplifyPortName(query));
    return Boolean(
      (port && port.includes(query)) ||
      (simplePort && simpleQuery && simplePort.includes(simpleQuery)) ||
      (simplePort && query && simplePort.includes(query)) ||
      (port && simpleQuery && port.includes(simpleQuery))
    );
  }

  function homePortHighlightTerms() {
    const raw = rememberedHomePort().trim();
    if (!raw) return [];
    const terms = [raw];
    const shortName = simplifyPortName(raw);
    if (shortName && shortName.length >= 2) terms.push(shortName);
    return Array.from(new Set(terms.map(term => term.toLowerCase()).filter(Boolean)));
  }

  function highlightTextTerms(text, entries) {
    const displayText = text ? String(text) : '';
    if (!displayText) return '';
    const terms = (entries || [])
      .map(entry => ({
        term: String(entry.term || '').trim().toLowerCase(),
        className: String(entry.className || '').trim(),
      }))
      .filter(entry => entry.term && entry.className);
    if (!terms.length) return escHtml(displayText);

    const classByTerm = new Map(terms.map(entry => [entry.term, entry.className]));
    const matcher = new RegExp(Array.from(classByTerm.keys())
      .map(escapeRegex)
      .sort((a, b) => b.length - a.length)
      .join('|'), 'ig');

    let lastIndex = 0;
    let html = '';
    let matched = false;
    for (let match; (match = matcher.exec(displayText)); ) {
      const matchedText = match[0];
      const className = classByTerm.get(matchedText.toLowerCase()) || 'itinerary-highlight';
      matched = true;
      html += escHtml(displayText.slice(lastIndex, match.index));
      html += `<span class="${className}">${escHtml(matchedText)}</span>`;
      lastIndex = match.index + matchedText.length;
    }
    if (!matched) return escHtml(displayText);
    html += escHtml(displayText.slice(lastIndex));
    return html;
  }

  function highlightItinerary(text, query) {
    const rawText = text ? String(text) : '';
    const searchTerms = itinerarySearchTerms(query);
    const homeTerms = homePortHighlightTerms();
    const displayText = searchTerms.length ? rawText : simplifyItinerary(rawText);
    if (!displayText) return '';
    return highlightTextTerms(displayText, [
      ...searchTerms.map(term => ({ term, className: 'itinerary-highlight' })),
      ...homeTerms.map(term => ({ term, className: 'home-port-highlight' })),
    ]);
  }

  function highlightHomePort(text) {
    return highlightTextTerms(text, homePortHighlightTerms()
      .map(term => ({ term, className: 'home-port-highlight' })));
  }

  function titleCaseToken(text) {
    return String(text || '')
      .trim()
      .split(/\s+/)
      .filter(Boolean)
      .map(part => part ? part[0].toUpperCase() + part.slice(1).toLowerCase() : '')
      .filter(Boolean)
      .join(' ');
  }

  function inferSeaDays(c) {
    const itinerary = String(c?.itinerary || '').trim();
    const fromField = parseFloat(c?.seaDays);
    if (Number.isFinite(fromField) && !/scenic cruising/i.test(itinerary)) {
      return Math.max(0, Math.round(fromField));
    }

    const nights = parseFloat(String(c?.duration || '').match(/(\d+)/)?.[1] || '');
    if (!Number.isFinite(nights)) return null;

    if (!itinerary) return Math.max(0, nights - 1);

    const explicitSeaDays = (itinerary.match(/\b(?:Cruising\s*\(Cruising\)|At Sea|Sea Day|Day at Sea)\b/gi) || []).length;
    if (explicitSeaDays > 0) return explicitSeaDays;

    if (/ncl\.com/i.test(String(c?.bookingUrl || ''))) {
      try {
        const url = new URL(String(c.bookingUrl || ''), window.location.href);
        const pathMatch = url.pathname.match(/\/cruises\/(.+)/);
        if (pathMatch) {
          const itineraryCode = url.searchParams.get('itineraryCode') || '';
          let slug = pathMatch[1];

          if (itineraryCode) {
            slug = slug.replace(new RegExp(`-?${itineraryCode}$`, 'i'), '');
          }

          slug = slug.replace(/^\d+(?:-day|-night|-nite)-/i, '');
          slug = slug.replace(/^.*?-(?:round-trip|roundtrip|one-way|oneway|from)-/i, '');

          const departurePort = String(c?.departurePort || '').trim();
          if (departurePort) {
            const cityName = departurePort.split(/[,(]/)[0].trim();
            const citySlug = cityName.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');
            if (citySlug) {
              if (slug.toLowerCase().startsWith(`${citySlug}-`)) {
                slug = slug.slice(citySlug.length + 1);
              } else if (slug.toLowerCase() === citySlug) {
                slug = '';
              }
            }
          }

          if (slug.toLowerCase().startsWith('to-')) {
            if (/-and-/i.test(slug)) {
              slug = slug.slice(3);
            } else {
              slug = slug.replace(/^to-[a-z]+(?:-[a-z]+){0,3}(?:-|$)/i, '');
            }
          }

          if (slug) {
            const andParts = slug.split(/-and-/i);
            const ports = [];
            for (let i = 0; i < andParts.length - 1; i++) {
              andParts[i].split('-').forEach(part => {
                const port = titleCaseToken(part);
                if (port) ports.push(port);
              });
            }
            const lastPart = titleCaseToken(andParts[andParts.length - 1].replace(/-/g, ' '));
            if (lastPart) ports.push(lastPart);

            if (ports.length > 0) {
              return Math.max(0, (nights + 1) - (ports.length + 2));
            }
          }
        }
      } catch {}
    }

    const routeText = itinerary.includes(':')
      ? itinerary.slice(itinerary.indexOf(':') + 1).trim()
      : itinerary;

    if (routeText.includes('→')) {
      const segments = routeText.split('→').map(part => part.trim()).filter(Boolean).length;
      if (segments > 0) {
        return Math.max(0, (nights + 1) - segments);
      }
    }

    if (routeText.includes(',')) {
      const tokens = routeText.split(',').map(part => part.trim()).filter(Boolean);
      if (tokens.length > 1) {
        const estimatedPortCalls = Math.max(1, Math.ceil(tokens.length / 2));
        return Math.max(0, nights - estimatedPortCalls);
      }
    }

    return Math.max(0, nights - 1);
  }

  function formatSeaDaysDisplay(c) {
    const seaDays = inferSeaDays(c);
    return Number.isFinite(seaDays) ? String(seaDays) : '—';
  }

  function inferDestinationPortFromItinerary(itinerary) {
    const text = String(itinerary || '').trim();
    if (!text) return '';
    const arrowParts = text.split(/\s*→\s*/).map(part => part.trim()).filter(Boolean);
    if (arrowParts.length > 1) return arrowParts[arrowParts.length - 1];
    return '';
  }

  function getDestinationPortDisplay(c) {
    return String(c?.destinationPort || inferDestinationPortFromItinerary(c?.itinerary) || '').trim();
  }

  function renderBody(list, colFilters = {}) {
    const tbody = document.getElementById('cruiseBody');
    if (!list || list.length === 0) {
      tbody.innerHTML = '<tr class="empty-row"><td colspan="16">No cruises match your filters.</td></tr>';
      return;
    }
    tbody.innerHTML = list.map((c, i) => {
      const date     = formatDateDisplay(c.departureDate);
      const duration = formatDurationDisplay(c.duration);
      const url      = c.bookingUrl ? escHtml(absoluteUrl(c.bookingUrl)) : '';
      const priceCell = buildPriceCell(c, url);
      const perNight  = getPricePerNight(c);
      const perNightCell = Number.isFinite(perNight)
        ? `${escHtml(formatPriceDisplay(perNight, 'GBP'))}<span class="per-night-suffix">/night</span>`
        : '—';
      const firstSeen = formatFirstSeenDisplay(c);
      const seaDays = formatSeaDaysDisplay(c);
      const destinationPort = getDestinationPortDisplay(c);
      const destinationPortCell = highlightHomePort(destinationPort);
      const destinationPortAction = `<span class="destination-port-wrap"><span class="destination-port-text">${destinationPortCell || '&mdash;'}</span>${followOnButton(c, destinationPort)}</span>`;
      const departurePortCell = highlightHomePort(c.departurePort);

      return `<tr data-provider="${escHtml(c.provider || '')}">
        <td class="col-num" data-label="#">${i + 1}</td>
        <td class="col-ship ship-name" data-label="Ship">${mobileShipHeader(c)}${mobileShipDetails(c)}</td>
        <td class="col-provider" data-label="Cruise line">${wikiLink(c.provider, providerLinkUrl(c))}</td>
        <td class="col-class" data-label="Class"><span class="class-cell">${wikiLink(c.shipClass, classLinkUrl(c))}${classDots(c.shipClass)}</span></td>
        <td class="col-launch" data-label="Launch"><span class="launch-share-wrap">${launchYearBadge(c.shipLaunchYear)}${cruiseShareButton(c, 'desktop-cruise-share')}</span></td>
        <td class="col-itinerary" data-label="Itinerary">${highlightItinerary(c.itinerary, colFilters.itinerary) || '—'}</td>
        <td class="col-destination" data-label="Destination">${escHtml(c.destination || '—')}</td>
        <td class="col-destination-port" data-label="Destination port">${destinationPortAction}</td>
        <td class="col-date" data-label="Departure">${escHtml(date)}</td>
        <td class="col-duration duration" data-label="Nights">${escHtml(duration)}</td>
        <td class="col-sea-days duration" data-label="Sea days">${escHtml(seaDays)}</td>
        <td class="col-port" data-label="Departure port">${departurePortCell || '&mdash;'}</td>
        <td class="col-region" data-label="Region">${regionBadge(c.departureRegion)}</td>
        <td class="col-first-seen" data-label="First seen"><span class="first-seen-val">${escHtml(firstSeen)}</span></td>
        <td class="col-price price" data-label="Price">${priceCell}</td>
        <td class="col-per-night per-night" data-label="£/night">${perNightCell}</td>
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
    document.getElementById('phSub').textContent = [
      formatDateDisplay(cruise.departureDate),
      formatDurationDisplay(cruise.duration),
      cruise.departurePort,
    ].filter(part => part && part !== '—').join(' · ');

    const chronologicalHistory = [...history].sort((a, b) => {
      const aTime = new Date(a?.at || 0).getTime();
      const bTime = new Date(b?.at || 0).getTime();
      return (Number.isNaN(aTime) ? 0 : aTime) - (Number.isNaN(bTime) ? 0 : bTime);
    });

    const buckets = historyBuckets(chronologicalHistory);
    document.getElementById('phChart').innerHTML       = renderHistoryChart(chronologicalHistory, cruise.currency, buckets);
    document.getElementById('phTableHead').innerHTML   = renderHistoryTableHead(buckets);
    document.getElementById('phTableBody').innerHTML   = renderHistoryTableBody(chronologicalHistory, cruise.currency, buckets);

    if (typeof dialog.showModal === 'function') dialog.showModal();
    else dialog.setAttribute('open', '');
  }

  function renderHistoryChart(history, currency, buckets) {
    const w = 460, h = 160, padL = 50, padR = 10, padT = 10, padB = 22;
    const innerW = w - padL - padR;
    const innerH = h - padT - padB;

    const seriesSpec = buckets.map(b => ({ key: b, label: BUCKET_LABEL[b], color: BUCKET_COLOR[b], getValue: e => entryPrice(e, b) }));

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
    const cabinHeads = buckets.map(b => `<th style="text-align:right">${escHtml(BUCKET_LABEL[b])}</th>`).join('');
    return `<tr><th>When (UTC)</th>${cabinHeads}</tr>`;
  }

  function formatHistoryWhen(value) {
    const d = new Date(value);
    if (Number.isNaN(d.getTime())) return { label: '—', date: '—', year: '', time: '' };
    const date = d.toLocaleDateString('en-GB', { day:'numeric', month:'short', timeZone:'UTC' });
    const year = d.toLocaleDateString('en-GB', { year:'numeric', timeZone:'UTC' });
    const time = d.toLocaleTimeString('en-GB', { hour:'2-digit', minute:'2-digit', timeZone:'UTC' });
    return { label: `${date} ${year}, ${time}`, date, year, time };
  }

  function renderHistoryWhenCell(value) {
    const when = formatHistoryWhen(value);
    const meta = [when.year, when.time].filter(Boolean).map(escHtml).join(' · ');
    return `<td class="ph-when" title="${escHtml(when.label)}"><span class="ph-when-date">${escHtml(when.date)}</span><span class="ph-when-meta">${meta}</span></td>`;
  }

  function renderHistoryTableBody(history, currency, buckets) {
    // Display latest-first, while each delta still compares to the immediately
    // prior scrape in chronological order.
    return history.map((entry, i) => ({ entry, prev: i > 0 ? history[i - 1] : null })).reverse().map(({ entry, prev }) => {
      const whenCell = renderHistoryWhenCell(entry.at);

      const cells = buckets.map(b => {
        const cur = entryPrice(entry, b);
        const prv = prev ? entryPrice(prev, b) : null;
        const emptyArrow = '<span class="ph-arrow ph-arrow-empty" aria-hidden="true"></span>';
        const label = BUCKET_LABEL[b];
        if (cur == null) return `<td class="ph-price ph-missing" data-label="${escHtml(label)}"><span class="ph-price-line"><span class="ph-amount ph-missing">—</span>${emptyArrow}</span></td>`;
        let arrow = emptyArrow;
        if (prv != null && cur !== prv) {
          arrow = cur > prv
            ? '<span class="ph-arrow up" aria-hidden="true">▲</span>'
            : '<span class="ph-arrow down" aria-hidden="true">▼</span>';
        }
        return `<td class="ph-price" data-label="${escHtml(label)}"><span class="ph-price-line"><span class="ph-amount">${escHtml(formatPriceDisplay(cur, currency))}</span>${arrow}</span></td>`;
      }).join('');

      return `<tr>${whenCell}${cells}</tr>`;
    }).join('');
  }

  // ── Display options (settings dialog + localStorage) ─────────────────────
  // SETTINGS_KEY / SETTINGS_DEFAULTS / settings are declared up with the
  // other module-level state so init's loadSettings() doesn't hit the
  // temporal-dead-zone.
  function migrateLinkTarget(saved) {
    if (['wikipedia', 'company', 'none'].includes(saved?.linkTarget)) return saved.linkTarget;
    if (saved?.companyLinks === true) return 'company';
    if (saved?.wikiLinks === false) return 'none';
    return 'wikipedia';
  }

  // Clamp the follow-on search window to a sane whole number of days so a
  // hand-edited or legacy setting can't produce a nonsensical date range.
  function normalizeFollowOnDays(value) {
    const n = Math.round(Number(value));
    if (!Number.isFinite(n)) return SETTINGS_DEFAULTS.followOnDays;
    return Math.min(60, Math.max(1, n));
  }

  function loadSettings() {
    try {
      const raw = localStorage.getItem(SETTINGS_KEY);
      if (raw) {
        const saved = JSON.parse(raw);
        settings = { ...SETTINGS_DEFAULTS, ...saved, linkTarget: migrateLinkTarget(saved) };
        delete settings.wikiLinks;
        delete settings.companyLinks;
        if (!saved.linkTarget) saveSettings();
      }
    } catch {}
    settings.followOnDays = normalizeFollowOnDays(settings.followOnDays);
    applySettingsToDom();
  }
  function saveSettings() {
    try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); } catch {}
  }
  // Drive visibility via classes on <body> so toggling is instant — no
  // re-render needed. Sparklines are lazy anyway; placeholder buttons just
  // get display:none when off.
  function applySettingsToDom() {
    document.body.classList.toggle('dark-mode', !!settings.darkMode);
    document.body.classList.toggle('hide-sparklines', !settings.sparklines);
    document.body.classList.toggle('hide-per-night',  !settings.perNight);
    document.body.classList.toggle('hide-price-stars', !settings.priceStars);
    document.body.classList.toggle('hide-lowest-price-highlight', !settings.lowestPriceHighlight);
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
    const linkTarget = document.getElementById('settingsLinkTarget');
    if (linkTarget) linkTarget.value = settings.linkTarget;
    const followOnDays = document.getElementById('settingsFollowOnDays');
    if (followOnDays) followOnDays.value = String(settings.followOnDays);
    const phoneInput = document.getElementById('settingsPhone');
    if (phoneInput) phoneInput.value = rememberedPhone();
    const homePortInput = document.getElementById('settingsHomePort');
    if (homePortInput) homePortInput.value = rememberedHomePort();
    const phoneStatus = document.getElementById('settingsPhoneStatus');
    if (phoneStatus) phoneStatus.textContent = '';
    const homePortStatus = document.getElementById('settingsHomePortStatus');
    if (homePortStatus) homePortStatus.textContent = '';
    renderProviderScrapeTimes();
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

    const linkTarget = document.getElementById('settingsLinkTarget');
    if (linkTarget) {
      linkTarget.addEventListener('change', () => {
        settings.linkTarget = linkTarget.value;
        saveSettings();
        if (allCruises.length) applyFilters();
      });
    }

    const followOnDays = document.getElementById('settingsFollowOnDays');
    if (followOnDays) {
      followOnDays.addEventListener('change', () => {
        settings.followOnDays = normalizeFollowOnDays(followOnDays.value);
        saveSettings();
        // Re-render so each row's follow-on tooltip reflects the new window.
        if (allCruises.length) applyFilters();
      });
    }

    // Phone number — save on every change, lightly validate, show inline status.
    const phoneInput  = document.getElementById('settingsPhone');
    const phoneStatus = document.getElementById('settingsPhoneStatus');
    if (phoneInput && phoneStatus) {
      phoneInput.addEventListener('input', () => {
        const v = phoneInput.value.trim();
        if (!v) {
          rememberPhone('');
          phoneStatus.textContent = 'Cleared';
          phoneStatus.className = 'settings-field-status settings-phone-status muted';
        } else if (/^\+\d{7,15}$/.test(v)) {
          rememberPhone(v);
          phoneStatus.textContent = 'Saved';
          phoneStatus.className = 'settings-field-status settings-phone-status ok';
        } else {
          phoneStatus.textContent = 'Use international format, e.g. +447700900123';
          phoneStatus.className = 'settings-field-status settings-phone-status err';
        }
      });
    }

    const homePortInput = document.getElementById('settingsHomePort');
    const homePortStatus = document.getElementById('settingsHomePortStatus');
    if (homePortInput && homePortStatus) {
      homePortInput.addEventListener('input', () => {
        const v = homePortInput.value.trim();
        rememberHomePort(v);
        homePortStatus.textContent = v ? 'Saved' : 'Cleared';
        homePortStatus.className = `settings-field-status settings-home-port-status ${v ? 'ok' : 'muted'}`;
        if (allCruises.length) applyFilters();
      });
    }

    document.getElementById('settingsClose').addEventListener('click', () => dlg.close());
    document.getElementById('settingsReset').addEventListener('click', () => {
      settings = { ...SETTINGS_DEFAULTS };
      dlg.querySelectorAll('input[data-setting]').forEach(cb => {
        cb.checked = !!settings[cb.dataset.setting];
      });
      if (linkTarget) linkTarget.value = settings.linkTarget;
      if (followOnDays) followOnDays.value = String(settings.followOnDays);
      applySettingsToDom();
      saveSettings();
      if (allCruises.length) applyFilters();
      // Reset does NOT clear personal details such as phone or home port.
      // They can clear those themselves by emptying the fields.
    });
    dlg.addEventListener('click', ev => { if (ev.target === dlg) dlg.close(); });
  }

  function renderSiteChanges() {
    const list = document.getElementById('siteChangesList');
    if (!list) return;
    list.innerHTML = SITE_CHANGES.map(entry => `
      <li class="changes-item">
        <div class="changes-date">${escHtml(entry.date)}</div>
        <h3>${escHtml(entry.title)}</h3>
        <ul>
          ${entry.items.map(item => `<li>${escHtml(item)}</li>`).join('')}
        </ul>
      </li>
    `).join('');
  }

  function openSiteChanges() {
    renderSiteChanges();
    const dlg = document.getElementById('siteChangesDialog');
    if (!dlg) return;
    if (typeof dlg.showModal === 'function') dlg.showModal();
    else dlg.setAttribute('open', '');
  }

  function wireSiteChangesHandlers() {
    const dlg = document.getElementById('siteChangesDialog');
    if (!dlg || dlg.dataset.wired) return;
    dlg.dataset.wired = '1';
    document.getElementById('changesClose')?.addEventListener('click', () => dlg.close());
    dlg.addEventListener('click', ev => { if (ev.target === dlg) dlg.close(); });
  }

  function dateInputToDisplay(value) {
    if (!value) return '';
    const d = new Date(`${value}T00:00:00Z`);
    if (Number.isNaN(d.getTime())) return value;
    return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
  }

  function departureRangeLabel(start, end) {
    if (start && end) return `${dateInputToDisplay(start)} - ${dateInputToDisplay(end)}`;
    if (start) return `From ${dateInputToDisplay(start)}`;
    if (end) return `Until ${dateInputToDisplay(end)}`;
    return 'Any date';
  }

  function getFilterFieldValue(field) {
    return document.querySelector(`.col-filter[data-field="${field}"]`)?.value || '';
  }

  function setFilterFieldValue(field, value) {
    document.querySelectorAll(`.col-filter[data-field="${field}"], .mob-filter[data-field="${field}"]`)
      .forEach(el => { el.value = value || ''; });
  }

  function clearFilterField(field) {
    if (field === 'departureStart' || field === 'departureEnd') {
      clearDepartureRange();
      return;
    }
    setFilterFieldValue(field, '');
    updateMobileFilterActiveStates();
    scheduleApplyFilters();
  }

  function normalizeDateRange(start, end) {
    if (start && end && start > end) return { start: end, end: start };
    return { start: start || '', end: end || '' };
  }

  function setDepartureRange(start, end) {
    const range = normalizeDateRange(start, end);
    setFilterFieldValue('departureStart', range.start);
    setFilterFieldValue('departureEnd', range.end);
    updateDepartureRangeControls();
  }

  function updateDepartureRangeControls() {
    const start = getFilterFieldValue('departureStart');
    const end = getFilterFieldValue('departureEnd');
    const label = departureRangeLabel(start, end);
    for (const id of ['departureRangeBtn', 'mobDepartureRangeBtn']) {
      const btn = document.getElementById(id);
      if (!btn) continue;
      btn.textContent = label;
      btn.title = label === 'Any date' ? 'Choose departure date range' : `Departure: ${label}`;
      btn.classList.toggle('has-value', label !== 'Any date');
    }
    updateMobileFilterActiveStates();
  }

  function updateDepartureRangePreview() {
    const start = document.getElementById('departureRangeStart')?.value || '';
    const end = document.getElementById('departureRangeEnd')?.value || '';
    const range = normalizeDateRange(start, end);
    const preview = document.getElementById('departureRangePreview');
    if (preview) preview.textContent = `Range: ${departureRangeLabel(range.start, range.end)}`;
  }

  function openDepartureRange() {
    const dlg = document.getElementById('departureRangeDialog');
    if (!dlg) return;
    const start = document.getElementById('departureRangeStart');
    const end = document.getElementById('departureRangeEnd');
    if (start) start.value = getFilterFieldValue('departureStart');
    if (end) end.value = getFilterFieldValue('departureEnd');
    updateDepartureRangePreview();
    if (typeof dlg.showModal === 'function') dlg.showModal();
    else dlg.setAttribute('open', '');
  }

  function applyDepartureRange() {
    const start = document.getElementById('departureRangeStart')?.value || '';
    const end = document.getElementById('departureRangeEnd')?.value || '';
    setDepartureRange(start, end);
    document.getElementById('departureRangeDialog')?.close();
    scheduleApplyFilters();
  }

  function clearDepartureRange() {
    setDepartureRange('', '');
    const start = document.getElementById('departureRangeStart');
    const end = document.getElementById('departureRangeEnd');
    if (start) start.value = '';
    if (end) end.value = '';
    updateDepartureRangePreview();
    scheduleApplyFilters();
  }

  function wireDepartureRangeHandlers() {
    const dlg = document.getElementById('departureRangeDialog');
    if (!dlg || dlg.dataset.wired) return;
    dlg.dataset.wired = '1';
    document.getElementById('departureRangeClose')?.addEventListener('click', () => dlg.close());
    document.getElementById('departureRangeCancel')?.addEventListener('click', () => dlg.close());
    document.getElementById('departureRangeApply')?.addEventListener('click', applyDepartureRange);
    document.getElementById('departureRangeClear')?.addEventListener('click', clearDepartureRange);
    document.getElementById('departureRangeStart')?.addEventListener('input', updateDepartureRangePreview);
    document.getElementById('departureRangeEnd')?.addEventListener('input', updateDepartureRangePreview);
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
    opts.push(`<option value="${FAVORITES_VIEW_ID}">❤️ Favorites</option>`);
    opts.push('<option value="__save__">＋ Save current view…</option>');
    if (views.length) {
      opts.push('<optgroup label="Your views">');
      for (const v of views) opts.push(`<option value="${escHtml(v.id)}">${escHtml(compactSavedViewMenuName(v.name))}</option>`);
      opts.push('</optgroup>');
    }
    opts.push('<option value="__manage__">Manage saved views…</option>');
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
    if (v === FAVORITES_VIEW_ID) {
      applyFavoritesView();
      return;
    }
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
    empty.hidden = true;
    const favoritesItem = `<li class="sv-item sv-built-in">
      <button type="button" class="sv-apply" data-id="${FAVORITES_VIEW_ID}">
        <span class="sv-name">❤️ Favorites</span>
        <span class="sv-hash">Cruises you marked as favorites</span>
      </button>
    </li>`;
    list.innerHTML = favoritesItem + views
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
    18: 'Recently found',
    20: '24hr price reduction',
    21: 'Destination port',
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
      if (k === 'sort' || k === 'all' || k === 'gbp' || k === 'departureStart' || k === 'departureEnd') continue;
      const recentLabel = k === 'priceDropWindow' || k === 'newWithin'
        ? savedViewFilterLabel(k, v)
        : '';
      parts.push(recentLabel || `${k}=${v}`);
    }
    const departure = savedViewDepartureRangeLabel(p);
    if (departure) parts.push(departure);
    return parts.length ? parts.join(' · ') : 'No filters';
  }

  function savedViewDepartureRangeLabel(params) {
    const start = params.get('departureStart') || '';
    const end = params.get('departureEnd') || '';
    if (!start && !end) return '';
    return `Departure ${departureRangeLabel(start, end)}`;
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
    if (key === 'destinationPort') return `To ${v}`;
    if (key === 'destination') return v;
    if (key === 'itinerary') return v;
    if (key === 'departureDate') return v;
    if (key === 'departureStart') return `From ${dateInputToDisplay(v)}`;
    if (key === 'departureEnd') return `Until ${dateInputToDisplay(v)}`;
    if (key === 'minLaunch') return `Ships ${v}+`;
    if (key === 'duration') return `${v}+ nights`;
    if (key === 'seaDays') return `Max ${v} sea days`;
    if (key === 'maxPrice') return `Under GBP ${Number(v).toLocaleString('en-GB')}`;
    if (key === 'priceDropWindow') return v === '24h' ? 'Price reduced in 24h' : v === '7d' ? 'Price reduced in 1 week' : '';
    if (key === 'newWithin') return v === '24h' ? 'Added in 24h' : v === '7d' ? 'Added in 1 week' : '';
    return v;
  }

  function savedViewSortName(sort) {
    if (!sort) return '';
    const [col] = sort.split('-');
    const names = {
      11: 'Lowest price',
      12: 'Inside',
      13: 'Sea view',
      14: 'Balcony',
      15: 'Suite',
      16: 'Price change',
      17: 'GBP/night',
      18: 'Recently found',
      19: 'Sea days',
      20: '24hr price reduction',
    };
    return names[col] || '';
  }

  function savedViewShortPortName(value) {
    const v = String(value || '').trim();
    if (!v) return '';
    return v.split(',')[0].replace(/\s*\([^)]*\)\s*/g, ' ').trim();
  }

  function savedViewShortDuration(value) {
    const n = parseInt(value, 10);
    return Number.isFinite(n) && n > 0 ? `${n}N` : '';
  }

  function savedViewKeywordName(params) {
    const fields = [
      'destination',
      'destinationPort',
      'itinerary',
      'shipName',
      'shipClass',
      'departureRegion',
      'provider',
      'priceDropWindow',
      'newWithin',
      'seaDays',
      'maxPrice',
      'minLaunch',
    ];
    for (const field of fields) {
      const label = savedViewFilterLabel(field, params.get(field));
      if (!label) continue;
      if (field === 'shipClass') return label.replace(/\s+class$/i, '');
      return label;
    }
    return savedViewSortName(params.get('sort'));
  }

  function selectedFilterSummary(filters) {
    const parts = [];
    const add = (label) => { if (label) parts.push(label); };
    const source = filters || {};
    add(savedViewFilterLabel('provider', source.provider));
    add(savedViewFilterLabel('shipName', source.shipName));
    add(savedViewFilterLabel('shipClass', source.shipClass));
    add(savedViewFilterLabel('departureRegion', source.departureRegion));
    add(savedViewFilterLabel('departurePort', source.departurePort));
    add(savedViewFilterLabel('destinationPort', source.destinationPort));
    const departureParams = new URLSearchParams();
    if (source.departureStart) departureParams.set('departureStart', source.departureStart);
    if (source.departureEnd) departureParams.set('departureEnd', source.departureEnd);
    const departure = savedViewDepartureRangeLabel(departureParams);
    add(departure);
    add(savedViewFilterLabel('destination', source.destination));
    add(savedViewFilterLabel('itinerary', source.itinerary));
    add(savedViewFilterLabel('minLaunch', source.minLaunch));
    add(savedViewFilterLabel('duration', source.duration));
    add(savedViewFilterLabel('seaDays', source.seaDays));
    add(savedViewFilterLabel('maxPrice', source.maxPrice));
    add(savedViewFilterLabel('priceDropWindow', source.priceDropWindow));
    add(savedViewFilterLabel('newWithin', source.newWithin));
    return parts.slice(0, 3).join(' · ');
  }

  function buildSuggestedSavedViewName(hash) {
    const p = new URLSearchParams(hash || '');
    const parts = [
      savedViewShortPortName(p.get('departurePort')),
      savedViewShortDuration(p.get('duration')),
      savedViewKeywordName(p),
    ].filter(Boolean);
    const name = parts.length ? parts.join(' ') : 'All sailings';
    return name.length > 42 ? `${name.slice(0, 39).trim()}...` : name;
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

  function applyFavoritesView() {
    document.querySelectorAll('.col-filter, .mob-filter').forEach(el => { el.value = ''; });
    updateDepartureRangeControls();
    updateMobileFilterActiveStates();
    sortColIndex = -1;
    sortAsc = true;
    showAll = false;
    selectedCruiseId = '';
    favoritesOnly = true;
    syncSortControls();
    applyFilters();
    document.getElementById('savedViewsDialog')?.close();
  }

  function clearFavoritesView() {
    favoritesOnly = false;
    applyFilters();
  }

  function applySavedView(id) {
    const view = loadSavedViews().find(v => v.id === id);
    if (!view) return;
    // Reset state, write the saved hash, re-apply.
    document.querySelectorAll('.col-filter, .mob-filter').forEach(el => { el.value = ''; });
    updateDepartureRangeControls();
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
                    'departureDate','departureStart','departureEnd','duration','departurePort','destinationPort','departureRegion'];
    const NUMERIC = ['minLaunch','duration','seaDays','maxPrice'];
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

  // Personal details remembered across sessions.
  const PHONE_KEY = 'cruise-explorer-phone';
  const HOME_PORT_KEY = 'cruise-explorer-home-port';
  function rememberedPhone() {
    try { return localStorage.getItem(PHONE_KEY) || ''; } catch { return ''; }
  }
  function rememberPhone(phone) {
    try { localStorage.setItem(PHONE_KEY, phone); } catch {}
  }
  function rememberedHomePort() {
    try { return localStorage.getItem(HOME_PORT_KEY) || ''; } catch { return ''; }
  }
  function rememberHomePort(port) {
    try { localStorage.setItem(HOME_PORT_KEY, port); } catch {}
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
      if (apply?.dataset.id === FAVORITES_VIEW_ID) applyFavoritesView();
      else if (apply) applySavedView(apply.dataset.id);
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
        const favoriteBtn = ev.target.closest('[data-favorite-cruise]');
        if (favoriteBtn) {
          ev.preventDefault();
          toggleFavoriteCruise(favoriteBtn.dataset.favoriteCruise);
          return;
        }
        const shareBtn = ev.target.closest('[data-share-cruise]');
        if (shareBtn) {
          ev.preventDefault();
          shareCruise(shareBtn.dataset.shareCruise);
          return;
        }
        const followOnBtn = ev.target.closest('[data-follow-on-cruise]');
        if (followOnBtn) {
          ev.preventDefault();
          openFollowOnSearch(followOnBtn.dataset.followOnCruise);
          return;
        }
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
    scheduleApplyFilters();
  }

  // Dropdown change: switch to the chosen column. Time-recency and recent
  // price-reduction sorts start descending because newest/largest is useful.
  function applySortColumn(val) {
    if (!val) {
      sortColIndex = -1;
      sortAsc = true;
    } else {
      sortColIndex = parseInt(val, 10);
      sortAsc = sortColIndex === 18 || sortColIndex === 20 ? false : true;
    }
    syncSortControls();
    scheduleApplyFilters();
  }
  function mobileSortChange()    { applySortColumn(document.getElementById('mobileSortSelect').value); }
  function mobilePageSortChange() { applySortColumn(document.getElementById('mobilePageSortSelect').value); }
  function sortSelectChange(sel) { applySortColumn(sel.value); }

  // Direction toggle button.
  function toggleSortDir() {
    if (sortColIndex < 0) return;   // no-op until a sort column is picked
    sortAsc = !sortAsc;
    syncSortControls();
    scheduleApplyFilters();
  }

  // Keep all sort UI in step: both dropdowns show the column, both ↑/↓
  // buttons reflect the current direction, and the header gets its arrow class.
  function syncSortControls() {
    const val = sortColIndex >= 0 ? String(sortColIndex) : '';
    for (const id of ['sortSelect', 'mobileSortSelect', 'mobilePageSortSelect']) {
      const el = document.getElementById(id);
      if (el && el.value !== val) el.value = val;
    }
    const enabled = sortColIndex >= 0;
    const arrow = sortAsc ? '↑' : '↓';
    const titleText = !enabled
      ? 'Pick a sort column first'
      : (sortAsc ? 'Ascending — click to reverse' : 'Descending — click to reverse');
    // State-aware aria-label so screen readers announce the current
    // direction and the action that will follow. aria-pressed is the
    // standard toggle-button pattern; the button toggles ascending↔descending.
    const dirAria = !enabled
      ? 'Sort direction — pick a sort column first'
      : (sortAsc
          ? 'Sort ascending — activate to switch to descending'
          : 'Sort descending — activate to switch to ascending');
    for (const id of ['sortDirBtn', 'mobileSortDirBtn', 'mobilePageSortDirBtn']) {
      const btn = document.getElementById(id);
      if (!btn) continue;
      btn.textContent = arrow;
      btn.disabled = !enabled;
      btn.title = titleText;
      btn.setAttribute('aria-label', dirAria);
      btn.setAttribute('aria-pressed', String(enabled && sortAsc));
    }
    document.querySelectorAll('.sort-row th').forEach((th) => {
      th.classList.remove('sort-asc', 'sort-desc');
      const col = parseInt(th.dataset.sort, 10);
      if (col === sortColIndex) {
        th.classList.add(sortAsc ? 'sort-asc' : 'sort-desc');
        th.setAttribute('aria-sort', sortAsc ? 'ascending' : 'descending');
      } else {
        th.setAttribute('aria-sort', 'none');
      }
    });
  }

  // Keyboard activation for sort headers. The <th> cells carry
  // tabindex="0" + role="button" so they're in the tab order; this
  // delegated listener turns Enter/Space into a sortTable() call so
  // keyboard users can re-sort without a mouse.
  const sortRow = document.querySelector('.sort-row');
  if (sortRow && !sortRow.dataset.kbWired) {
    sortRow.dataset.kbWired = '1';
    sortRow.addEventListener('keydown', (ev) => {
      if (ev.key !== 'Enter' && ev.key !== ' ' && ev.key !== 'Spacebar') return;
      const th = ev.target.closest('th[data-sort]');
      if (!th || !sortRow.contains(th)) return;
      ev.preventDefault();
      const col = parseInt(th.dataset.sort, 10);
      if (Number.isFinite(col)) sortTable(col);
    });
  }

  // Debounced filter trigger. Typing in a text/number filter would otherwise
  // re-filter + re-render on every keystroke (3000 cruises × 300 rendered =
  // ~50ms of work per keystroke, which feels laggy under fast typing).
  // 320ms is below the perceptual "instant" threshold but long enough to
  // coalesce typing bursts.
  const FILTER_DEBOUNCE_MS = 320;
  const LAUNCH_YEAR_DEBOUNCE_MS = 650;
  let _filterDebounceTimer = null;
  let _filterRunId = 0;
  function scheduleApplyFilters({ delay = 0 } = {}) {
    if (_filterDebounceTimer) clearTimeout(_filterDebounceTimer);
    const runId = ++_filterRunId;
    _filterDebounceTimer = setTimeout(async () => {
      _filterDebounceTimer = null;
      await waitForNextPaint();
      if (runId !== _filterRunId) return;
      applyFilters();
    }, delay);
  }

  function debouncedApplyFilters() {
    scheduleApplyFilters({ delay: FILTER_DEBOUNCE_MS });
  }

  function debouncedLaunchYearFilters() {
    scheduleApplyFilters({ delay: LAUNCH_YEAR_DEBOUNCE_MS });
  }

  function mobileFilterSync(el) {
    // Sync the visible value to its desktop twin immediately so both panels
    // stay in step while typing, but defer the actual filter pass.
    const target = document.querySelector(`.col-filter[data-field="${el.dataset.field}"]`);
    if (target) target.value = el.value;
    updateMobileFilterActiveStates();
    const isSelect = String(el?.tagName || '').toUpperCase() === 'SELECT';
    const delay = isSelect ? 0 : (el?.dataset?.field === 'minLaunch' ? LAUNCH_YEAR_DEBOUNCE_MS : FILTER_DEBOUNCE_MS);
    scheduleApplyFilters({ delay });
  }

  function updateMobileFilterActiveStates() {
    const groups = document.querySelectorAll('#mobFilters .mob-filter-group:not(.mob-sort-inline):not(.mob-filter-actions)');
    let activeCount = 0;

    groups.forEach(group => {
      const isActive = Array.from(group.querySelectorAll('.mob-filter'))
        .some(filter => String(filter.value || '').trim() !== '');
      group.classList.toggle('has-active-filter', isActive);
      if (isActive) activeCount += 1;
    });

    const count = document.getElementById('mobActiveFilterCount');
    if (count) {
      count.textContent = `${activeCount} active`;
      count.hidden = activeCount === 0;
    }
  }

  function toggleMobileFilters() {
    const dlg = document.getElementById('mobFilters');
    const btn = document.getElementById('mobFilterToggle');
    if (!dlg) return;
    if (dlg.open) {
      dlg.close();
      btn?.setAttribute('aria-expanded', 'false');
    } else {
      updateMobileFilterActiveStates();
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

  function waitForNextPaint() {
    return new Promise(resolve => {
      if (typeof requestAnimationFrame !== 'function') {
        setTimeout(resolve, 0);
        return;
      }
      requestAnimationFrame(() => requestAnimationFrame(resolve));
    });
  }

  async function clearMobileFilters() {
    const btn = document.getElementById('mobClearFilters');
    if (btn?.classList.contains('is-busy')) return;
    const originalText = btn?.textContent || 'Clear all';

    if (btn) {
      btn.classList.add('is-busy');
      btn.disabled = true;
      btn.setAttribute('aria-busy', 'true');
      btn.textContent = 'Clearing...';
    }

    try {
      await waitForNextPaint();
      document.querySelectorAll('.mob-filter').forEach(el => { el.value = ''; });
      document.querySelectorAll('.col-filter').forEach(el => { el.value = ''; });
      updateDepartureRangeControls();
      updateMobileFilterActiveStates();
      applyFilters();
    } finally {
      if (btn) {
        btn.classList.remove('is-busy');
        btn.disabled = false;
        btn.removeAttribute('aria-busy');
        btn.textContent = originalText;
      }
    }
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
      case 18: return getFirstSeenTime(c);
      case 19: return inferSeaDays(c);
      case 20: return getRecentPriceReductionPct(c, RECENT_WINDOW_MS['24h']);
      case 21: return getDestinationPortDisplay(c);
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

  function cruiseDepartureDateKey(raw) {
    const value = String(raw || '').trim();
    if (!value) return '';
    const iso = value.match(/^(\d{4}-\d{2}-\d{2})/);
    if (iso) return iso[1];
    const d = new Date(value);
    if (Number.isNaN(d.getTime())) return '';
    return d.toISOString().slice(0, 10);
  }

  function cruiseMatchesDepartureRange(cruise, start, end) {
    if (!start && !end) return true;
    const key = searchMeta(cruise).departureDateKey;
    if (!key) return false;
    if (start && key < start) return false;
    if (end && key > end) return false;
    return true;
  }

  // ── Filter ─────────────────────────────────────────────────────────────────
  function applyFilters() {
    const colFilters = {};
    document.querySelectorAll('.col-filter').forEach(el => {
      const v = el.value.trim();
      if (v) colFilters[el.dataset.field] = v;
    });
    const normalizedFilters = {
      shipName: lowerText(colFilters.shipName),
      provider: lowerText(colFilters.provider),
      destination: lowerText(colFilters.destination),
      departurePort: lowerText(colFilters.departurePort),
      destinationPort: lowerText(colFilters.destinationPort),
    };
    const itineraryTerms = itinerarySearchTerms(colFilters.itinerary);

    const filtered = allCruises.filter(c => {
      if (selectedCruiseId && c.id !== selectedCruiseId) return false;
      if (favoritesOnly && !favoriteCruiseIds.has(String(c.id || ''))) return false;
      const meta = searchMeta(c);
      if (itineraryTerms.length) {
        if (!itineraryTerms.every(term => meta.itinerary.includes(term))) return false;
      }

      const text = ['shipName', 'provider', 'destination', 'departurePort'];
      for (const f of text) {
        if (f === 'departurePort') {
          if (!portMetaMatchesFilter(meta.departurePort, meta.departurePortSimple, normalizedFilters[f])) return false;
        } else if (normalizedFilters[f] && !meta[f].includes(normalizedFilters[f])) {
          return false;
        }
      }
      if (normalizedFilters.destinationPort && !portMetaMatchesFilter(meta.destinationPort, meta.destinationPortSimple, normalizedFilters.destinationPort)) return false;
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
      if (!cruiseMatchesDepartureRange(c, colFilters.departureStart, colFilters.departureEnd)) return false;
      if (colFilters.minLaunch) {
        const min = parseInt(colFilters.minLaunch, 10);
        if (!isNaN(min) && (!c.shipLaunchYear || c.shipLaunchYear < min)) return false;
      }
      if (colFilters.duration) {
        const min = parseFloat(colFilters.duration);
        if (!isNaN(min) && (parseFloat(c.duration) || 0) < min) return false;
      }
      if (colFilters.seaDays) {
        const max = parseFloat(colFilters.seaDays);
        const seaDays = inferSeaDays(c);
        if (!isNaN(max) && (!Number.isFinite(seaDays) || seaDays > max)) return false;
      }
      if (colFilters.maxPrice) {
        const max = parseFloat(colFilters.maxPrice);
        const p   = getGBPPrice(c);
        if (!isNaN(max) && (isNaN(p) || p > max)) return false;
      }
      if (colFilters.priceDropWindow) {
        const windowMs = RECENT_WINDOW_MS[colFilters.priceDropWindow];
        const reduction = getRecentPriceReductionPct(c, windowMs);
        if (!Number.isFinite(reduction) || reduction <= 0) return false;
      }
      if (colFilters.newWithin) {
        const windowMs = RECENT_WINDOW_MS[colFilters.newWithin];
        if (!isFirstSeenWithin(c, windowMs)) return false;
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
    const filterSummary = selectedFilterSummary(colFilters);
    const filterSuffix = filterSummary ? ` · ${filterSummary}` : '';
    let summary;
    if (favoritesOnly) {
      const shown = capped.length < sorted.length
        ? `Showing first ${capped.length.toLocaleString()} of ${sorted.length.toLocaleString()} favorites`
        : `Showing ${sorted.length.toLocaleString()} ${sorted.length === 1 ? 'favorite' : 'favorites'}`;
      summary = `${shown}${filterSuffix} · <button type="button" class="show-all-btn" onclick="clearFavoritesView()">View all cruises</button>`;
    } else if (capped.length < sorted.length) {
      summary = `Showing first ${capped.length.toLocaleString()} of ${sorted.length.toLocaleString()} sailings${filterSuffix} · ${showAllLink}${sortHint}`;
    } else if (selectedCruiseId) {
      const cruise = cruiseById.get(selectedCruiseId);
      const label = cruise?.shipName ? escHtml(cruise.shipName) : 'shared cruise';
      summary = `Showing ${label} only · <button type="button" class="show-all-btn" onclick="clearSharedCruise()">View all cruises</button>`;
    } else if (filtered.length === allCruises.length) {
      summary = `Showing all ${allLabel} sailings${filterSuffix}${sortHint}`;
    } else {
      summary = `Showing ${filtered.length.toLocaleString()} of ${allLabel} sailings${filterSuffix}.`;
    }
    document.getElementById('summary').innerHTML = summary;
    syncStickySummary(capped.length, sorted.length, !favoritesOnly && filtered.length === allCruises.length);

    renderBody(capped, colFilters);
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
    const p = new URLSearchParams(serializeSearchState());
    if (favoritesOnly) p.set('favorites', '1');
    if (selectedCruiseId) p.set('cruise', selectedCruiseId);
    return p.toString();
  }

  function serializeSearchState() {
    const p = new URLSearchParams();
    if (sortColIndex >= 0) p.set('sort', `${sortColIndex}-${sortAsc ? 'asc' : 'desc'}`);
    if (showAll)           p.set('all', '1');
    if (!showInGbp)        p.set('gbp', '0');
    document.querySelectorAll('.col-filter').forEach(el => {
      if (el.value) p.set(el.dataset.field, el.value);
    });
    return p.toString();
  }

  function shareIcon() {
    return '<svg viewBox="0 0 20 20" fill="currentColor" aria-hidden="true"><path d="M14 6a3 3 0 1 0-2.83-4 3 3 0 0 0 .06 2.13L6.91 6.29a3 3 0 1 0 0 3.42l4.32 2.16A3 3 0 1 0 12.1 10l-4.32-2.16a3 3 0 0 0 0-.68l4.32-2.16A3 3 0 0 0 14 6Z"/></svg>';
  }

  function appUrlForHash(hash) {
    const url = new URL(window.location.pathname + window.location.search, window.location.href);
    url.hash = hash ? `#${hash}` : '';
    return url.href;
  }

  async function shareAppUrl({ title, text, url }) {
    if (navigator.share) {
      try {
        await navigator.share({ title, text, url });
        return;
      } catch (err) {
        if (err?.name === 'AbortError') return;
      }
    }
    try {
      await navigator.clipboard.writeText(url);
      showShareNotice('Link copied');
    } catch {
      window.prompt('Copy this link', url);
    }
  }

  function showShareNotice(message) {
    const notice = document.getElementById('shareNotice');
    if (!notice) return;
    notice.textContent = message;
    notice.classList.add('visible');
    clearTimeout(showShareNotice.timer);
    showShareNotice.timer = setTimeout(() => notice.classList.remove('visible'), 2200);
  }

  function shareCruise(cruiseId) {
    const cruise = cruiseById.get(cruiseId);
    if (!cruise) return;
    const hash = new URLSearchParams({ cruise: cruiseId }).toString();
    const details = [cruise.shipName, formatDateDisplay(cruise.departureDate), cruise.departurePort].filter(Boolean).join(' · ');
    shareAppUrl({ title: cruise.shipName || 'Cruise', text: details, url: appUrlForHash(hash) });
  }

  function addDaysIso(dateKey, days) {
    const d = new Date(`${dateKey}T00:00:00Z`);
    if (Number.isNaN(d.getTime())) return '';
    d.setUTCDate(d.getUTCDate() + days);
    return d.toISOString().slice(0, 10);
  }

  function durationNights(c) {
    const n = Number.parseInt(String(c?.duration || '').replace(/,/g, ''), 10);
    return Number.isFinite(n) && n > 0 ? n : null;
  }

  function followOnArrivalDateKey(c) {
    const explicit = cruiseDepartureDateKey(c?.arrivalDate);
    if (explicit) return explicit;
    const departure = cruiseDepartureDateKey(c?.departureDate);
    const nights = durationNights(c);
    return departure && nights ? addDaysIso(departure, nights) : '';
  }

  function followOnSearchHash(cruise) {
    const destinationPort = getDestinationPortDisplay(cruise);
    const arrival = followOnArrivalDateKey(cruise);
    if (!destinationPort || !arrival) return '';
    const departurePort = simplifyPortName(destinationPort) || destinationPort;
    return new URLSearchParams({
      departurePort,
      departureStart: arrival,
      departureEnd: addDaysIso(arrival, normalizeFollowOnDays(settings.followOnDays)),
    }).toString();
  }

  function openFollowOnSearch(cruiseId) {
    const cruise = cruiseById.get(cruiseId);
    const hash = cruise ? followOnSearchHash(cruise) : '';
    if (!hash) return;
    const opened = window.open(appUrlForHash(hash), '_blank', 'noopener');
    if (!opened) showShareNotice('Follow-on search opened');
  }

  function shareCurrentSearch() {
    shareAppUrl({
      title: 'Cruise search',
      text: 'Cruise search results',
      url: appUrlForHash(serializeSearchState()),
    });
  }

  function clearSharedCruise() {
    selectedCruiseId = '';
    try { history.replaceState(null, '', appUrlForHash(serializeSearchState())); } catch {}
    applyFilters();
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
    selectedCruiseId = '';
    favoritesOnly = false;
    if (!hash) return;
    const p = new URLSearchParams(hash);

    selectedCruiseId = p.get('cruise') || '';
    favoritesOnly = p.get('favorites') === '1';

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
    updateDepartureRangeControls();
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
  // Reads a single cabin bucket from a price-history entry.
  function entryPrice(entry, bucket) {
    const v = parseFloat(entry?.prices?.[bucket]);
    return Number.isFinite(v) ? v : null;
  }

  // Min across populated cabins for one entry — the "from" trend point.
  function entryMinPrice(entry) {
    if (!entry) return null;
    let min = Infinity;
    for (const b of PRICE_BUCKETS) {
      const v = parseFloat(entry.prices?.[b]);
      if (Number.isFinite(v) && v < min) min = v;
    }
    return min === Infinity ? null : min;
  }

  // Set of cabin buckets that appear in at least one entry.
  function historyBuckets(history) {
    const buckets = [];
    for (const b of PRICE_BUCKETS) {
      if (history.some(e => e?.prices && e.prices[b] != null)) buckets.push(b);
    }
    return buckets;
  }

  function historyEntryTime(entry) {
    const time = new Date(entry?.at || '').getTime();
    return Number.isFinite(time) ? time : NaN;
  }

  // Largest current cabin-price reduction within a recent time window.
  // Returns a positive percentage, or NaN when there is no comparable drop.
  function getRecentPriceReductionPct(c, windowMs, now = Date.now()) {
    if (!Number.isFinite(windowMs) || windowMs <= 0) return NaN;
    const history = Array.isArray(c?.priceHistory) ? c.priceHistory : [];
    const timed = history
      .map(entry => ({ entry, time: historyEntryTime(entry) }))
      .filter(point => Number.isFinite(point.time) && point.time <= now)
      .sort((a, b) => a.time - b.time);
    if (timed.length < 2) return NaN;

    const cutoff = now - windowMs;
    const buckets = historyBuckets(history);
    const getters = buckets.map(bucket => entry => entryPrice(entry, bucket));
    let largestReduction = NaN;

    for (const getPrice of getters) {
      const points = timed
        .map(point => ({ ...point, price: getPrice(point.entry) }))
        .filter(point => Number.isFinite(point.price));
      if (points.length < 2) continue;

      const latest = points[points.length - 1];
      if (latest.time < cutoff) continue;

      const beforeCutoff = points.filter(point => point.time <= cutoff && point.time < latest.time);
      const insideWindow = points.filter(point => point.time >= cutoff && point.time < latest.time);
      const baseline = beforeCutoff[beforeCutoff.length - 1] || insideWindow[0];
      if (!baseline || baseline.price <= 0 || latest.price >= baseline.price) continue;

      const reduction = ((baseline.price - latest.price) / baseline.price) * 100;
      if (!Number.isFinite(largestReduction) || reduction > largestReduction) {
        largestReduction = reduction;
      }
    }

    return largestReduction;
  }

  function isFirstSeenWithin(c, windowMs, now = Date.now()) {
    if (!Number.isFinite(windowMs) || windowMs <= 0) return false;
    const firstSeen = getFirstSeenTime(c);
    return Number.isFinite(firstSeen) && firstSeen <= now && firstSeen >= now - windowMs;
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

  function getFirstSeenRaw(c) {
    if (c?.firstSeenAt) return c.firstSeenAt;
    const history = Array.isArray(c?.priceHistory) ? c.priceHistory : [];
    const earliest = history
      .map(entry => entry?.at)
      .filter(Boolean)
      .sort()[0];
    return earliest || c?.scrapedAt || c?.lastSeenAt || '';
  }

  function getFirstSeenTime(c) {
    const raw = getFirstSeenRaw(c);
    if (!raw) return NaN;
    const d = new Date(raw);
    return Number.isNaN(d.getTime()) ? NaN : d.getTime();
  }

  function formatFirstSeenDisplay(c) {
    const raw = getFirstSeenRaw(c);
    if (!raw) return '—';
    const d = new Date(raw);
    if (Number.isNaN(d.getTime())) return formatDateDisplay(raw);
    return d.toLocaleString('en-GB', {
      day: 'numeric',
      month: 'short',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      timeZone: 'UTC',
      timeZoneName: 'short',
    });
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
