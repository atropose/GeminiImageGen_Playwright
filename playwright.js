'use strict';

const { chromium } = require('playwright');
const path = require('path');
const os = require('os');
const { downloadImage } = require('./downloader');

// ─── Environment Detection ────────────────────────────────────────────────────

/**
 * IS_CLOUD = true when running on Render or any production environment.
 * In cloud mode: launch headless Chromium + inject Google cookies from env.
 * In local mode: use persistent Chrome profile (user's existing login session).
 */
const IS_CLOUD = !!(process.env.RENDER || process.env.NODE_ENV === 'production');

// ─── Configuration ────────────────────────────────────────────────────────────

/**
 * LOCAL MODE ONLY — path to Chrome user data directory.
 *
 * Set CHROME_USER_DATA_DIR env variable to override.
 * Examples:
 *   Windows : C:\Users\<Name>\AppData\Local\Google\Chrome\User Data
 *   Mac     : ~/Library/Application Support/Google/Chrome
 *   Linux   : ~/.config/google-chrome
 */
function getDefaultUserDataDir() {
  const home = os.homedir();
  switch (process.platform) {
    case 'win32':
      return path.join(
        process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local'),
        'Google', 'Chrome', 'User Data'
      );
    case 'darwin':
      return path.join(home, 'Library', 'Application Support', 'Google', 'Chrome');
    default:
      return path.join(home, '.config', 'google-chrome');
  }
}

const CHROME_USER_DATA_DIR = process.env.CHROME_USER_DATA_DIR || getDefaultUserDataDir();
const GEMINI_URL = 'https://gemini.google.com';
const GENERATION_TIMEOUT_MS = 90_000;
const POLL_INTERVAL_MS = 2_000;

// ─── Selectors ────────────────────────────────────────────────────────────────

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

let _browser = null;        // cloud mode: Browser instance
let browserContext = null;  // both modes: BrowserContext
let activePage = null;

function log(msg) {
  console.log(`[${new Date().toISOString()}] [playwright] ${msg}`);
}

// ── Cloud Mode: headless Chromium + cookie injection ──────────────────────────

async function launchCloudContext() {
  const cookiesJson = process.env.GOOGLE_COOKIES;
  if (!cookiesJson) {
    throw new Error(
      'GOOGLE_COOKIES environment variable is not set.\n' +
      'Run "npm run export-cookies" locally to get your session cookies,\n' +
      'then add the output as the GOOGLE_COOKIES env var in your Render dashboard.'
    );
  }

  log('Launching headless Chromium (cloud mode)...');
  _browser = await chromium.launch({
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--disable-blink-features=AutomationControlled',
      '--window-size=1280,900',
    ],
  });

  browserContext = await _browser.newContext({
    userAgent:
      'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 ' +
      '(KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
    viewport: { width: 1280, height: 900 },
    locale: 'en-US',
  });

  // Inject Google session cookies
  let cookies;
  try {
    cookies = JSON.parse(cookiesJson);
  } catch (e) {
    throw new Error(`GOOGLE_COOKIES is not valid JSON: ${e.message}`);
  }

  if (!Array.isArray(cookies) || cookies.length === 0) {
    throw new Error('GOOGLE_COOKIES must be a non-empty JSON array of cookie objects.');
  }

  await browserContext.addCookies(cookies);
  log(`Injected ${cookies.length} cookies into browser context`);

  _browser.on('disconnected', () => {
    log('Browser disconnected');
    _browser = null;
    browserContext = null;
    activePage = null;
  });

  return browserContext;
}

// ── Local Mode via CDP: attach to already-running Chrome ─────────────────────
// Requires Chrome launched with: --remote-debugging-port=9222
// Set env var: CHROME_CDP_URL=http://localhost:9222

async function launchViaCDP(cdpUrl) {
  log(`Connecting to existing Chrome via CDP: ${cdpUrl}`);
  const browser = await chromium.connectOverCDP(cdpUrl);
  _browser = browser;

  // Reuse the first existing context (which has the user's login session)
  const contexts = browser.contexts();
  browserContext = contexts.length > 0 ? contexts[0] : await browser.newContext();

  browser.on('disconnected', () => {
    log('CDP browser disconnected');
    _browser = null;
    browserContext = null;
    activePage = null;
  });

  log('Connected to Chrome via CDP');
  return browserContext;
}

