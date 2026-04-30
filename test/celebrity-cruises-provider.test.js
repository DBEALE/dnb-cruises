'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const provider = require('../providers/celebrity-cruises');

const SAMPLE_HTML = `
<!doctype html>
<html>
  <body>
    <div data-testid="cruise-card-container_BY07MIA-56550375" data-group-id="BY07MIA-56550375" data-package-code="BY07E468" data-ship-code="BY" data-destination-code="MIA" data-sail-date="2026-08-30" data-start-date="2026-08-30" data-end-date="2026-09-06" data-first-sail-date="2026-07-05" data-last-sail-date="2026-10-25" data-product-view-link="itinerary/7-nt-tortola-st-maarten-puerto-plata-from-miami-on-celebrity-BY07E468?sailDate=2026-08-30&packageCode=BY07E468&groupId=BY07MIA-56550375&country=GBR">
      <h3 data-testid="cruise-duration-label-BY07MIA-56550375">7 Nights</h3>
      <h4 data-testid="cruise-name-label-BY07MIA-56550375">Tortola, St. Maarten &amp; Puerto Plata</h4>
      <div data-testid="cruise-ship-label-BY07MIA-56550375">Celebrity Beyond</div>
      <div data-testid="cruise-roundtrip-label-BY07MIA-56550375">Roundtrip from:Miami, Florida</div>
      <div data-testid="cruise-ports-label-BY07MIA-56550375">Cruise ports:Miami, FloridaPuerto Plata, Dominican RepublicTortola, BVIPhilipsburg, St. MaartenMiami, Florida</div>
      <div data-testid="cruise-price-avg-label-BY07MIA-56550375">AVG PER PERSON*</div>
      <div data-testid="cruise-price-label-BY07MIA-56550375">£489</div>
      <a data-testid="cruise-view-itinerary-button-BY07MIA-56550375" href="itinerary/7-nt-tortola-st-maarten-puerto-plata-from-miami-on-celebrity-BY07E468?sailDate=2026-08-30&packageCode=BY07E468&groupId=BY07MIA-56550375&country=GBR">View itinerary</a>
    </div>
    <div data-testid="cruise-card-container_AT11ROM-3426966074" data-group-id="AT11ROM-3426966074" data-package-code="AT11M295" data-ship-code="AT" data-destination-code="ROM" data-sail-date="2026-05-04" data-start-date="2026-05-04" data-end-date="2026-05-15" data-first-sail-date="2026-05-04" data-last-sail-date="2026-05-25" data-product-view-link="itinerary/11-night-greece-turkey-italy-cruise-from-rome-civitavecchia-on-celebrity-AT11M295?sailDate=2026-05-04&packageCode=AT11M295&groupId=AT11ROM-3426966074&country=GBR">
      <h3 data-testid="cruise-duration-label-AT11ROM-3426966074">11 Nights</h3>
      <h4 data-testid="cruise-name-label-AT11ROM-3426966074">Greece, Turkey &amp; Italy</h4>
      <div data-testid="cruise-ship-label-AT11ROM-3426966074">Celebrity Ascent</div>
      <div data-testid="cruise-roundtrip-label-AT11ROM-3426966074">Roundtrip from:Rome (Civitavecchia), Italy</div>
      <div data-testid="cruise-price-label-AT11ROM-3426966074">£969</div>
      <a data-testid="cruise-view-itinerary-button-AT11ROM-3426966074" href="itinerary/11-night-greece-turkey-italy-cruise-from-rome-civitavecchia-on-celebrity-AT11M295?sailDate=2026-05-04&packageCode=AT11M295&groupId=AT11ROM-3426966074&country=GBR">View itinerary</a>
    </div>
    <div data-testid="cruise-card-container_FL07GPS-1234567890" data-group-id="FL07GPS-1234567890" data-package-code="FL07G001" data-ship-code="FL" data-destination-code="GPS" data-sail-date="2026-04-20" data-start-date="2026-04-20" data-end-date="2026-04-27" data-first-sail-date="2026-04-20" data-last-sail-date="2026-04-27" data-product-view-link="itinerary/7-night-galapagos-cruise-on-celebrity-FL07G001?sailDate=2026-04-20&packageCode=FL07G001&groupId=FL07GPS-1234567890&country=GBR">
      <h3 data-testid="cruise-duration-label-FL07GPS-1234567890">7 Nights</h3>
      <h4 data-testid="cruise-name-label-FL07GPS-1234567890">Galapagos Islands</h4>
      <div data-testid="cruise-ship-label-FL07GPS-1234567890">Celebrity Flora</div>
      <div data-testid="cruise-roundtrip-label-FL07GPS-1234567890">Roundtrip from:Baltra, Galapagos</div>
      <div data-testid="cruise-price-label-FL07GPS-1234567890">£4999</div>
      <a data-testid="cruise-view-itinerary-button-FL07GPS-1234567890" href="itinerary/7-night-galapagos-cruise-on-celebrity-FL07G001?sailDate=2026-04-20&packageCode=FL07G001&groupId=FL07GPS-1234567890&country=GBR">View itinerary</a>
    </div>
  </body>
</html>`;

