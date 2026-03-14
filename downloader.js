'use strict';

const fs = require('fs');
const path = require('path');

function log(msg) {
  console.log(`[${new Date().toISOString()}] [downloader] ${msg}`);
}

/**
 * Build a filename from timestamp + sanitized prompt.
 * Format: YYYYMMDD_HHMMSS_<sanitized_prompt>.png
 */
function buildFilename(prompt) {
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');

  const date =
    `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`;
  const time =
    `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;

  const sanitized = prompt
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .substring(0, 50);

  return `${date}_${time}_${sanitized}.png`;
}

/**
 * Ensure the download directory exists (creates it recursively if needed).
 */
function ensureDir(dir) {
  const resolved = path.resolve(dir);
  fs.mkdirSync(resolved, { recursive: true });
  return resolved;
}

/**
 * Download using Playwright's browserContext.request — runs in Node.js but
 * uses the browser's cookie jar automatically. No CORS restrictions.
 * This is the primary strategy for all https: URLs.
 */
async function downloadViaPlaywrightRequest(url, destPath, browserContext) {
  log('Downloading via Playwright request (authenticated)...');
  const response = await browserContext.request.get(url, {
    headers: { 'Referer': 'https://gemini.google.com/' },
  });
  if (!response.ok()) {
    throw new Error(`HTTP ${response.status()} via Playwright request`);
  }
  const buffer = await response.body();
  fs.writeFileSync(destPath, buffer);
}

/**
 * Download a blob: URL by extracting it from the browser page as base64.
 * Requires an active Playwright page.
 */
async function downloadViaBlob(blobUrl, destPath, page) {
  log('Downloading blob URL via browser extraction...');
  const base64 = await page.evaluate(async (url) => {
    const res = await fetch(url);
    const buf = await res.arrayBuffer();
    const bytes = new Uint8Array(buf);
    let binary = '';
    for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
    return btoa(binary);
  }, blobUrl);
  const buffer = Buffer.from(base64, 'base64');
  fs.writeFileSync(destPath, buffer);
}

/**
 * Try downloading an image with one retry on failure.
 */
async function downloadWithRetry(imageUrl, destPath, page, browserContext) {
  const isBlob = imageUrl.startsWith('blob:');

  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      if (isBlob) {
        if (!page) throw new Error('Blob URL requires an active browser page');
        await downloadViaBlob(imageUrl, destPath, page);
      } else {
        if (!browserContext) throw new Error('browserContext required to download image');
        await downloadViaPlaywrightRequest(imageUrl, destPath, browserContext);
      }
      return; // success
    } catch (err) {
      log(`Download attempt ${attempt} failed: ${err.message}`);
      if (attempt === 2) throw err;
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
}

/**
 * Main export: download a Gemini-generated image.
 *
 * @param {string}        imageUrl       - The src URL of the generated image
 * @param {string}        downloadDir    - Directory to save image
 * @param {string}        prompt         - Original prompt (used for filename)
 * @param {object}        [page]         - Playwright Page (required for blob: URLs)
 * @param {object}        [browserContext] - Playwright BrowserContext for authenticated requests
 * @returns {Promise<string>}            - Absolute path of saved file
 */
async function downloadImage(imageUrl, downloadDir, prompt, page, browserContext) {
  if (!imageUrl || typeof imageUrl !== 'string') {
    throw new Error('Invalid image URL');
  }

  const resolvedDir = ensureDir(downloadDir);
  const filename = buildFilename(prompt);
  const destPath = path.join(resolvedDir, filename);

  log(`Downloading: ${imageUrl.substring(0, 80)}...`);
  log(`Destination: ${destPath}`);

  await downloadWithRetry(imageUrl, destPath, page, browserContext);

  // Verify the file was written and has content
  const stat = fs.statSync(destPath);
  if (stat.size === 0) {
    fs.unlinkSync(destPath);
    throw new Error('Downloaded file is empty');
  }

  log(`Saved ${stat.size} bytes to ${destPath}`);
  return destPath;
}

module.exports = { downloadImage, buildFilename };
