/**
 * app.js — PWA orchestrator
 *
 * Combines the roles of the Electron main process (wiring BLE ↔ poller)
 * and the renderer (UI logic) into a single browser ES module.
 *
 * Settings are persisted in localStorage.
 * BLE uses the Web Bluetooth API (Chrome 56+ desktop/Android).
 * GitHub API calls are made directly via fetch().
 */

import { BleManager } from './ble.js';
import { CopilotPoller } from './poller.js';

// --------------------------------------------------------------------------
// Settings (localStorage wrapper)
// --------------------------------------------------------------------------

const SETTINGS_KEY = 'copilot-buddy-settings';

const Settings = {
  defaults: {
    githubToken: '',
    githubOwner: '',
    pollIntervalMs: 10000,
  },
  load() {
    try {
      return { ...this.defaults, ...JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}') };
    } catch {
      return { ...this.defaults };
    }
  },
  save(obj) {
    const merged = { ...this.load(), ...obj };
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(merged));
    return merged;
  },
};

// --------------------------------------------------------------------------
// DOM helpers
// --------------------------------------------------------------------------

const $ = (id) => document.getElementById(id);

// Settings
const settingsPanel = $('settings-panel');
const settingsForm  = $('settings-form');
const sToken        = $('s-token');
const sOwner        = $('s-owner');
const sInterval     = $('s-interval');

// BLE picker
const blePickerPanel    = $('ble-picker');
const bleConnectError   = $('ble-connect-error');

// Status bars
const bleStatusBar  = $('ble-status-bar');
const bleStatusText = $('ble-status-text');
const pollStatusBar = $('poll-status-bar');
const pollStatusText = $('poll-status-text');
const btnTogglePoll = $('btn-toggle-poll');

// Summary
const valTotal   = $('val-total');
const valRunning = $('val-running');
const valWaiting = $('val-waiting');
const msgLine    = $('msg-line');

// Permission prompt
const promptBanner = $('prompt-banner');
const promptDesc   = $('prompt-desc');

// Entries
const entriesList = $('entries-list');

// Error
const errorBanner = $('error-banner');

// --------------------------------------------------------------------------
// App state
// --------------------------------------------------------------------------

const ble    = new BleManager();
let poller   = null;
let isPolling = false;
let currentPrompt = null;

// --------------------------------------------------------------------------
// Boot
// --------------------------------------------------------------------------

(function init() {
  const settings = Settings.load();
  populateSettingsForm(settings);

  // Show settings immediately if no token configured
  if (!settings.githubToken) {
    showSettings();
  }

  // Check Web Bluetooth support
  if (!ble.isSupported) {
    setBleStatus('disconnected', 'Web Bluetooth not supported — use Chrome on desktop');
    $('btn-open-ble').disabled = true;
  }

  buildPoller(settings);

  if (settings.githubToken) {
    startPolling();
  }

  // Register service worker
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./sw.js').catch((err) =>
      console.warn('[SW] registration failed', err)
    );
  }
})();

// --------------------------------------------------------------------------
// BLE wiring
// --------------------------------------------------------------------------

ble.addEventListener('connected', (e) => {
  const name = e.detail;
  setBleStatus('connected', `Connected: ${name}`);
  $('btn-ble-disconnect').classList.remove('hidden');
  $('btn-connect-device').classList.add('hidden');
  blePickerPanel.classList.add('hidden');
  sendOnConnectMessages();
});

ble.addEventListener('disconnected', () => {
  setBleStatus('disconnected', 'No hardware device connected');
  $('btn-ble-disconnect').classList.add('hidden');
  $('btn-connect-device').classList.remove('hidden');
});

ble.addEventListener('message', (e) => {
  handleDeviceMessage(e.detail);
});

// --------------------------------------------------------------------------
// Poller wiring
// --------------------------------------------------------------------------

function buildPoller(settings) {
  if (poller) poller.stop();
  poller = new CopilotPoller(settings);
  poller.addEventListener('snapshot', (e) => {
    const snap = e.detail;
    renderSnapshot(snap);
    clearError();
    ble.sendJson(snap).catch(() => {});
  });
  poller.addEventListener('error', (e) => {
    showError(e.detail.message || String(e.detail));
  });
}

// --------------------------------------------------------------------------
// Messages from the hardware device
// --------------------------------------------------------------------------

function handleDeviceMessage(msg) {
  if (!msg) return;

  if (msg.cmd === 'permission' && msg.id && msg.decision) {
    poller && poller.applyPermissionDecision(msg.id, msg.decision);
    if (currentPrompt && currentPrompt.id === msg.id) {
      currentPrompt = null;
      promptBanner.classList.add('hidden');
    }
  }

  if (msg.cmd === 'status') {
    ble.sendJson({
      ack: 'status', ok: true,
      data: { name: 'Copilot Desktop Buddy', sec: false },
    }).catch(() => {});
  }

  if (msg.cmd === 'name') {
    ble.sendJson({ ack: 'name', ok: true }).catch(() => {});
  }

  if (msg.cmd === 'owner' && msg.name) {
    const settings = Settings.save({ githubOwner: msg.name });
    sOwner.value = msg.name;
    poller && poller.updateSettings(settings);
    ble.sendJson({ ack: 'owner', ok: true }).catch(() => {});
  }

  if (msg.cmd === 'unpair') {
    ble.sendJson({ ack: 'unpair', ok: true }).catch(() => {}).then(() => ble.disconnect());
  }
}

