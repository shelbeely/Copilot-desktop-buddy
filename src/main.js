'use strict';

const { app, BrowserWindow, ipcMain, Menu, shell } = require('electron');
const path = require('path');
const Store = require('electron-store');

const BleManager = require('./ble/BleManager');
const CopilotPoller = require('./copilot/CopilotPoller');
const HeartbeatBuilder = require('./copilot/HeartbeatBuilder');

// --------------------------------------------------------------------------
// Persistent settings
// --------------------------------------------------------------------------
const store = new Store({
  defaults: {
    githubToken: '',
    githubOwner: '',
    pollIntervalMs: 10000,
    devMode: false,
  },
});

let mainWindow = null;
let bleManager = null;
let copilotPoller = null;

// --------------------------------------------------------------------------
// Window creation
// --------------------------------------------------------------------------
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 520,
    height: 680,
    minWidth: 420,
    minHeight: 540,
    title: 'Copilot Desktop Buddy',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  buildMenu();
}

// --------------------------------------------------------------------------
// Application menu
// --------------------------------------------------------------------------
function buildMenu() {
  const template = [
    {
      label: 'Copilot Buddy',
      submenu: [
        { label: 'About Copilot Desktop Buddy', role: 'about' },
        { type: 'separator' },
        { label: 'Settings…', accelerator: 'CmdOrCtrl+,', click: () => mainWindow && mainWindow.webContents.send('open-settings') },
        { type: 'separator' },
        { role: 'quit' },
      ],
    },
    {
      label: 'Help',
      submenu: [
        {
          label: 'View on GitHub',
          click: () => shell.openExternal('https://github.com/shelbeely/Copilot-desktop-buddy'),
        },
        {
          label: 'BLE Protocol Reference',
          click: () => shell.openExternal('https://github.com/anthropics/claude-desktop-buddy/blob/main/REFERENCE.md'),
        },
      ],
    },
  ];

  if (store.get('devMode')) {
    template.push({
      label: 'Developer',
      submenu: [
        { label: 'Open Hardware Buddy…', click: () => mainWindow && mainWindow.webContents.send('open-ble-picker') },
        { role: 'toggleDevTools' },
        { role: 'reload' },
      ],
    });
  }

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// --------------------------------------------------------------------------
// BLE + Poller wiring
// --------------------------------------------------------------------------
function initManagers() {
  bleManager = new BleManager();
  copilotPoller = new CopilotPoller(store);

  // Forward BLE state changes to renderer
  bleManager.on('state', (state) => {
    mainWindow && mainWindow.webContents.send('ble-state', state);
  });

  bleManager.on('devices-found', (devices) => {
    mainWindow && mainWindow.webContents.send('ble-devices', devices);
  });

  bleManager.on('connected', (deviceName) => {
    mainWindow && mainWindow.webContents.send('ble-connected', deviceName);
    sendOnConnectMessages();
  });

  bleManager.on('disconnected', () => {
    mainWindow && mainWindow.webContents.send('ble-disconnected');
  });

  // Handle inbound commands from the hardware device
  bleManager.on('device-message', (msg) => {
    handleDeviceMessage(msg);
  });

  // Forward Copilot session snapshots over BLE
  copilotPoller.on('snapshot', (snapshot) => {
    mainWindow && mainWindow.webContents.send('snapshot', snapshot);
    bleManager.sendJson(snapshot);
  });

  copilotPoller.on('turn', (turn) => {
    bleManager.sendJson(turn);
  });

  copilotPoller.on('error', (err) => {
    mainWindow && mainWindow.webContents.send('poller-error', err.message);
  });
}

// --------------------------------------------------------------------------
// One-shot messages sent immediately after a device connects
// --------------------------------------------------------------------------
function sendOnConnectMessages() {
  const now = Math.floor(Date.now() / 1000);
  const tzOffsetSeconds = -(new Date().getTimezoneOffset()) * 60;
  bleManager.sendJson({ time: [now, tzOffsetSeconds] });

  const ownerName = store.get('githubOwner') || 'User';
  bleManager.sendJson({ cmd: 'owner', name: ownerName });
}

// --------------------------------------------------------------------------
// Handle messages received FROM the hardware device
// --------------------------------------------------------------------------
function handleDeviceMessage(msg) {
  if (!msg) return;

  // Permission decision forwarded to Copilot
  if (msg.cmd === 'permission' && msg.id && msg.decision) {
    copilotPoller.applyPermissionDecision(msg.id, msg.decision);
    mainWindow && mainWindow.webContents.send('permission-decision', { id: msg.id, decision: msg.decision });
  }

  // Status poll from device
  if (msg.cmd === 'status') {
    const statusAck = {
      ack: 'status',
      ok: true,
      data: {
        name: 'Copilot Desktop Buddy',
        sec: bleManager.isEncrypted(),
        sys: { up: Math.floor(process.uptime()) },
      },
    };
    bleManager.sendJson(statusAck);
  }

  // Name command
  if (msg.cmd === 'name' && msg.name) {
    bleManager.sendJson({ ack: 'name', ok: true });
    mainWindow && mainWindow.webContents.send('device-name-set', msg.name);
  }

  // Owner command
  if (msg.cmd === 'owner' && msg.name) {
    store.set('githubOwner', msg.name);
    bleManager.sendJson({ ack: 'owner', ok: true });
    buildMenu();
  }

  // Unpair command
  if (msg.cmd === 'unpair') {
    bleManager.unpair();
    bleManager.sendJson({ ack: 'unpair', ok: true });
  }
}

// --------------------------------------------------------------------------
// IPC handlers (renderer → main)
// --------------------------------------------------------------------------
ipcMain.handle('get-settings', () => ({
  githubToken: store.get('githubToken'),
  githubOwner: store.get('githubOwner'),
  pollIntervalMs: store.get('pollIntervalMs'),
  devMode: store.get('devMode'),
}));

ipcMain.handle('save-settings', (_event, settings) => {
  store.set('githubToken', settings.githubToken || '');
  store.set('githubOwner', settings.githubOwner || '');
  store.set('pollIntervalMs', Math.max(5000, settings.pollIntervalMs || 10000));
  store.set('devMode', Boolean(settings.devMode));
  buildMenu();
  copilotPoller.restart();
  return { ok: true };
});

ipcMain.handle('ble-scan', () => {
  bleManager.startScan();
});

ipcMain.handle('ble-connect', (_event, deviceId) => {
  bleManager.connect(deviceId);
});

ipcMain.handle('ble-disconnect', () => {
  bleManager.disconnect();
});

ipcMain.handle('start-polling', () => {
  copilotPoller.start();
});

ipcMain.handle('stop-polling', () => {
  copilotPoller.stop();
});

ipcMain.handle('get-snapshot', () => {
  return copilotPoller.lastSnapshot();
});

ipcMain.handle('apply-permission', (_event, { id, decision }) => {
  copilotPoller.applyPermissionDecision(id, decision);
  return { ok: true };
});

// --------------------------------------------------------------------------
// App lifecycle
// --------------------------------------------------------------------------
app.whenReady().then(() => {
  initManagers();
  createWindow();

  // Auto-start polling if credentials are configured
  if (store.get('githubToken')) {
    copilotPoller.start();
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  copilotPoller && copilotPoller.stop();
  bleManager && bleManager.disconnect();
});
