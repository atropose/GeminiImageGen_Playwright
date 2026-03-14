'use strict';

const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');

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
 * Download a remote HTTPS/HTTP image URL using Node's built-in modules.
 * Follows redirects up to 5 times.
 */
async function downloadViaHttp(url, destPath, redirectCount = 0) {
  if (redirectCount > 5) throw new Error('Too many redirects');

  return new Promise((resolve, reject) => {
    const client = url.startsWith('https:') ? https : http;
    const req = client.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; GeminiImageBot/1.0)',
        'Accept': 'image/*,*/*',
      },
    }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        resolve(downloadViaHttp(res.headers.location, destPath, redirectCount + 1));
        return;
      }
      if (res.statusCode !== 200) {
        reject(new Error(`HTTP ${res.statusCode} downloading image`));
        return;
      }

      const fileStream = fs.createWriteStream(destPath);
      res.pipe(fileStream);
      fileStream.on('finish', () => fileStream.close(resolve));
      fileStream.on('error', reject);
      res.on('error', reject);
    });
    req.on('error', reject);
    req.setTimeout(30_000, () => {
      req.destroy();
      reject(new Error('Download request timed out'));
    });
  });
}

/**
 * Download any URL using the browser page's fetch() — includes session cookies.
 * Works for authenticated Google URLs (lh3.googleusercontent.com, etc.).
 */
async function downloadViaBrowserFetch(url, destPath, page) {
  log(`Downloading via browser fetch (authenticated)...`);

  const base64 = await page.evaluate(async (imageUrl) => {
    const res = await fetch(imageUrl, { credentials: 'include' });
    if (!res.ok) throw new Error(`HTTP ${res.status} from browser fetch`);
    const buf = await res.arrayBuffer();
    const bytes = new Uint8Array(buf);
    let binary = '';
    for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
    return btoa(binary);
  }, url);

  const buffer = Buffer.from(base64, 'base64');
  fs.writeFileSync(destPath, buffer);
}

/**
 * Download a blob: URL by extracting it from the browser page as base64.
 * Requires an active Playwright page.
 */
async function downloadViaBlob(blobUrl, destPath, page) {
  log(`Downloading blob URL via browser extraction...`);

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
async function downloadWithRetry(imageUrl, destPath, page) {
  const isBlob = imageUrl.startsWith('blob:');

  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      if (isBlob) {
        if (!page) throw new Error('Blob URL requires an active browser page');
        await downloadViaBlob(imageUrl, destPath, page);
      } else if (page) {
        // Use browser-side fetch so Google session cookies are included.
        // Falls back to plain HTTP if the browser fetch fails.
        await downloadViaBrowserFetch(imageUrl, destPath, page);
      } else {
        await downloadViaHttp(imageUrl, destPath);
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
 * @param {string}   imageUrl    - The src URL of the generated image
 * @param {string}   downloadDir - Directory to save image
 * @param {string}   prompt      - Original prompt (used for filename)
 * @param {object}   [page]      - Playwright Page (required for blob: URLs)
 * @returns {Promise<string>}    - Absolute path of saved file
 */
async function downloadImage(imageUrl, downloadDir, prompt, page) {
  if (!imageUrl || typeof imageUrl !== 'string') {
    throw new Error('Invalid image URL');
  }

  const resolvedDir = ensureDir(downloadDir);
  const filename = buildFilename(prompt);
  const destPath = path.join(resolvedDir, filename);

  log(`Downloading: ${imageUrl.substring(0, 80)}...`);
  log(`Destination: ${destPath}`);

  await downloadWithRetry(imageUrl, destPath, page);

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
