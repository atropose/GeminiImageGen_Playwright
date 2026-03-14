# Gemini Image Bot

Automate image generation on [Gemini](https://gemini.google.com) using Playwright — reusing your existing Chrome login session. No credentials are ever stored.

## Features

- **Local web UI** — clean dark-theme interface
- **Reuses your Chrome session** — no login required at runtime
- **Real-time progress** via Server-Sent Events
- **Robust selectors** — tries multiple strategies to find Gemini's input field
- **Smart image detection** — detects newly generated images by diffing the DOM
- **Blob & HTTPS download** — handles both blob: and https: image URLs
- **Filename format** — `YYYYMMDD_HHMMSS_sanitized_prompt.png`
- **Request queue** — safely handles multiple submissions
- **Browser singleton** — browser stays open between requests for speed
- **Retry logic** — retries image download once on failure
- **Image preview** — displays the generated image directly in the UI

---

## Installation

### 1. Install dependencies

```bash
npm install
```

### 2. Install Playwright browsers (optional — see Chrome config below)

```bash
npx playwright install
```

> If you configure your existing Chrome installation (recommended), you do **not** need to install Playwright's bundled browsers.

---

## Configuration

### Chrome User Data Directory

The app reuses your existing Chrome login session by pointing to your Chrome **User Data** directory.

Set the environment variable `CHROME_USER_DATA_DIR` before starting the app:

#### Linux
```bash
export CHROME_USER_DATA_DIR="$HOME/.config/google-chrome"
node server.js
```

#### macOS
```bash
export CHROME_USER_DATA_DIR="$HOME/Library/Application Support/Google/Chrome"
node server.js
```

#### Windows (PowerShell)
```powershell
$env:CHROME_USER_DATA_DIR = "C:\Users\<YourName>\AppData\Local\Google\Chrome\User Data"
node server.js
```

**If you do not set this variable**, the app will auto-detect the default path for your OS.

> **Important:** Chrome must be **closed** before starting the app, OR you must use a different Chrome profile. Running two instances against the same profile simultaneously will cause errors.

---

## Running the App

```bash
node server.js
```

The app will:
1. Start an Express server on port **3000**
2. Automatically open `http://localhost:3000` in your default browser

---

## Usage

1. Open `http://localhost:3000`
2. Enter your **image prompt** in the textarea
   *(Ctrl+Enter to submit quickly)*
3. Enter the **download folder** path
   *(created automatically if it doesn't exist)*
4. Click **Generate Image**
5. Watch real-time progress in the status log
6. The generated image is saved locally and previewed in the UI

---

## Project Structure

```
gemini-image-bot/
├── server.js          Express server + SSE + job queue
├── playwright.js      Playwright automation (browser singleton)
├── downloader.js      Image download + filename builder
├── public/
│   ├── index.html     UI layout
│   ├── script.js      Frontend logic + SSE client
│   └── style.css      Dark-theme styles
├── package.json
└── README.md
```

---

## Environment Variables

| Variable              | Default                                   | Description                        |
|-----------------------|-------------------------------------------|------------------------------------|
| `CHROME_USER_DATA_DIR`| OS-specific default (see above)           | Path to Chrome user data directory |
| `PORT`                | `3000`                                    | Port for the Express server        |

---

## Troubleshooting

### "Could not find the prompt input field"
- Make sure you are logged into Google in Chrome
- Check that Gemini loaded correctly (open Chrome manually and browse to gemini.google.com)
- Gemini's UI may have changed — open a GitHub issue with a screenshot

### "Image generation timed out after 90 seconds"
- Gemini may be slow or you may have hit a rate limit
- Check your network connection
- Try again with a simpler prompt

### Chrome profile locked / "User data directory is already in use"
- Close all Chrome windows before running the app
- Or create a dedicated Chrome profile and point `CHROME_USER_DATA_DIR` to it

### Preview not showing
- The image is still saved locally at the path shown
- Preview requires the Express server to serve the file — check that the file path is accessible

---

## Security Notes

- **No credentials are stored.** The app only reads your Chrome profile to reuse the existing login session.
- The Express server listens on `localhost` only — not exposed to the network.
- Never commit your Chrome `User Data` directory to version control.
