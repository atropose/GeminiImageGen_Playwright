'use strict';

const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { generateImage, IS_CLOUD } = require('./playwright');

const app = express();
const PORT = process.env.PORT || 3000;

// Cloud: images saved under DOWNLOAD_DIR (defaults to /tmp/gemini-downloads)
// Local: user provides the path in the UI
const DEFAULT_DOWNLOAD_DIR = process.env.DOWNLOAD_DIR ||
  (IS_CLOUD ? '/tmp/gemini-downloads' : null);

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ─── Job Store & Queue ────────────────────────────────────────────────────────

const jobs = new Map();
const sseClients = new Map();
let processing = false;
const queue = [];

function log(msg) {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

function generateJobId() {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  return Date.now().toString(36) + Math.random().toString(36).slice(2);
}

function sendSSE(jobId, event, data) {
  const clients = sseClients.get(jobId) || [];
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  clients.forEach((res) => {
    try {
      res.write(payload);
      if (event === 'complete' || event === 'error') res.end();
    } catch (_) {}
  });
}

async function processQueue() {
  if (processing || queue.length === 0) return;
  processing = true;

  const { jobId, prompt, downloadDir } = queue.shift();
  log(`Processing job ${jobId} | prompt="${prompt}" | dir="${downloadDir}"`);

  const progress = (message) => {
    log(`[Job ${jobId}] ${message}`);
    sendSSE(jobId, 'status', { message });
  };

  try {
    const filePath = await generateImage(prompt, downloadDir, progress);
    log(`Job ${jobId} complete: ${filePath}`);
    sendSSE(jobId, 'complete', {
      filePath,
      fileName: path.basename(filePath),
    });
  } catch (err) {
    log(`Job ${jobId} failed: ${err.message}`);
    sendSSE(jobId, 'error', { message: err.message });
  } finally {
    processing = false;
    setTimeout(() => {
      jobs.delete(jobId);
      sseClients.delete(jobId);
    }, 5 * 60 * 1000);
    processQueue();
  }
}

// ─── Routes ───────────────────────────────────────────────────────────────────

// Health check — used by Render to verify the service is up
app.get('/health', (req, res) => {
  res.json({ status: 'ok', uptime: process.uptime(), cloud: IS_CLOUD });
});

// Config — lets the frontend know it's running in cloud mode
app.get('/config', (req, res) => {
  res.json({
    isCloud: IS_CLOUD,
    defaultDownloadDir: DEFAULT_DOWNLOAD_DIR || '',
  });
});

// POST /generate — queue a new job
app.post('/generate', (req, res) => {
  const { prompt } = req.body;
  let { downloadDir } = req.body;

  if (!prompt || !prompt.trim()) {
    return res.status(400).json({ error: 'prompt is required' });
  }

  // In cloud mode, override downloadDir with server-side default
  if (IS_CLOUD) {
    downloadDir = DEFAULT_DOWNLOAD_DIR;
  } else {
    if (!downloadDir || !downloadDir.trim()) {
      return res.status(400).json({ error: 'downloadDir is required' });
    }
    downloadDir = downloadDir.trim();
  }

  const jobId = generateJobId();
  jobs.set(jobId, { status: 'queued', prompt, downloadDir });
  queue.push({ jobId, prompt: prompt.trim(), downloadDir });

  const position = queue.length + (processing ? 1 : 0);
  log(`Job ${jobId} queued (position: ${position})`);
  res.json({ jobId, position });

  setImmediate(processQueue);
});

// GET /progress/:jobId — SSE stream
app.get('/progress/:jobId', (req, res) => {
  const { jobId } = req.params;

  if (!jobs.has(jobId)) {
    return res.status(404).json({ error: 'Job not found' });
  }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  res.write(`event: status\ndata: ${JSON.stringify({ message: 'Connected. Waiting for job to start...' })}\n\n`);

  if (!sseClients.has(jobId)) sseClients.set(jobId, []);
  sseClients.get(jobId).push(res);

  req.on('close', () => {
    const clients = sseClients.get(jobId) || [];
    const idx = clients.indexOf(res);
    if (idx !== -1) clients.splice(idx, 1);
  });
});

// GET /preview — serve a saved image for in-browser preview / download
app.get('/preview', (req, res) => {
  const { filePath } = req.query;
  if (!filePath) return res.status(400).send('filePath param required');

  const resolved = path.resolve(filePath);

  // Security: only allow files in allowed directories
  const allowedDirs = [
    '/tmp',
    DEFAULT_DOWNLOAD_DIR,
    process.env.DOWNLOAD_DIR,
  ].filter(Boolean).map((d) => path.resolve(d));

  const isAllowed = allowedDirs.some((dir) => resolved.startsWith(dir));
  if (!isAllowed && IS_CLOUD) {
    return res.status(403).send('Access denied');
  }

  if (!fs.existsSync(resolved)) {
    return res.status(404).send('File not found');
  }

  const ext = path.extname(resolved).toLowerCase();
  const mimeTypes = {
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.webp': 'image/webp',
  };
  const mime = mimeTypes[ext] || 'application/octet-stream';

  // Allow direct browser download via ?download=1
  if (req.query.download === '1') {
    res.setHeader('Content-Disposition', `attachment; filename="${path.basename(resolved)}"`);
  }

  res.setHeader('Content-Type', mime);
  fs.createReadStream(resolved).pipe(res);
});

// GET / — serve the UI
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ─── Start ────────────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  log(`Server running at http://localhost:${PORT}`);
  log(`Mode: ${IS_CLOUD ? 'CLOUD (headless + cookie injection)' : 'LOCAL (persistent Chrome profile)'}`);

  // Auto-open browser only in local mode
  if (!IS_CLOUD) {
    const url = `http://localhost:${PORT}`;
    const opener =
      process.platform === 'win32' ? `start ${url}` :
      process.platform === 'darwin' ? `open ${url}` :
      `xdg-open ${url}`;
    require('child_process').exec(opener, (err) => {
      if (err) log(`Could not auto-open browser: ${err.message}`);
    });
  }
});

// Graceful shutdown
process.on('SIGTERM', async () => {
  log('SIGTERM received, shutting down...');
  const { closeBrowser } = require('./playwright');
  await closeBrowser().catch(() => {});
  process.exit(0);
});
