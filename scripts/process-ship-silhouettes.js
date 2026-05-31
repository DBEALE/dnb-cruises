'use strict';

/**
 * process-ship-silhouettes.js
 *
 * Reads a source PNG containing 4 cruise-ship silhouettes drawn in dark on a
 * (visually) checkerboarded background — extracts each silhouette into its
 * own true-transparent PNG in public/img/, ready to drive CSS mask-image.
 *
 * The source PNG from Gemini has alpha=255 everywhere (the checkerboard is
 * drawn pixels, not actual transparency), so we detect silhouettes by pixel
 * brightness: anything dark = silhouette → emit as opaque black, anything
 * light = background → emit as fully transparent. A soft threshold gives
 * clean anti-aliased edges.
 */

const path = require('node:path');
const fs   = require('node:fs');
const { Jimp } = require('jimp');

const TIERS    = ['mega', 'large', 'medium', 'small'];
const OUT_DIR  = path.join(__dirname, '..', 'public', 'img');
const DARK_FULL  = 30;        // brightness ≤ this → fully opaque silhouette
const DARK_EDGE  = 120;       // brightness ≥ this → fully transparent
const COL_DARK_MIN = 3;       // ≥ N dark px in a column = part of a ship
const ROW_DARK_MIN = 8;       // ≥ N dark px in a row = ship band
const GAP_MIN    = 25;        // ≥ N empty columns between two ships

function brightness(buf, i) { return (buf[i] + buf[i + 1] + buf[i + 2]) / 3; }
function isDark(buf, i)     { return brightness(buf, i) < DARK_FULL + 10; }

function darkInRow(img, y) {
  const w = img.bitmap.width, buf = img.bitmap.data;
  let n = 0;
  for (let x = 0; x < w; x++) if (isDark(buf, (y * w + x) * 4)) n++;
  return n;
}
function darkInColRange(img, x, y0, y1) {
  const w = img.bitmap.width, buf = img.bitmap.data;
  let n = 0;
  for (let y = y0; y < y1; y++) if (isDark(buf, (y * w + x) * 4)) n++;
  return n;
}

// Find the tallest band of rows containing dark pixels (= silhouette band).
function findShipBand(img) {
  const h = img.bitmap.height;
  const bands = [];
  let inBand = false, start = 0;
  for (let y = 0; y < h; y++) {
    const inside = darkInRow(img, y) >= ROW_DARK_MIN;
    if (inside && !inBand) { inBand = true; start = y; }
    else if (!inside && inBand) { inBand = false; bands.push([start, y]); }
  }
  if (inBand) bands.push([start, h]);
  if (!bands.length) throw new Error('No dark rows found in source image.');
  bands.sort((a, b) => (b[1] - b[0]) - (a[1] - a[0]));
  return bands[0];
}

// Walk columns in the silhouette band, split into N ships by transparent gaps.
function findShipColumns(img, [y0, y1]) {
  const w = img.bitmap.width;
  const ships = [];
  let inShip = false, startX = 0, gap = 0;
  for (let x = 0; x < w; x++) {
    const opaque = darkInColRange(img, x, y0, y1) >= COL_DARK_MIN;
    if (opaque) {
      if (!inShip) { inShip = true; startX = x; }
      gap = 0;
    } else if (inShip) {
      gap++;
      if (gap >= GAP_MIN) {
        ships.push([startX, x - gap]);
        inShip = false; gap = 0;
      }
    }
  }
  if (inShip) ships.push([startX, w]);
  return ships;
}

// Returns [topY, bottomY] of the silhouette body within columns [x0, x1).
// Stops at the first wide horizontal gap (>= ROW_GAP_MIN empty rows) — that
// gap separates the ship hull from the text label rendered beneath it.
const ROW_GAP_MIN = 4;
function tightenVertical(img, x0, x1) {
  const buf = img.bitmap.data;
  const w = img.bitmap.width;
  const h = img.bitmap.height;
  // Top: first row in [x0, x1) with any dark pixel.
  let top = -1;
  for (let y = 0; y < h && top === -1; y++) {
    for (let x = x0; x < x1; x++) {
      if (isDark(buf, (y * w + x) * 4)) { top = y; break; }
    }
  }
  if (top === -1) return [0, 0];
  // Bottom: walk down from top, end when we hit ROW_GAP_MIN empty rows in a row.
  let bottom = top, emptyRun = 0;
  for (let y = top; y < h; y++) {
    let any = false;
    for (let x = x0; x < x1; x++) {
      if (isDark(buf, (y * w + x) * 4)) { any = true; break; }
    }
    if (any) { bottom = y; emptyRun = 0; }
    else {
      emptyRun++;
      if (emptyRun >= ROW_GAP_MIN) break;
    }
  }
  return [top, bottom + 1];
}

// Crop, then convert: dark px → opaque black, light px → transparent.
function extractMask(img, x0, y0, w, h) {
  const out = new Jimp({ width: w, height: h, color: 0x00000000 });
  const inBuf = img.bitmap.data;
  const outBuf = out.bitmap.data;
  const sw = img.bitmap.width;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const srcI = ((y + y0) * sw + (x + x0)) * 4;
      const dstI = (y * w + x) * 4;
      const b = brightness(inBuf, srcI);
      let alpha;
      if (b <= DARK_FULL)      alpha = 255;
      else if (b >= DARK_EDGE) alpha = 0;
      else alpha = Math.round(255 * (DARK_EDGE - b) / (DARK_EDGE - DARK_FULL));
      outBuf[dstI]     = 0;   // R
      outBuf[dstI + 1] = 0;   // G
      outBuf[dstI + 2] = 0;   // B
      outBuf[dstI + 3] = alpha;
    }
  }
  return out;
}

async function main() {
  const sourcePath = process.argv[2];
  if (!sourcePath) {
    console.error('Usage: node scripts/process-ship-silhouettes.js <source.png>');
    process.exit(1);
  }
  console.log(`→ Reading ${sourcePath}`);
  const img = await Jimp.read(sourcePath);
  console.log(`  source ${img.bitmap.width}×${img.bitmap.height}`);

  const band = findShipBand(img);
  console.log(`→ Ship band rows: y=${band[0]}–${band[1]} (${band[1] - band[0]}px tall)`);

  const cols = findShipColumns(img, band);
  console.log(`→ Found ${cols.length} silhouette(s)`);
  if (cols.length !== 4) {
    throw new Error(`Expected 4 silhouettes, found ${cols.length}. Adjust GAP_MIN.`);
  }

  fs.mkdirSync(OUT_DIR, { recursive: true });
  for (let i = 0; i < 4; i++) {
    const [x0, x1] = cols[i];
    const [yTop, yBot] = tightenVertical(img, x0, x1);
    const w = x1 - x0;
    const h = yBot - yTop;
    const pad = 4;
    const cropped = extractMask(img, Math.max(0, x0 - pad), Math.max(0, yTop - pad), w + pad * 2, h + pad * 2);
    const tier = TIERS[i];
    const outPath = path.join(OUT_DIR, `ship-${tier}.png`);
    await cropped.write(outPath);
    console.log(`  ✓ ${tier.padEnd(6)} → ${path.relative(process.cwd(), outPath)} (${w + pad * 2}×${h + pad * 2})`);
  }
}

main().catch(err => { console.error('✗', err.message); process.exit(1); });