// ── Local Mode: persistent Chrome profile (existing login) ────────────────────

async function launchLocalContext() {
  // If Chrome is already running, connect via CDP instead of launching a new instance.
  // To use this mode, start Chrome with: --remote-debugging-port=9222
  const cdpUrl = process.env.CHROME_CDP_URL;
  if (cdpUrl) {
    return launchViaCDP(cdpUrl);
  }

  log(`Launching persistent Chrome context: ${CHROME_USER_DATA_DIR}`);
  try {
    browserContext = await chromium.launchPersistentContext(CHROME_USER_DATA_DIR, {
      channel: 'chrome',
      headless: false,
      viewport: null,
      args: [
        '--disable-blink-features=AutomationControlled',
        '--no-first-run',
        '--no-default-browser-check',
      ],
      ignoreDefaultArgs: ['--enable-automation'],
    });
  } catch (err) {
    // Chrome is already running with this profile — the profile directory is locked.
    const isProfileLocked =
      err.message.includes('Target page, context or browser has been closed') ||
      err.message.includes('already in use') ||
      err.message.includes('user data directory is already in use');

    if (isProfileLocked) {
      throw new Error(
        'Chrome is already running and the profile is locked.\n\n' +
        'Choose one of these solutions:\n\n' +
        '  [Option 1] Close Chrome completely, then retry.\n\n' +
        '  [Option 2] Connect to the running Chrome via CDP:\n' +
        '    1. Close Chrome\n' +
        '    2. Re-open Chrome with the debug flag:\n' +
        '       Windows: "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe" --remote-debugging-port=9222\n' +
        '       Mac/Linux: google-chrome --remote-debugging-port=9222\n' +
        '    3. Set env var: CHROME_CDP_URL=http://localhost:9222\n' +
        '    4. Restart this app'
      );
    }
    throw err;
  }

  browserContext.on('close', () => {
    log('Browser context closed');
    browserContext = null;
    activePage = null;
  });

  return browserContext;
}

// ── Unified getter ────────────────────────────────────────────────────────────

async function getBrowserContext() {
  if (browserContext) {
    try {
      browserContext.pages(); // throws if dead
      return browserContext;
    } catch (_) {
      log('Browser context stale, relaunching...');
      browserContext = null;
      _browser = null;
      activePage = null;
    }
  }

  return IS_CLOUD ? launchCloudContext() : launchLocalContext();
}

