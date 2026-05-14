'use strict';

/* eslint-env browser */

// ============================================================
// Copilot Desktop Buddy — renderer / UI logic
// ============================================================

const api = window.copilotBuddy;

// --------------------------------------------------------------------------
// DOM refs
// --------------------------------------------------------------------------
const $ = (id) => document.getElementById(id);

// Settings
const settingsPanel    = $('settings-panel');
const settingsForm     = $('settings-form');
const sToken           = $('s-token');
const sOwner           = $('s-owner');
const sInterval        = $('s-interval');
const sDevmode         = $('s-devmode');

// BLE picker
const blePickerPanel   = $('ble-picker');
const deviceList       = $('device-list');

// Status bars
const bleStatusBar     = $('ble-status-bar');
const bleStatusText    = $('ble-status-text');
const pollStatusBar    = $('poll-status-bar');
const pollStatusText   = $('poll-status-text');
const btnTogglePoll    = $('btn-toggle-poll');

// Summary
const valTotal         = $('val-total');
const valRunning       = $('val-running');
const valWaiting       = $('val-waiting');
const msgLine          = $('msg-line');

// Permission prompt
const promptBanner     = $('prompt-banner');
const promptDesc       = $('prompt-desc');

// Entries
const entriesList      = $('entries-list');

// Error
const errorBanner      = $('error-banner');

// --------------------------------------------------------------------------
// State
// --------------------------------------------------------------------------
let isPolling = false;
let currentPrompt = null;

// --------------------------------------------------------------------------
// Initialisation
// --------------------------------------------------------------------------
(async function init() {
  const settings = await api.getSettings();
  populateSettingsForm(settings);
  if (!settings.githubToken) {
    showSettings();
  }
  // Request an initial snapshot if we have credentials
  if (settings.githubToken) {
    startPolling();
  }
})();

// --------------------------------------------------------------------------
// Event bindings
// --------------------------------------------------------------------------

// Header buttons
$('btn-open-settings').addEventListener('click', showSettings);
$('btn-open-ble').addEventListener('click', showBlePicker);

// Settings panel
$('settings-close').addEventListener('click', hideSettings);
$('settings-cancel').addEventListener('click', hideSettings);
settingsForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  await api.saveSettings({
    githubToken:   sToken.value.trim(),
    githubOwner:   sOwner.value.trim(),
    pollIntervalMs: parseInt(sInterval.value, 10) || 10000,
    devMode:       sDevmode.checked,
  });
  hideSettings();
  startPolling();
});

// BLE picker
$('ble-picker-close').addEventListener('click', hideBlePicker);
$('btn-scan').addEventListener('click', () => api.bleScan());
$('btn-ble-disconnect').addEventListener('click', () => {
  api.bleDisconnect();
  hideBlePicker();
});

// Polling toggle
btnTogglePoll.addEventListener('click', () => {
  if (isPolling) stopPolling(); else startPolling();
});

// Permission decisions
$('btn-approve').addEventListener('click', () => sendPermissionDecision('once'));
$('btn-deny').addEventListener('click',    () => sendPermissionDecision('deny'));

// --------------------------------------------------------------------------
// Main → renderer events
// --------------------------------------------------------------------------
api.on('open-settings', showSettings);
api.on('open-ble-picker', showBlePicker);

api.on('ble-state', (state) => {
  if (state === 'unsupported' || state === 'unauthorized' || state === 'poweredOff') {
    setBleStatus('disconnected', `Bluetooth ${state}`);
  }
});

api.on('ble-devices', (devices) => {
  renderDeviceList(devices);
});

api.on('ble-connected', (name) => {
  setBleStatus('connected', `Connected: ${name}`);
  $('btn-ble-disconnect').classList.remove('hidden');
  hideBlePicker();
});

api.on('ble-disconnected', () => {
  setBleStatus('disconnected', 'No hardware device connected');
  $('btn-ble-disconnect').classList.add('hidden');
});

api.on('snapshot', (snap) => {
  renderSnapshot(snap);
  clearError();
});

api.on('poller-error', (msg) => {
  showError(msg);
});

