'use strict';

const { contextBridge, ipcRenderer } = require('electron');

// Expose a safe subset of IPC to the renderer via window.copilotBuddy
contextBridge.exposeInMainWorld('copilotBuddy', {
  // Settings
  getSettings: () => ipcRenderer.invoke('get-settings'),
  saveSettings: (s) => ipcRenderer.invoke('save-settings', s),

  // BLE
  bleScan: () => ipcRenderer.invoke('ble-scan'),
  bleConnect: (deviceId) => ipcRenderer.invoke('ble-connect', deviceId),
  bleDisconnect: () => ipcRenderer.invoke('ble-disconnect'),

  // Polling
  startPolling: () => ipcRenderer.invoke('start-polling'),
  stopPolling: () => ipcRenderer.invoke('stop-polling'),
  getSnapshot: () => ipcRenderer.invoke('get-snapshot'),
  applyPermission: (id, decision) => ipcRenderer.invoke('apply-permission', { id, decision }),

  // Events from main → renderer
  on: (channel, cb) => {
    const allowed = [
      'ble-state',
      'ble-devices',
      'ble-connected',
      'ble-disconnected',
      'snapshot',
      'poller-error',
      'permission-decision',
      'device-name-set',
      'open-settings',
      'open-ble-picker',
    ];
    if (allowed.includes(channel)) {
      ipcRenderer.on(channel, (_event, ...args) => cb(...args));
    }
  },

  off: (channel, cb) => {
    ipcRenderer.removeListener(channel, cb);
  },
});