// --------------------------------------------------------------------------
// One-shot messages sent on BLE connect
// --------------------------------------------------------------------------

function sendOnConnectMessages() {
  const now = Math.floor(Date.now() / 1000);
  const tzOffsetSeconds = -(new Date().getTimezoneOffset()) * 60;
  ble.sendJson({ time: [now, tzOffsetSeconds] }).catch(() => {});

  const ownerName = Settings.load().githubOwner || 'User';
  ble.sendJson({ cmd: 'owner', name: ownerName }).catch(() => {});
}

// --------------------------------------------------------------------------
// Event bindings
// --------------------------------------------------------------------------

$('btn-open-settings').addEventListener('click', showSettings);
$('btn-open-ble').addEventListener('click', showBlePicker);

$('settings-close').addEventListener('click', hideSettings);
$('settings-cancel').addEventListener('click', hideSettings);
settingsForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const settings = Settings.save({
    githubToken:    sToken.value.trim(),
    githubOwner:    sOwner.value.trim(),
    pollIntervalMs: Math.max(5000, parseInt(sInterval.value, 10) || 10000),
  });
  buildPoller(settings);
  hideSettings();
  startPolling();
});

$('ble-picker-close').addEventListener('click', hideBlePicker);

$('btn-connect-device').addEventListener('click', async () => {
  bleConnectError.classList.add('hidden');
  $('btn-connect-device').disabled = true;
  try {
    await ble.requestAndConnect();
  } catch (err) {
    bleConnectError.textContent = err.message;
    bleConnectError.classList.remove('hidden');
  } finally {
    $('btn-connect-device').disabled = false;
  }
});

$('btn-ble-disconnect').addEventListener('click', () => {
  ble.disconnect();
  hideBlePicker();
});

btnTogglePoll.addEventListener('click', () => {
  if (isPolling) stopPolling(); else startPolling();
});

$('btn-approve').addEventListener('click', () => sendPermissionDecision('once'));
$('btn-deny').addEventListener('click', () => sendPermissionDecision('deny'));

// --------------------------------------------------------------------------
// Polling
// --------------------------------------------------------------------------

function startPolling() {
  if (!poller) return;
  poller.start();
  isPolling = true;
  pollStatusBar.className = 'status-bar polling';
  pollStatusText.textContent = 'Polling GitHub Copilot sessions…';
  btnTogglePoll.textContent = 'Stop';
}

function stopPolling() {
  poller && poller.stop();
  isPolling = false;
  pollStatusBar.className = 'status-bar idle';
  pollStatusText.textContent = 'Polling stopped';
  btnTogglePoll.textContent = 'Start';
}

// --------------------------------------------------------------------------
// Snapshot rendering
// --------------------------------------------------------------------------

function renderSnapshot(snap) {
  valTotal.textContent   = snap.total   ?? 0;
  valRunning.textContent = snap.running ?? 0;
  valWaiting.textContent = snap.waiting ?? 0;
  msgLine.textContent    = snap.msg || '–';

  if (snap.entries && snap.entries.length > 0) {
    entriesList.innerHTML = snap.entries.map((e) => `<li>${escapeHtml(e)}</li>`).join('');
  } else {
    entriesList.innerHTML = '<li class="placeholder">No sessions yet</li>';
  }

  if (snap.prompt && snap.prompt.id) {
    currentPrompt = snap.prompt;
    promptDesc.textContent = snap.prompt.hint || `${snap.prompt.tool}: ${snap.prompt.id}`;
    promptBanner.classList.remove('hidden');
  } else {
    currentPrompt = null;
    promptBanner.classList.add('hidden');
  }
}

function sendPermissionDecision(decision) {
  if (!currentPrompt) return;
  poller && poller.applyPermissionDecision(currentPrompt.id, decision);
  // Inform the hardware device too, so its display updates
  ble.sendJson({ cmd: 'permission', id: currentPrompt.id, decision }).catch(() => {});
  promptBanner.classList.add('hidden');
  currentPrompt = null;
}

// --------------------------------------------------------------------------
// BLE status
// --------------------------------------------------------------------------

function setBleStatus(state, text) {
  bleStatusBar.className = `status-bar ${state}`;
  bleStatusText.textContent = text;
}

// --------------------------------------------------------------------------
// Settings panel
// --------------------------------------------------------------------------

function showSettings() { settingsPanel.classList.remove('hidden'); }
function hideSettings()  { settingsPanel.classList.add('hidden'); }
function populateSettingsForm(s) {
  sToken.value    = s.githubToken    || '';
  sOwner.value    = s.githubOwner    || '';
  sInterval.value = s.pollIntervalMs || 10000;
}

// --------------------------------------------------------------------------
// BLE picker panel
// --------------------------------------------------------------------------

function showBlePicker() { blePickerPanel.classList.remove('hidden'); }
function hideBlePicker() { blePickerPanel.classList.add('hidden'); }

// --------------------------------------------------------------------------
// Error banner
// --------------------------------------------------------------------------

function showError(msg) {
  errorBanner.textContent = `⚠ ${msg}`;
  errorBanner.classList.remove('hidden');
}
function clearError() {
  errorBanner.classList.add('hidden');
}

// --------------------------------------------------------------------------
// XSS-safe escaping
// --------------------------------------------------------------------------

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
