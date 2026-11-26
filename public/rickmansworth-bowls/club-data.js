'use strict';

// Everything the club is likely to update during the year lives in this one
// file: season dates, prices, fixtures, news and the "What's changed" list.
// Edit the values below and the page updates itself; no other file needs to
// change. Dates use YYYY-MM-DD.
//
// NOTE: prices, fixtures, open days, news and the contact address below are
// starter content. Replace them with the club's confirmed details before
// publishing.

window.CLUB_DATA = {
  // Where the contact form sends messages (opens the visitor's email app).
  contactEmail: 'secretary@example.org',

  season: {
    year: 2027,
    opens: '2027-04-24',
    closes: '2027-09-25',
  },

  openDays: [
    { date: '2027-05-01', time: '1:00pm – 4:00pm', note: 'Season launch open day. Coaching on the green, tea and cake in the clubhouse.' },
    { date: '2027-05-30', time: '10:00am – 1:00pm', note: 'National Bowls Week taster morning. Families welcome.' },
    { date: '2027-06-26', time: '2:00pm – 5:00pm', note: 'Summer open afternoon with a friendly beginners’ drive.' },
  ],

  prices: [
    { name: 'Full playing member', price: '£120', period: 'per season', detail: 'Unlimited play, competitions and league selection.', featured: true },
    { name: 'First-year member', price: '£60', period: 'first season', detail: 'Half price for new bowlers, including coaching and loan woods.' },
    { name: 'Under 25s', price: '£30', period: 'per season', detail: 'Full playing membership for young bowlers and students.' },
    { name: 'Social member', price: '£20', period: 'per season', detail: 'Clubhouse and social events, plus occasional roll-ups.' },
  ],

  // type is one of: League, Friendly, Club
  fixtures: [
    { date: '2027-04-24', opponent: 'Opening day: President v Captain', type: 'Club', venue: 'Home', time: '2:00pm' },
    { date: '2027-05-04', opponent: 'Croxley Green', type: 'Friendly', venue: 'Away', time: '2:30pm' },
    { date: '2027-05-08', opponent: 'Chorleywood', type: 'League', venue: 'Home', time: '2:30pm' },
    { date: '2027-05-15', opponent: 'Watford West', type: 'League', venue: 'Away', time: '2:30pm' },
    { date: '2027-05-22', opponent: 'Club pairs (rounds 1–2)', type: 'Club', venue: 'Home', time: '10:00am' },
    { date: '2027-06-05', opponent: 'Harefield', type: 'Friendly', venue: 'Home', time: '2:30pm' },
    { date: '2027-06-12', opponent: 'Abbots Langley', type: 'League', venue: 'Home', time: '2:30pm' },
    { date: '2027-06-19', opponent: 'Bushey', type: 'League', venue: 'Away', time: '2:30pm' },
    { date: '2027-07-03', opponent: 'Summer barbecue & mixed triples', type: 'Club', venue: 'Home', time: '12:00pm' },
    { date: '2027-07-10', opponent: 'Kings Langley', type: 'Friendly', venue: 'Away', time: '2:30pm' },
    { date: '2027-07-24', opponent: 'Northwood', type: 'League', venue: 'Home', time: '2:30pm' },
    { date: '2027-08-07', opponent: 'Sarratt', type: 'Friendly', venue: 'Home', time: '2:30pm' },
    { date: '2027-08-28', opponent: 'Club championship finals day', type: 'Club', venue: 'Home', time: '10:00am' },
    { date: '2027-09-25', opponent: 'Closing day & presentation', type: 'Club', venue: 'Home', time: '2:00pm' },
  ],

  news: [
    { date: '2026-11-20', title: 'Winter social programme announced', body: 'Quiz nights, a Christmas lunch and short-mat sessions will keep members busy until the green reopens in April.' },
    { date: '2026-10-04', title: 'A season to remember', body: 'Congratulations to everyone who reached club finals this year, and thank you to the green-keeping team for a superb surface all summer.' },
    { date: '2026-09-12', title: 'New members welcomed', body: 'Several first-year bowlers joined after the summer open days. Two of them have already made their league debuts.' },
  ],

  // Newest first. Shown in the "What's changed" section at the bottom of the page.
  siteChanges: [
    {
      date: '2026-11-26',
      title: 'New club website',
      items: [
        'A new mobile-friendly site with free taster information, membership prices, a filterable fixture list, club news, directions and a contact form.',
      ],
    },
  ],
};
