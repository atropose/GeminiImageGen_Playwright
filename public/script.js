'use strict';

// ─── DOM References ───────────────────────────────────────────────────────────

const form           = document.getElementById('generateForm');
const promptEl       = document.getElementById('prompt');
const downloadDirEl  = document.getElementById('downloadDir');
const generateBtn    = document.getElementById('generateBtn');
const clearBtn       = document.getElementById('clearBtn');

const statusSection  = document.getElementById('statusSection');
const statusIcon     = document.getElementById('statusIcon');
const statusTitle    = document.getElementById('statusTitle');
const statusLog      = document.getElementById('statusLog');

const resultSection  = document.getElementById('resultSection');
const filePathEl     = document.getElementById('filePath');
const previewImg     = document.getElementById('previewImg');

const errorSection   = document.getElementById('errorSection');
const errorMsg       = document.getElementById('errorMsg');

const generateAnotherBtn = document.getElementById('generateAnotherBtn');
const retryBtn           = document.getElementById('retryBtn');

// ─── State ────────────────────────────────────────────────────────────────────

let activeEventSource = null;

// ─── Helpers ──────────────────────────────────────────────────────────────────

function show(el)  { el.classList.remove('hidden'); }
function hide(el)  { el.classList.add('hidden'); }

function setStatus(title, spinning = true) {
  statusTitle.textContent = title;
  statusIcon.className = spinning ? 'spinner' : 'done-icon';
  statusIcon.textContent = spinning ? '◌' : '✓';
}

function addLogLine(message) {
  const line = document.createElement('div');
  line.className = 'log-line';
  const ts = new Date().toLocaleTimeString();
  line.innerHTML = `<span class="log-ts">${ts}</span> ${escapeHtml(message)}`;
  statusLog.appendChild(line);
  statusLog.scrollTop = statusLog.scrollHeight;
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.appendChild(document.createTextNode(str));
  return div.innerHTML;
}

function resetUI() {
  hide(statusSection);
  hide(resultSection);
  hide(errorSection);
  statusLog.innerHTML = '';
  generateBtn.disabled = false;
  generateBtn.classList.remove('loading');
  if (activeEventSource) {
    activeEventSource.close();
    activeEventSource = null;
  }
}

// ─── SSE Progress Listener ────────────────────────────────────────────────────

function listenForProgress(jobId) {
  if (activeEventSource) activeEventSource.close();

  const es = new EventSource(`/progress/${jobId}`);
  activeEventSource = es;

  es.addEventListener('status', (e) => {
    const data = JSON.parse(e.data);
    addLogLine(data.message);
    setStatus(data.message, true);
  });

  es.addEventListener('complete', (e) => {
    const data = JSON.parse(e.data);
    es.close();
    activeEventSource = null;
    showResult(data.filePath);
  });

  es.addEventListener('error', (e) => {
    let message = 'An unknown error occurred.';
    try {
      const data = JSON.parse(e.data);
      message = data.message || message;
    } catch (_) {
      // SSE connection error (no data)
      if (e.eventPhase === EventSource.CLOSED) {
        message = 'Lost connection to server.';
      }
    }
    es.close();
    activeEventSource = null;
    showError(message);
  });
}

// ─── Result / Error Display ───────────────────────────────────────────────────

function showResult(filePath) {
  hide(statusSection);
  show(resultSection);

  filePathEl.textContent = `Saved: ${filePath}`;
  // Load preview via server route
  previewImg.src = `/preview?filePath=${encodeURIComponent(filePath)}`;
  previewImg.onerror = () => {
    previewImg.alt = 'Preview unavailable (file saved locally)';
  };

  generateBtn.disabled = false;
  generateBtn.classList.remove('loading');
}

function showError(message) {
  hide(statusSection);
  show(errorSection);
  errorMsg.textContent = message;
  generateBtn.disabled = false;
  generateBtn.classList.remove('loading');
}

// ─── Form Submission ──────────────────────────────────────────────────────────

form.addEventListener('submit', async (e) => {
  e.preventDefault();

  const prompt     = promptEl.value.trim();
  const downloadDir = downloadDirEl.value.trim();

  if (!prompt)     { promptEl.focus();      return; }
  if (!downloadDir){ downloadDirEl.focus(); return; }

  resetUI();
  generateBtn.disabled = true;
  generateBtn.classList.add('loading');

  show(statusSection);
  setStatus('Submitting...', true);
  addLogLine(`Prompt: "${prompt}"`);
  addLogLine(`Download folder: ${downloadDir}`);

  try {
    const res = await fetch('/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt, downloadDir }),
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
      showError(err.error || 'Server error');
      return;
    }

    const { jobId, position } = await res.json();
    if (position > 1) addLogLine(`Queued at position ${position}. Please wait...`);
    addLogLine('Job accepted. Waiting for browser automation...');
    listenForProgress(jobId);

  } catch (err) {
    showError(`Failed to reach server: ${err.message}`);
  }
});

// ─── Misc Buttons ─────────────────────────────────────────────────────────────

clearBtn.addEventListener('click', () => {
  resetUI();
  promptEl.value = '';
  downloadDirEl.value = '';
  promptEl.focus();
});

generateAnotherBtn.addEventListener('click', () => {
  resetUI();
  promptEl.focus();
});

retryBtn.addEventListener('click', () => {
  resetUI();
  // Re-submit with same values
  form.dispatchEvent(new Event('submit', { cancelable: true }));
});

// ─── Keyboard shortcut: Ctrl+Enter to submit ──────────────────────────────────
promptEl.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
    form.dispatchEvent(new Event('submit', { cancelable: true }));
  }
});

// ─── Restore last-used download dir ──────────────────────────────────────────
(function restoreDefaults() {
  const saved = localStorage.getItem('geminibot_downloadDir');
  if (saved) downloadDirEl.value = saved;

  downloadDirEl.addEventListener('change', () => {
    localStorage.setItem('geminibot_downloadDir', downloadDirEl.value.trim());
  });
})();