test('parses Celebrity Cruises cards from rendered HTML', () => {
  const cruises = provider.parseCruisesFromHtml(SAMPLE_HTML);

  assert.equal(cruises.length, 3);
  assert.deepEqual(cruises[0], {
    provider: 'Celebrity Cruises',
    id: 'celebrity_BY07MIA-56550375',
    shipName: 'Celebrity Beyond',
    shipClass: 'Edge',
    shipLaunchYear: 2022,
    itinerary: 'Tortola, St. Maarten & Puerto Plata',
    departureDate: '2026-08-30',
    duration: '7 Nights',
    departurePort: 'Miami, Florida',
    departureRegion: 'Americas',
    destination: 'Tortola, St. Maarten & Puerto Plata',
    priceFrom: '489',
    currency: 'GBP',
    bookingUrl: 'https://www.celebritycruises.com/gb/itinerary/7-nt-tortola-st-maarten-puerto-plata-from-miami-on-celebrity-BY07E468?sailDate=2026-08-30&packageCode=BY07E468&groupId=BY07MIA-56550375&country=GBR',
  });
  assert.equal(cruises[1].shipName, 'Celebrity Ascent');
  assert.equal(cruises[1].departurePort, 'Rome (Civitavecchia), Italy');
  assert.equal(cruises[1].priceFrom, '969');
  assert.equal(cruises[1].shipLaunchYear, 2023);
  assert.equal(cruises[2].shipName, 'Celebrity Flora');
  assert.equal(cruises[2].shipClass, 'Galapagos');
  assert.equal(cruises[2].shipLaunchYear, 2019);
});

