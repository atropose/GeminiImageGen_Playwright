'use strict';

const { chromium } = require('playwright');
const path = require('path');
const os = require('os');
const { downloadImage } = require('./downloader');

// ─── Configuration ────────────────────────────────────────────────────────────

/**
 * Path to your Chrome user data directory.
 * Set CHROME_USER_DATA_DIR env variable to override, or edit DEFAULT_USER_DATA_DIR below.
 *
 * Examples:
 *   Windows : C:\Users\<YourName>\AppData\Local\Google\Chrome\User Data
 *   Mac     : /Users/<YourName>/Library/Application Support/Google/Chrome
 *   Linux   : /home/<YourName>/.config/google-chrome
 */
function getDefaultUserDataDir() {
  const home = os.homedir();
  switch (process.platform) {
    case 'win32':
      return path.join(process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local'),
        'Google', 'Chrome', 'User Data');
    case 'darwin':
      return path.join(home, 'Library', 'Application Support', 'Google', 'Chrome');
    default: // linux
      return path.join(home, '.config', 'google-chrome');
  }
}

const CHROME_USER_DATA_DIR = process.env.CHROME_USER_DATA_DIR || getDefaultUserDataDir();
const GEMINI_URL = 'https://gemini.google.com';
const GENERATION_TIMEOUT_MS = 90_000; // 90 seconds
const POLL_INTERVAL_MS = 2_000;

// ─── Selectors (ordered by reliability) ──────────────────────────────────────

const PROMPT_SELECTORS = [
  'div[contenteditable="true"][role="textbox"]',
  'rich-textarea div[contenteditable="true"]',
  'div[contenteditable="true"]',
  'textarea[placeholder]',
  '[aria-label*="prompt" i]',
  '[aria-label*="message" i]',
  '[placeholder*="message" i]',
];

const SEND_BUTTON_SELECTORS = [
  'button[aria-label*="send" i]',
  'button[aria-label*="submit" i]',
  'button[type="submit"]',
  'mat-icon[fonticon="send"]',
  '.send-button',
];

// ─── Browser Singleton ────────────────────────────────────────────────────────

let browserContext = null;
let activePage = null;

function log(msg) {
  console.log(`[${new Date().toISOString()}] [playwright] ${msg}`);
}

async function getBrowserContext() {
  if (browserContext) {
    try {
      // Verify it's still alive
      browserContext.pages();
      return browserContext;
    } catch (_) {
      log('Browser context died, relaunching...');
      browserContext = null;
      activePage = null;
    }
  }

  log(`Launching persistent Chrome context from: ${CHROME_USER_DATA_DIR}`);
  browserContext = await chromium.launchPersistentContext(CHROME_USER_DATA_DIR, {
    channel: 'chrome',         // Use installed Google Chrome
    headless: false,           // Must be visible to reuse login session
    viewport: null,            // Use full window size
    args: [
      '--disable-blink-features=AutomationControlled',
      '--no-first-run',
      '--no-default-browser-check',
    ],
    ignoreDefaultArgs: ['--enable-automation'],
  });

  browserContext.on('close', () => {
    log('Browser context closed');
    browserContext = null;
    activePage = null;
  });

  return browserContext;
}

async function getPage(context) {
  // Try reusing the existing page if it's on Gemini
  if (activePage) {
    try {
      const url = activePage.url();
      if (url.startsWith('https://gemini.google.com')) {
        return activePage;
      }
    } catch (_) {
      activePage = null;
    }
  }

  // Find an existing Gemini tab
  const pages = context.pages();
  for (const p of pages) {
    try {
      if (p.url().startsWith('https://gemini.google.com')) {
        activePage = p;
        return activePage;
      }
    } catch (_) {}
  }

  // Open a new tab
  activePage = await context.newPage();
  return activePage;
}

// ─── Selector Discovery ───────────────────────────────────────────────────────

async function findElement(page, selectors, timeoutMs = 10_000) {
  for (const selector of selectors) {
    try {
      const el = await page.waitForSelector(selector, { timeout: timeoutMs, state: 'visible' });
      if (el) {
        log(`Found element with selector: ${selector}`);
        return el;
      }
    } catch (_) {}
  }
  return null;
}

// ─── Image Detection ──────────────────────────────────────────────────────────

/**
 * Collect src values of all "content" images currently on the page.
 * Filters out tiny icons, avatars, and data URIs.
 */
async function getContentImageSrcs(page) {
  return page.evaluate(() => {
    const imgs = Array.from(document.querySelectorAll('img'));
    return imgs
      .filter((img) => {
        const w = img.naturalWidth || img.width;
        const h = img.naturalHeight || img.height;
        const src = img.src || '';
        return (
          w > 100 &&
          h > 100 &&
          src &&
          !src.startsWith('data:') &&
          !src.includes('avatar') &&
          !src.includes('profile') &&
          !src.includes('favicon') &&
          !src.includes('logo')
        );
      })
      .map((img) => img.src);
  });
}

