'use strict';

(function () {
  const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

  // Parse YYYY-MM-DD as a local calendar date (no timezone shifting).
  function parseDate(iso) {
    const [y, m, d] = String(iso).split('-').map(Number);
    return new Date(y, m - 1, d);
  }

  function startOfDay(date) {
    return new Date(date.getFullYear(), date.getMonth(), date.getDate());
  }

  function formatDate(iso, { weekday = false, year = true } = {}) {
    const d = parseDate(iso);
    const parts = [];
    if (weekday) parts.push(DAYS[d.getDay()]);
    parts.push(`${d.getDate()} ${MONTHS[d.getMonth()]}`);
    if (year) parts.push(String(d.getFullYear()));
    return parts.join(' ');
  }

  function seasonStatus(season, now) {
    const today = startOfDay(now);
    const opens = parseDate(season.opens);
    const closes = parseDate(season.closes);
    if (today < opens) {
      return { state: 'before', text: `The green is closed for the winter. The ${season.year} season opens on ${formatDate(season.opens, { weekday: true })}. Winter social events continue in the clubhouse.` };
    }
    if (today > closes) {
      return { state: 'after', text: `The ${season.year} outdoor season has finished. Thank you to everyone who played. Watch this space for next season's dates.` };
    }
    return { state: 'open', text: `The green is open for the ${season.year} season until ${formatDate(season.closes, { weekday: true })}. New bowlers welcome every week.` };
  }

  function filterFixtures(fixtures, type) {
    const sorted = fixtures.slice().sort((a, b) => a.date.localeCompare(b.date));
    return type && type !== 'all' ? sorted.filter(f => f.type === type) : sorted;
  }

  function isValidEmail(value) {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value).trim());
  }

  const helpers = { parseDate, formatDate, seasonStatus, filterFixtures, isValidEmail };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = helpers;
    return;
  }

  // ---------- Browser rendering ----------

  const data = window.CLUB_DATA;
  const now = window.__CLUB_NOW__ ? new Date(window.__CLUB_NOW__) : new Date();

  function el(tag, attrs, ...children) {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(attrs || {})) {
      if (key === 'class') node.className = value;
      else node.setAttribute(key, value);
    }
    for (const child of children) {
      if (child == null) continue;
      node.append(child instanceof Node ? child : document.createTextNode(String(child)));
    }
    return node;
  }

  function renderSeason() {
    const status = seasonStatus(data.season, now);
    const target = document.getElementById('season-status');
    target.textContent = status.text;
    target.parentElement.parentElement.dataset.state = status.state;
  }

  function renderOpenDays() {
    const list = document.getElementById('open-days-list');
    const today = startOfDay(now);
    const upcoming = data.openDays.filter(d => parseDate(d.date) >= today);
    if (!upcoming.length) {
      list.append(el('li', { class: 'date-empty' }, 'New open days will be announced soon. Get in touch to arrange a taster any time.'));
      return;
    }
    for (const day of upcoming) {
      const d = parseDate(day.date);
      list.append(el('li', {},
        el('span', { class: 'date-chip' },
          el('span', { class: 'date-chip-day' }, d.getDate()),
          el('span', { class: 'date-chip-month' }, MONTHS[d.getMonth()].slice(0, 3))),
        el('span', { class: 'date-body' },
          el('strong', {}, `${formatDate(day.date, { weekday: true, year: false })}, ${day.time}`),
          el('span', {}, day.note)),
      ));
    }
  }

  function renderPrices() {
    const grid = document.getElementById('price-grid');
    for (const p of data.prices) {
      grid.append(el('article', { class: p.featured ? 'price-card featured' : 'price-card' },
        p.featured ? el('span', { class: 'price-badge' }, 'Most popular') : null,
        el('h3', {}, p.name),
        el('p', { class: 'price' }, p.price, el('span', {}, ` ${p.period}`)),
        el('p', {}, p.detail),
      ));
    }
  }

  function renderFixtures(type) {
    const body = document.getElementById('fixtures-body');
    const today = startOfDay(now);
    const rows = filterFixtures(data.fixtures, type);
    body.replaceChildren(...rows.map(f => {
      const played = parseDate(f.date) < today;
      return el('tr', { class: played ? 'is-played' : '' },
        el('td', { 'data-label': 'Date' }, formatDate(f.date, { weekday: true, year: false })),
        el('td', { 'data-label': 'Opponent / event' }, f.opponent, played ? el('span', { class: 'played-tag' }, 'Played') : null),
        el('td', { 'data-label': 'Type' }, el('span', { class: `type-tag type-${f.type.toLowerCase()}` }, f.type)),
        el('td', { 'data-label': 'Venue' }, f.venue),
        el('td', { 'data-label': 'Start' }, f.time),
      );
    }));
    document.getElementById('fixture-count').textContent = `${rows.length} ${rows.length === 1 ? 'fixture' : 'fixtures'} in ${data.season.year}`;
  }

  function renderNews() {
    const grid = document.getElementById('news-grid');
    const items = data.news.slice().sort((a, b) => b.date.localeCompare(a.date));
    for (const n of items) {
      grid.append(el('article', { class: 'news-card' },
        el('time', { datetime: n.date }, formatDate(n.date)),
        el('h3', {}, n.title),
        el('p', {}, n.body),
      ));
    }
  }

  function renderChanges() {
    const list = document.getElementById('changes-list');
    for (const c of data.siteChanges) {
      list.append(el('li', {},
        el('time', { datetime: c.date }, formatDate(c.date)),
        el('h3', {}, c.title),
        el('ul', {}, ...c.items.map(i => el('li', {}, i))),
      ));
    }
  }

  function setupNav() {
    const toggle = document.querySelector('.nav-toggle');
    const nav = document.getElementById('site-nav');
    const setOpen = open => {
      toggle.setAttribute('aria-expanded', String(open));
      nav.classList.toggle('is-open', open);
      toggle.querySelector('.nav-toggle-label').textContent = open ? 'Close' : 'Menu';
    };
    toggle.addEventListener('click', () => setOpen(toggle.getAttribute('aria-expanded') !== 'true'));
    nav.addEventListener('click', e => { if (e.target.closest('a')) setOpen(false); });
    document.addEventListener('keydown', e => { if (e.key === 'Escape') setOpen(false); });
  }

  function setupForm() {
    const form = document.getElementById('contact-form');
    const error = document.getElementById('form-error');
    const success = document.getElementById('form-success');
    form.addEventListener('submit', e => {
      e.preventDefault();
      const name = form.elements.name.value.trim();
      const email = form.elements.email.value.trim();
      const topic = form.elements.topic.value;
      const message = form.elements.message.value.trim();
      const problems = [];
      if (!name) problems.push('your name');
      if (!isValidEmail(email)) problems.push('a valid email address');
      if (!message) problems.push('a message');
      success.hidden = true;
      if (problems.length) {
        error.textContent = `Please add ${problems.join(', ')}.`;
        error.hidden = false;
        return;
      }
      error.hidden = true;
      const subject = encodeURIComponent(`${topic} – from ${name}`);
      const body = encodeURIComponent(`${message}\n\nFrom: ${name} <${email}>`);
      success.textContent = `Thanks, ${name}. Your email app should open with the message ready to send.`;
      success.hidden = false;
      window.location.href = `mailto:${data.contactEmail}?subject=${subject}&body=${body}`;
    });
  }

  renderSeason();
  renderOpenDays();
  renderPrices();
  renderFixtures('all');
  renderNews();
  renderChanges();
  setupNav();
  setupForm();
  document.getElementById('fixture-filter').addEventListener('change', e => renderFixtures(e.target.value));
}());