test('fetchCruises downloads and parses the Celebrity page', async () => {
  const originalFetch = global.fetch;
  const requests = [];
  global.fetch = async (url, options = {}) => {
    // Stub room-selection API calls that arise from itinerary enrichment
    if (String(url).startsWith('https://www.celebritycruises.com/room-selection/api/v1/rooms')) {
      return { ok: true, status: 200, json: async () => ({}) };
    }

    requests.push({ url, options });
    const body = JSON.parse(options.body);
    const skip = body.variables.pagination.skip;

    if (skip === 0) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          data: {
            cruiseSearch: {
              results: {
                total: 3,
                cruises: [
                  {
                    id: 'BY07MIA-56550375',
                    productViewLink: 'itinerary/7-nt-tortola-st-maarten-puerto-plata-from-miami-on-celebrity-BY07E468?sailDate=2026-08-30&packageCode=BY07E468&groupId=BY07MIA-56550375&country=GBR',
                    lowestPriceSailing: {
                      bookingLink: '/booking-cruise/selectRoom/stateroomQuantity?groupId=BY07MIA-56550375&pID=BY07E468&sDT=2026-08-30&sCD=BY&sCT=CO&country=GBR',
                      sailDate: '2026-08-30',
                      lowestStateroomClassPrice: {
                        price: {
                          value: 489,
                          currency: { code: 'GBP' },
                        },
                      },
                    },
                    masterSailing: {
                      itinerary: {
                        name: 'Tortola, St. Maarten & Puerto Plata',
                        totalNights: 7,
                        departurePort: { name: 'Miami, Florida' },
                        destination: { name: 'Tortola, St. Maarten & Puerto Plata' },
                        ship: { name: 'Celebrity Beyond', code: 'BY' },
                      },
                    },
                  },
                  {
                    id: 'AT11ROM-3426966074',
                    productViewLink: 'itinerary/11-night-greece-turkey-italy-cruise-from-rome-civitavecchia-on-celebrity-AT11M295?sailDate=2026-05-04&packageCode=AT11M295&groupId=AT11ROM-3426966074&country=GBR',
                    displaySailing: {
                      bookingLink: '/booking-cruise/selectRoom/stateroomQuantity?groupId=AT11ROM-3426966074&pID=AT11M295&sDT=2026-05-04&sCD=AT&sCT=CO&country=GBR',
                      sailDate: '2026-05-04',
                      lowestStateroomClassPrice: {
                        price: {
                          value: 969,
                          currency: { code: 'GBP' },
                        },
                      },
                    },
                    masterSailing: {
                      itinerary: {
                        name: 'Greece, Turkey & Italy',
                        totalNights: 11,
                        departurePort: { name: 'Rome (Civitavecchia), Italy' },
                        destination: { name: 'Greece, Turkey & Italy' },
                        ship: { name: 'Celebrity Ascent', code: 'AT' },
                      },
                    },
                  },
                ],
              },
            },
          },
        }),
      };
    }

    if (skip === 2) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          data: {
            cruiseSearch: {
              results: {
                total: 3,
                cruises: [
                  {
                    id: 'SL07YVR-1077280133',
                    productViewLink: 'itinerary/7-night-alaska-northbound-glacier-from-vancouver-on-celebrity-SL07A441?sailDate=2027-05-07&packageCode=SL07A441&groupId=SL07YVR-1077280133&country=GBR',
                    lowestPriceSailing: {
                      bookingLink: '/booking-cruise/selectRoom/stateroomQuantity?groupId=SL07YVR-1077280133&pID=SL07A441&sDT=2027-05-07&sCD=SL&sCT=CO&country=GBR',
                      sailDate: '2027-05-07',
                      lowestStateroomClassPrice: {
                        price: {
                          value: 632,
                          currency: { code: 'GBP' },
                        },
                      },
                    },
                    masterSailing: {
                      itinerary: {
                        name: 'Alaska Northbound Glacier',
                        totalNights: 7,
                        departurePort: { name: 'Vancouver, British Columbia' },
                        destination: { name: 'Alaska Northbound Glacier' },
                        ship: { name: 'Celebrity Solstice', code: 'SL' },
                      },
                    },
                  },
                ],
              },
            },
          },
        }),
      };
    }

    throw new Error(`Unexpected skip value: ${skip}`);
  };

  try {
    const cruises = await provider.fetchCruises();
    assert.equal(cruises.length, 3);
    assert.equal(requests.length, 2);
    assert.equal(cruises[0].provider, 'Celebrity Cruises');
    assert.equal(cruises[0].bookingUrl, 'https://www.celebritycruises.com/booking-cruise/selectRoom/stateroomQuantity?groupId=BY07MIA-56550375&pID=BY07E468&sDT=2026-08-30&sCD=BY&sCT=CO&country=GBR');
    assert.equal(cruises[1].departurePort, 'Rome (Civitavecchia), Italy');
    assert.equal(cruises[1].duration, '11 Nights');
    assert.equal(cruises[2].shipName, 'Celebrity Solstice');
  } finally {
    global.fetch = originalFetch;
  }
});

// ─── Itinerary enrichment helpers ─────────────────────────────────────────────

const SAMPLE_CHAPTERS = [
  { days: [1], port: { name: 'Miami', region: 'Florida' } },
  { days: [2], port: { name: 'Cruising', region: '' } },
  { days: [3], port: { name: 'Tortola', region: 'BVI' } },
  { days: [4], port: { name: 'Philipsburg', region: 'St. Maarten' } },
  { days: [5], port: { name: 'Puerto Plata', region: 'Dominican Republic' } },
];

test('extractPortSequenceFromChapters reads ports from chapter objects', () => {
  assert.deepEqual(provider.extractPortSequenceFromChapters(SAMPLE_CHAPTERS), [
    'Miami, Florida',
    'Cruising',
    'Tortola, BVI',
    'Philipsburg, St. Maarten',
    'Puerto Plata, Dominican Republic',
  ]);
});

test('buildDetailedItinerary appends non-cruising stops after the summary name', () => {
  assert.equal(
    provider.buildDetailedItinerary('Tortola, St. Maarten & Puerto Plata', [
      'Miami, Florida',
      'Cruising',
      'Tortola, BVI',
      'Philipsburg, St. Maarten',
      'Puerto Plata, Dominican Republic',
      'Miami, Florida',
    ]),
    'Tortola, St. Maarten & Puerto Plata: Tortola, BVI, Philipsburg, St. Maarten, Puerto Plata, Dominican Republic',
  );
});