/**
 * Poll the page until a new content image appears that wasn't there before submission.
 * Returns the new image src.
 */
async function waitForNewImage(page, existingSrcs, progress, timeoutMs = GENERATION_TIMEOUT_MS) {
  const existingSet = new Set(existingSrcs);
  const deadline = Date.now() + timeoutMs;
  let dotCount = 0;

  while (Date.now() < deadline) {
    await page.waitForTimeout(POLL_INTERVAL_MS);
    dotCount++;

    if (dotCount % 5 === 0) {
      progress(`Still generating... (${Math.round((Date.now() - (deadline - timeoutMs)) / 1000)}s)`);
    }

    const currentSrcs = await getContentImageSrcs(page);
    const newSrcs = currentSrcs.filter((src) => !existingSet.has(src));

    if (newSrcs.length > 0) {
      log(`Detected ${newSrcs.length} new image(s)`);
      // Return the last one (most recently added)
      return newSrcs[newSrcs.length - 1];
    }

    // Also check for blob URLs created dynamically
    const blobSrc = await page.evaluate(() => {
      const imgs = Array.from(document.querySelectorAll('img'));
      const blobs = imgs
        .filter((img) => img.src && img.src.startsWith('blob:') && img.naturalWidth > 100)
        .map((img) => img.src);
      return blobs[blobs.length - 1] || null;
    });

    if (blobSrc && !existingSet.has(blobSrc)) {
      log(`Detected blob image: ${blobSrc}`);
      return blobSrc;
    }
  }

  throw new Error(`Image generation timed out after ${timeoutMs / 1000} seconds`);
}

// ─── Main Export ──────────────────────────────────────────────────────────────

/**
 * Generate an image on Gemini and download it locally.
 *
 * @param {string} prompt        - The image generation prompt
 * @param {string} downloadDir   - Directory to save the image
 * @param {Function} progress    - Callback(message: string) for status updates
 * @returns {Promise<string>}    - Absolute path of saved image
 */
async function generateImage(prompt, downloadDir, progress) {
  progress('Starting browser...');
  const context = await getBrowserContext();

  progress('Opening Gemini...');
  const page = await getPage(context);

  try {
    // Navigate if not already on Gemini
    const currentUrl = page.url();
    if (!currentUrl.startsWith('https://gemini.google.com')) {
      await page.goto(GEMINI_URL, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    } else {
      // Reload to get a clean state for image detection
      await page.reload({ waitUntil: 'domcontentloaded', timeout: 30_000 });
    }

    progress('Waiting for Gemini to load...');
    // Wait for the page to settle
    await page.waitForTimeout(2000);

    // Snapshot existing images before submitting
    const existingImageSrcs = await getContentImageSrcs(page);
    log(`Found ${existingImageSrcs.length} pre-existing images on page`);

    // Find the prompt input
    progress('Locating prompt input...');
    const inputEl = await findElement(page, PROMPT_SELECTORS, 12_000);
    if (!inputEl) {
      throw new Error(
        'Could not find the prompt input field. Gemini may have updated its UI. ' +
        'Please check if you are logged in and the page loaded correctly.'
      );
    }

    // Click and type the prompt
    progress('Typing prompt...');
    await inputEl.click();
    await page.waitForTimeout(300);

    // Clear any existing content
    await page.keyboard.press('Control+A');
    await page.keyboard.press('Delete');
    await page.waitForTimeout(200);

    // Type in chunks to avoid input issues
    await page.keyboard.type(prompt, { delay: 30 });
    await page.waitForTimeout(500);

    log(`Prompt submitted: "${prompt}"`);
    progress('Submitting prompt...');

    // Try send button first, fall back to Enter
    const sendBtn = await findElement(page, SEND_BUTTON_SELECTORS, 3_000);
    if (sendBtn) {
      await sendBtn.click();
    } else {
      await page.keyboard.press('Enter');
    }

    progress('Waiting for image generation (up to 90s)...');
    log('Waiting for generated image...');

    const imageSrc = await waitForNewImage(page, existingImageSrcs, progress, GENERATION_TIMEOUT_MS);
    log(`Image detected: ${imageSrc.substring(0, 80)}...`);

    progress('Image detected! Downloading...');
    const filePath = await downloadImage(imageSrc, downloadDir, prompt, page);

    progress(`Download complete: ${filePath}`);
    log(`Image saved to: ${filePath}`);

    return filePath;
  } catch (err) {
    log(`Error during generation: ${err.message}`);
    // Don't close the page — let the user inspect it
    throw err;
  }
}

/**
 * Gracefully close the browser context (call on app shutdown).
 */
async function closeBrowser() {
  if (browserContext) {
    await browserContext.close();
    browserContext = null;
    activePage = null;
  }
}

module.exports = { generateImage, closeBrowser };
