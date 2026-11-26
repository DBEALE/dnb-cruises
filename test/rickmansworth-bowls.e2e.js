'use strict';

const { test, expect } = require('@playwright/test');

const URL = '/rickmansworth-bowls/';

test.beforeEach(async ({ page }) => {
  // Pin "today" so season and played-fixture states are deterministic.
  await page.addInitScript(() => { window.__CLUB_NOW__ = '2026-11-26T12:00:00'; });
});

test('desktop: shows club content, fixtures filter and what\'s changed', async ({ page }) => {
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.goto(URL);

  await expect(page).toHaveTitle('Rickmansworth Bowls Club');
  await expect(page.locator('.nav-toggle')).toBeHidden();
  await expect(page.locator('#site-nav')).toBeVisible();
  await expect(page.locator('#season-status')).toContainText('2027 season opens on Saturday 24 April 2027');
  await expect(page.locator('#open-days-list li')).toHaveCount(3);
  await expect(page.locator('.price-card')).toHaveCount(4);
  await expect(page.locator('.news-card').first()).toContainText('Winter social programme');
  await expect(page.locator('#changes-list')).toContainText('New club website');

  const rows = page.locator('#fixtures-body tr');
  await expect(rows).toHaveCount(14);
  await page.selectOption('#fixture-filter', 'League');
  await expect(rows).toHaveCount(5);
  await expect(page.locator('#fixture-count')).toHaveText('5 fixtures in 2027');
  for (const tag of await page.locator('#fixtures-body .type-tag').allTextContents()) expect(tag).toBe('League');

  expect(errors).toEqual([]);
});

test('contact form validates before opening email', async ({ page }) => {
  await page.goto(URL);
  await page.click('#contact-form button[type=submit]');
  await expect(page.locator('#form-error')).toHaveText('Please add your name, a valid email address, a message.');
  await expect(page.locator('#form-success')).toBeHidden();
});

test.describe('mobile', () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test('menu toggles, fixtures stack as cards, no horizontal scroll', async ({ page }) => {
    await page.goto(URL);
    const toggle = page.locator('.nav-toggle');
    const nav = page.locator('#site-nav');
    await expect(toggle).toBeVisible();
    await expect(nav).toBeHidden();
    await toggle.click();
    await expect(nav).toBeVisible();
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
    await nav.getByRole('link', { name: 'Fixtures' }).click();
    await expect(nav).toBeHidden();

    await expect(page.locator('.fixtures thead')).toHaveCSS('position', 'absolute');
    await expect(page.locator('#fixtures-body tr').first()).toHaveCSS('display', 'block');

    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow).toBeLessThanOrEqual(0);
  });
});
