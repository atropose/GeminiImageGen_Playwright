'use strict';

const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { generateImage } = require('./playwright');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// In-memory job store: jobId -> { status, messages[], resolve, reject }
const jobs = new Map();
// SSE clients: jobId -> [res, ...]
const sseClients = new Map();

// Simple request queue
let processing = false;
const queue = [];

function log(msg) {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

function generateJobId() {
  if (typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return Date.now().toString(36) + Math.random().toString(36).slice(2);
}

function sendSSE(jobId, event, data) {
  const clients = sseClients.get(jobId) || [];
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  clients.forEach((res) => {
    try {
      res.write(payload);
      if (event === 'complete' || event === 'error') {
        res.end();
      }
    } catch (_) {}
  });
}

async function processQueue() {
  if (processing || queue.length === 0) return;
  processing = true;

  const { jobId, prompt, downloadDir } = queue.shift();
  log(`Processing job ${jobId}: prompt="${prompt}", dir="${downloadDir}"`);

  const progressCallback = (message) => {
    log(`[Job ${jobId}] ${message}`);
    sendSSE(jobId, 'status', { message });
  };

  try {
    const filePath = await generateImage(prompt, downloadDir, progressCallback);
    log(`Job ${jobId} complete: ${filePath}`);
    sendSSE(jobId, 'complete', { filePath, fileName: path.basename(filePath) });
  } catch (err) {
    log(`Job ${jobId} failed: ${err.message}`);
    sendSSE(jobId, 'error', { message: err.message });
  } finally {
    processing = false;
    // Clean up job after 5 minutes
    setTimeout(() => jobs.delete(jobId), 5 * 60 * 1000);
    processQueue();
  }
}

// POST /generate — queue a new job
app.post('/generate', (req, res) => {
  const { prompt, downloadDir } = req.body;

  if (!prompt || !prompt.trim()) {
    return res.status(400).json({ error: 'prompt is required' });
  }
  if (!downloadDir || !downloadDir.trim()) {
    return res.status(400).json({ error: 'downloadDir is required' });
  }

  const jobId = generateJobId();
  jobs.set(jobId, { status: 'queued', prompt, downloadDir });
  queue.push({ jobId, prompt: prompt.trim(), downloadDir: downloadDir.trim() });

  log(`Job ${jobId} queued (queue length: ${queue.length + (processing ? 1 : 0)})`);
  res.json({ jobId, position: queue.length });

  // Start processing (non-blocking)
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

  // Send initial status
  res.write(`event: status\ndata: ${JSON.stringify({ message: 'Job queued, waiting to start...' })}\n\n`);

  if (!sseClients.has(jobId)) {
    sseClients.set(jobId, []);
  }
  sseClients.get(jobId).push(res);

  req.on('close', () => {
    const clients = sseClients.get(jobId) || [];
    const idx = clients.indexOf(res);
    if (idx !== -1) clients.splice(idx, 1);
  });
});

// GET /preview — serve a downloaded image for browser preview
app.get('/preview', (req, res) => {
  const { filePath } = req.query;
  if (!filePath) return res.status(400).send('filePath query param required');

  const resolved = path.resolve(filePath);
  if (!fs.existsSync(resolved)) {
    return res.status(404).send('File not found');
  }

  const ext = path.extname(resolved).toLowerCase();
  const mimeTypes = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp' };
  const mime = mimeTypes[ext] || 'application/octet-stream';

  res.setHeader('Content-Type', mime);
  fs.createReadStream(resolved).pipe(res);
});

// GET / — serve the UI
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  log(`Server running at http://localhost:${PORT}`);
  // Auto-open browser
  const url = `http://localhost:${PORT}`;
  const opener =
    process.platform === 'win32' ? `start ${url}` :
    process.platform === 'darwin' ? `open ${url}` :
    `xdg-open ${url}`;
  require('child_process').exec(opener, (err) => {
    if (err) log(`Could not auto-open browser: ${err.message}`);
  });
});