api.on('permission-decision', ({ id, decision }) => {
  if (currentPrompt && currentPrompt.id === id) {
    currentPrompt = null;
    promptBanner.classList.add('hidden');
  }
});

// --------------------------------------------------------------------------
// Helpers: polling
// --------------------------------------------------------------------------
function startPolling() {
  api.startPolling();
  isPolling = true;
  pollStatusBar.className = 'status-bar polling';
  pollStatusText.textContent = 'Polling GitHub Copilot sessions…';
  btnTogglePoll.textContent = 'Stop';
}

function stopPolling() {
  api.stopPolling();
  isPolling = false;
  pollStatusBar.className = 'status-bar idle';
  pollStatusText.textContent = 'Polling stopped';
  btnTogglePoll.textContent = 'Start';
}

// --------------------------------------------------------------------------
// Helpers: BLE status
// --------------------------------------------------------------------------
function setBleStatus(state, text) {
  bleStatusBar.className = `status-bar ${state}`;
  bleStatusText.textContent = text;
}

// --------------------------------------------------------------------------
// Helpers: snapshot rendering
// --------------------------------------------------------------------------
function renderSnapshot(snap) {
  valTotal.textContent   = snap.total   ?? 0;
  valRunning.textContent = snap.running ?? 0;
  valWaiting.textContent = snap.waiting ?? 0;
  msgLine.textContent    = snap.msg || '–';

  // Entries
  if (snap.entries && snap.entries.length > 0) {
    entriesList.innerHTML = snap.entries
      .map((e) => `<li>${escapeHtml(e)}</li>`)
      .join('');
  } else {
    entriesList.innerHTML = '<li class="placeholder">No sessions yet</li>';
  }

  // Permission prompt
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
  api.applyPermission(currentPrompt.id, decision);
  // Also send via BLE so the hardware device knows the outcome
  // (main process echoes this back as a permission-decision event)
  // Optimistic UI: hide banner
  promptBanner.classList.add('hidden');
  currentPrompt = null;
}

// --------------------------------------------------------------------------
// Helpers: settings
// --------------------------------------------------------------------------
function showSettings() {
  settingsPanel.classList.remove('hidden');
}
function hideSettings() {
  settingsPanel.classList.add('hidden');
}
function populateSettingsForm(s) {
  sToken.value    = s.githubToken    || '';
  sOwner.value    = s.githubOwner    || '';
  sInterval.value = s.pollIntervalMs || 10000;
  sDevmode.checked = Boolean(s.devMode);
}

// --------------------------------------------------------------------------
// Helpers: BLE picker
// --------------------------------------------------------------------------
function showBlePicker() {
  blePickerPanel.classList.remove('hidden');
  api.bleScan();
}
function hideBlePicker() {
  blePickerPanel.classList.add('hidden');
}
function renderDeviceList(devices) {
  if (!devices || devices.length === 0) {
    deviceList.innerHTML = '<li style="color:var(--muted);padding:8px">No devices found yet…</li>';
    return;
  }
  deviceList.innerHTML = devices
    .map(
      (d) => `<li data-id="${escapeAttr(d.id)}">
        <span class="device-name">${escapeHtml(d.name || d.id)}</span>
        <span class="device-rssi">${d.rssi} dBm</span>
      </li>`
    )
    .join('');
  deviceList.querySelectorAll('li[data-id]').forEach((el) => {
    el.addEventListener('click', () => {
      api.bleConnect(el.dataset.id);
      deviceList.querySelectorAll('li').forEach((l) => l.classList.remove('selected'));
      el.classList.add('selected');
    });
  });
}

// --------------------------------------------------------------------------
// Helpers: error
// --------------------------------------------------------------------------
function showError(msg) {
  errorBanner.textContent = `⚠ ${msg}`;
  errorBanner.classList.remove('hidden');
}
function clearError() {
  errorBanner.classList.add('hidden');
}

// --------------------------------------------------------------------------
// Helpers: XSS-safe escaping
// --------------------------------------------------------------------------
function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
function escapeAttr(str) {
  return String(str).replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
