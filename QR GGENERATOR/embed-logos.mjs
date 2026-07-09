#!/usr/bin/env node
/*
 * embed-logos.mjs — bakes real logo artwork into gg-qr-generator.html as
 * base64 data URIs. Data URIs are used (instead of <img src> paths) so the
 * QR canvas can still export to PNG/SVG when the page is opened locally
 * over file:// (external paths taint the canvas and break export).
 *
 * Usage:  node embed-logos.mjs
 *
 * Drop the source images in assets/logos/ using the filenames in the MAP
 * below (PNG, JPG, or SVG all work), then run this script. It rewrites the
 * LOGO_PNGS block in the HTML in place. Re-run any time a logo changes.
 * Missing files are skipped, so the vector fallback keeps rendering.
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, extname } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const htmlPath = join(here, 'gg-qr-generator.html');
const logoDir = join(here, 'assets', 'logos');

// logo key (matches LOGOS / PRESETS in the HTML)  ->  exact source filename
// Embedded verbatim; the QR tool resizes them for display.
const MAP = {
  // --- branded logos (each drives a template/preset) ---
  'gg':    'GG.png',                       // blue GG city mark
  'ggtv3': 'GGTV3.png',                    // GGTV3 community television
  'parks': 'pmlb.png',                     // Parks Make Life Better!
  'pd':    'badge patch combined 2024.png',// Garden Grove Police badge + patch
  // --- extra icons (custom-logo picker only, no preset) ---
  'ornament':    'christmas-ball-icon.png',
  'ornament-2':  'christmas-ball-icon-christmas-new-year-symbol-traditional-holiday-decoration-vector-illustration-eps.png',
  'cityscape':   'cityscape-icon-vector-building-images-graphics.png',
  'cone':        'emergency-barrier-gray-cone-icon.png',
  'water-drop':  'water-drop-illustration-logo-template-vector-design.png',
};

const MIME = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.svg': 'image/svg+xml', '.webp': 'image/webp' };

const entries = [];
for (const [key, name] of Object.entries(MAP)) {
  const file = join(logoDir, name);
  if (!existsSync(file)) { console.log(`  skip  ${key.padEnd(7)} — ${name} not found in assets/logos/`); continue; }
  const mime = MIME[extname(file).toLowerCase()] || 'image/png';
  const b64 = readFileSync(file).toString('base64');
  entries.push(`  '${key}': 'data:${mime};base64,${b64}'`);
  console.log(`  bake  ${key.padEnd(7)} <- ${name}  (${(b64.length / 1024).toFixed(1)} KB base64)`);
}

const block = entries.length
  ? `const LOGO_PNGS = {\n${entries.join(',\n')}\n};`
  : `const LOGO_PNGS = {};`;

const re = /\/\* LOGO-PNGS:START[^\n]*\*\/[\s\S]*?\/\* LOGO-PNGS:END \*\//;
let html = readFileSync(htmlPath, 'utf8');
if (!re.test(html)) {
  console.error('ERROR: LOGO-PNGS markers not found in gg-qr-generator.html');
  process.exit(1);
}
html = html.replace(re, `/* LOGO-PNGS:START — baked by embed-logos.mjs; do not edit by hand */\n${block}\n/* LOGO-PNGS:END */`);
writeFileSync(htmlPath, html);
console.log(`\nWrote ${entries.length} embedded logo(s) into gg-qr-generator.html`);
