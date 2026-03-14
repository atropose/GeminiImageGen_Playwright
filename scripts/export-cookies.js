#!/usr/bin/env node
/**
 * export-cookies.js
 *
 * Opens your local Chrome profile, navigates to Gemini, and exports
 * all Google session cookies as JSON. Copy the output and paste it as
 * the GOOGLE_COOKIES environment variable in your Render dashboard.
 *
 * Usage:
 *   npm run export-cookies
 *
 * Requirements:
 *   - You must be logged into Google in Chrome
 *   - Chrome must be closed (or use a different profile via --user-data-dir)
 */

'use strict';

const { chromium } = require('playwright');
const path = require('path');
const os = require('os');

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

const USER_DATA_DIR = process.env.CHROME_USER_DATA_DIR || getDefaultUserDataDir();

(async () => {
  console.error('='.repeat(60));
  console.error('Gemini Cookie Exporter');
  console.error('='.repeat(60));
  console.error(`Using Chrome profile: ${USER_DATA_DIR}`);
  console.error('Opening browser...\n');

  let context;
  try {
    context = await chromium.launchPersistentContext(USER_DATA_DIR, {
      channel: 'chrome',
      headless: false,
      viewport: null,
      args: ['--no-first-run', '--no-default-browser-check'],
    });
  } catch (err) {
    console.error(`\nFailed to launch Chrome: ${err.message}`);
    console.error('Make sure Chrome is closed before running this script.');
    process.exit(1);
  }

  const page = await context.newPage();

  console.error('Navigating to Gemini...');
  await page.goto('https://gemini.google.com', { waitUntil: 'domcontentloaded', timeout: 30_000 });

  // Wait for user to be fully on the Gemini page (may need to complete login)
  console.error('\nIf a login page appeared, please log in manually.');
  console.error('Waiting for Gemini to fully load (up to 60s)...\n');

  try {
    // Wait until the URL settles on gemini.google.com (not accounts.google.com)
    await page.waitForFunction(
      () => window.location.hostname === 'gemini.google.com',
      { timeout: 60_000 }
    );
  } catch (_) {
    console.error('Warning: Timed out waiting for Gemini. Exporting cookies anyway...');
  }

  // Extra wait to ensure all auth cookies are set
  await page.waitForTimeout(2000);

  // Export cookies for Google domains
  const allCookies = await context.cookies([
    'https://gemini.google.com',
    'https://accounts.google.com',
    'https://google.com',
  ]);

  // Filter to only relevant Google cookies
  const googleCookies = allCookies.filter((c) =>
    c.domain.endsWith('.google.com') || c.domain === 'gemini.google.com'
  );

  await context.close();

  if (googleCookies.length === 0) {
    console.error('\nNo Google cookies found. Make sure you are logged into Google in Chrome.');
    process.exit(1);
  }

  console.error(`Exported ${googleCookies.length} Google cookies.\n`);
  console.error('='.repeat(60));
  console.error('NEXT STEPS:');
  console.error('1. Copy the JSON below (everything between the markers)');
  console.error('2. In Render dashboard → your service → Environment');
  console.error('   Add variable: GOOGLE_COOKIES = <paste the JSON>');
  console.error('3. Redeploy the service');
  console.error('='.repeat(60));
  console.error('--- BEGIN GOOGLE_COOKIES ---');

  // Print JSON to stdout (so it can be piped/redirected)
  process.stdout.write(JSON.stringify(googleCookies, null, 2));
  process.stdout.write('\n');

  console.error('--- END GOOGLE_COOKIES ---\n');
})();