async function getPage(context) {
  // Reuse existing Gemini tab
  if (activePage) {
    try {
      if (activePage.url().startsWith('https://gemini.google.com')) {
        return activePage;
      }
    } catch (_) {
      activePage = null;
    }
  }

  const pages = context.pages();
  for (const p of pages) {
    try {
      if (p.url().startsWith('https://gemini.google.com')) {
        activePage = p;
        return activePage;
      }
    } catch (_) {}
  }

  activePage = await context.newPage();
  return activePage;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function findElement(page, selectors, timeoutMs = 10_000) {
  for (const selector of selectors) {
    try {
      const el = await page.waitForSelector(selector, { timeout: timeoutMs, state: 'visible' });
      if (el) {
        log(`Found element: ${selector}`);
        return el;
      }
    } catch (_) {}
  }
  return null;
}

async function getContentImageSrcs(page) {
  return page.evaluate(() =>
    Array.from(document.querySelectorAll('img'))
      .filter((img) => {
        const w = img.naturalWidth || img.width;
        const h = img.naturalHeight || img.height;
        const src = img.src || '';
        return (
          w > 100 && h > 100 && src &&
          !src.startsWith('data:') &&
          !src.includes('avatar') &&
          !src.includes('profile') &&
          !src.includes('favicon') &&
          !src.includes('logo')
        );
      })
      .map((img) => img.src)
  );
}

async function waitForNewImage(page, existingSrcs, progress, timeoutMs = GENERATION_TIMEOUT_MS) {
  const existingSet = new Set(existingSrcs);
  const deadline = Date.now() + timeoutMs;
  let elapsed = 0;

  while (Date.now() < deadline) {
    await page.waitForTimeout(POLL_INTERVAL_MS);
    elapsed += POLL_INTERVAL_MS;

    if (elapsed % 10_000 === 0) {
      progress(`Still generating... (${Math.round(elapsed / 1000)}s elapsed)`);
    }

    // Check for new https: images
    const currentSrcs = await getContentImageSrcs(page);
    const newSrcs = currentSrcs.filter((src) => !existingSet.has(src));
    if (newSrcs.length > 0) {
      log(`Detected ${newSrcs.length} new image(s)`);
      return newSrcs[newSrcs.length - 1];
    }

    // Check for blob: images
    const blobSrc = await page.evaluate(() => {
      const blobs = Array.from(document.querySelectorAll('img'))
        .filter((img) => img.src?.startsWith('blob:') && img.naturalWidth > 100)
        .map((img) => img.src);
      return blobs[blobs.length - 1] || null;
    });

    if (blobSrc && !existingSet.has(blobSrc)) {
      log(`Detected blob image`);
      return blobSrc;
    }
  }

  throw new Error(`Image generation timed out after ${timeoutMs / 1000} seconds`);
}

// ─── Main Export ──────────────────────────────────────────────────────────────

/**
 * Generate an image on Gemini and download it.
 *
 * @param {string}   prompt      - Image generation prompt
 * @param {string}   downloadDir - Directory to save image
 * @param {Function} progress    - progress(message: string) callback
 * @returns {Promise<string>}    - Absolute path of saved image
 */
async function generateImage(prompt, downloadDir, progress) {
  progress(IS_CLOUD ? 'Starting headless browser...' : 'Starting Chrome...');
  const context = await getBrowserContext();

  progress('Opening Gemini...');
  const page = await getPage(context);

  try {
    const currentUrl = page.url();
    if (!currentUrl.startsWith('https://gemini.google.com')) {
      await page.goto(GEMINI_URL, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    } else {
      await page.reload({ waitUntil: 'domcontentloaded', timeout: 30_000 });
    }

    progress('Waiting for Gemini to load...');
    await page.waitForTimeout(2000);

    // Check for login redirect — happens when cookies are expired
    const afterUrl = page.url();
    if (afterUrl.includes('accounts.google.com') || afterUrl.includes('/signin')) {
      throw new Error(
        IS_CLOUD
          ? 'Google session expired. Please re-export cookies and update the GOOGLE_COOKIES env var.'
          : 'Not logged into Google. Please log in to Chrome and try again.'
      );
    }

    const existingImageSrcs = await getContentImageSrcs(page);
    log(`Pre-existing images: ${existingImageSrcs.length}`);

    progress('Locating prompt input...');
    const inputEl = await findElement(page, PROMPT_SELECTORS, 12_000);
    if (!inputEl) {
      throw new Error(
        'Could not find the Gemini prompt input. ' +
        'The page may not have loaded correctly or the UI may have changed.'
      );
    }

    progress('Typing prompt...');
    await inputEl.click();
    await page.waitForTimeout(300);
    await page.keyboard.press('Control+A');
    await page.keyboard.press('Delete');
    await page.waitForTimeout(200);
    await page.keyboard.type(prompt, { delay: 30 });
    await page.waitForTimeout(500);

    log(`Prompt: "${prompt}"`);
    progress('Submitting prompt...');

    const sendBtn = await findElement(page, SEND_BUTTON_SELECTORS, 3_000);
    if (sendBtn) {
      await sendBtn.click();
    } else {
      await page.keyboard.press('Enter');
    }

    progress('Waiting for image generation (up to 90s)...');
    const imageSrc = await waitForNewImage(page, existingImageSrcs, progress);
    log(`Image detected: ${imageSrc.substring(0, 80)}...`);

    progress('Image detected! Downloading...');
    const filePath = await downloadImage(imageSrc, downloadDir, prompt, page);

    progress(`Download complete: ${filePath}`);
    return filePath;
  } catch (err) {
    log(`Error: ${err.message}`);
    throw err;
  }
}

async function closeBrowser() {
  if (browserContext) {
    try { await browserContext.close(); } catch (_) {}
    browserContext = null;
  }
  if (_browser) {
    try { await _browser.close(); } catch (_) {}
    _browser = null;
  }
  activePage = null;
}

module.exports = { generateImage, closeBrowser, IS_CLOUD };