test('buildDetailedItinerary returns summary name unchanged when no ports are supplied', () => {
  assert.equal(
    provider.buildDetailedItinerary('Best of Greece', []),
    'Best of Greece',
  );
});

test('parseBookingContext extracts fields from a /booking-cruise/ URL (pID / sDT params)', () => {
  assert.deepEqual(
    provider.parseBookingContext(
      'https://www.celebritycruises.com/booking-cruise/selectRoom/stateroomQuantity?groupId=BY07MIA-56550375&pID=BY07E468&sDT=2026-08-30&sCD=BY&sCT=CO&country=GBR',
    ),
    {
      packageCode:           'BY07E468',
      sailDate:              '2026-08-30',
      selectedCurrencyCode:  'GBP',
      country:               'GBR',
    },
  );
});

test('parseBookingContext extracts fields from a /gb/itinerary/ URL (packageCode / sailDate params)', () => {
  assert.deepEqual(
    provider.parseBookingContext(
      'https://www.celebritycruises.com/gb/itinerary/7-nt-tortola-st-maarten-puerto-plata-from-miami-on-celebrity-BY07E468?sailDate=2026-08-30&packageCode=BY07E468&groupId=BY07MIA-56550375&country=GBR',
    ),
    {
      packageCode:           'BY07E468',
      sailDate:              '2026-08-30',
      selectedCurrencyCode:  'GBP',
      country:               'GBR',
    },
  );
});

test('fetchCruises enriches itinerary with port sequence from room-selection API', async () => {
  const originalFetch = global.fetch;

  global.fetch = async (url, options = {}) => {
    const urlStr = String(url);

    if (urlStr.startsWith('https://www.celebritycruises.com/room-selection/api/v1/rooms')) {
      const params      = new URL(urlStr).searchParams;
      const filter      = JSON.parse(params.get('filter') || '{}');
      const packageCode = filter.packageId;

      if (packageCode === 'BY07E468') {
        return {
          ok: true, status: 200,
          json: async () => ({
            sailing: {
              itinerary: {
                chapters: [
                  { port: { name: 'Miami', region: 'Florida' } },
                  { port: { name: 'Tortola', region: 'BVI' } },
                  { port: { name: 'Philipsburg', region: 'St. Maarten' } },
                  { port: { name: 'Puerto Plata', region: 'Dominican Republic' } },
                ],
              },
            },
          }),
        };
      }

      return { ok: true, status: 200, json: async () => ({}) };
    }

    // GraphQL
    const body = JSON.parse(options.body);
    const skip = body.variables.pagination.skip;

    if (skip === 0) {
      return {
        ok: true, status: 200,
        json: async () => ({
          data: {
            cruiseSearch: {
              results: {
                total: 1,
                cruises: [
                  {
                    id: 'BY07MIA-56550375',
                    productViewLink: 'itinerary/7-nt-tortola-st-maarten-puerto-plata-from-miami-on-celebrity-BY07E468?sailDate=2026-08-30&packageCode=BY07E468&groupId=BY07MIA-56550375&country=GBR',
                    lowestPriceSailing: {
                      bookingLink: '/booking-cruise/selectRoom/stateroomQuantity?groupId=BY07MIA-56550375&pID=BY07E468&sDT=2026-08-30&sCD=BY&sCT=CO&country=GBR',
                      sailDate: '2026-08-30',
                      lowestStateroomClassPrice: { price: { value: 489, currency: { code: 'GBP' } } },
                    },
                    masterSailing: {
                      itinerary: {
                        name: 'Tortola, St. Maarten & Puerto Plata',
                        totalNights: 7,
                        departurePort: { name: 'Miami, Florida' },
                        destination: { name: 'Tortola, St. Maarten & Puerto Plata' },
                        ship: { name: 'Celebrity Beyond', code: 'BY' },
                      },
                    },
                  },
                ],
              },
            },
          },
        }),
      };
    }

    throw new Error(`Unexpected skip: ${skip}`);
  };

  try {
    const cruises = await provider.fetchCruises();
    assert.equal(cruises.length, 1);
    assert.equal(
      cruises[0].itinerary,
      'Tortola, St. Maarten & Puerto Plata: Tortola, BVI, Philipsburg, St. Maarten, Puerto Plata, Dominican Republic',
    );
  } finally {
    global.fetch = originalFetch;
  }
});