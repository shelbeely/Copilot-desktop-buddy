'use strict';

const EventEmitter = require('events');

// Nordic UART Service UUIDs (dashes stripped, lower-case — noble normalises them)
const NUS_SERVICE    = '6e400001b5a3f393e0a9e50e24dcca9e';
const NUS_RX_CHAR    = '6e400002b5a3f393e0a9e50e24dcca9e'; // desktop → device (write)
const NUS_TX_CHAR    = '6e400003b5a3f393e0a9e50e24dcca9e'; // device → desktop (notify)

let noble;
try {
  noble = require('@abandonware/noble');
} catch (_) {
  // noble is a native module and may not build in CI environments.
  // We emit a graceful degradation so the rest of the app still loads.
  noble = null;
}

/**
 * BleManager
 *
 * Wraps noble to:
 *   • scan for devices advertising the Nordic UART Service
 *   • connect / disconnect
 *   • send JSON lines on the RX characteristic (desktop → device)
 *   • receive JSON lines on the TX characteristic (device → desktop)
 *
 * Events:
 *   state(string)            – noble adapter state
 *   devices-found(array)     – list of { id, name, rssi } discovered so far
 *   connected(name)          – successfully connected
 *   disconnected()
 *   device-message(object)   – parsed JSON from device
 */
class BleManager extends EventEmitter {
  constructor() {
    super();
    this._peripheral = null;
    this._rxChar = null;       // write: desktop → device
    this._txChar = null;       // notify: device → desktop
    this._lineBuffer = '';
    this._foundDevices = new Map(); // id → { id, name, rssi }
    this._encrypted = false;
    this._scanning = false;

    if (!noble) {
      console.warn('[BLE] noble not available — BLE features disabled');
      return;
    }

    noble.on('stateChange', (state) => {
      this.emit('state', state);
      if (state === 'poweredOn' && this._scanning) {
        this._startScanInternal();
      }
    });

    noble.on('discover', (peripheral) => {
      this._onDiscover(peripheral);
    });
  }

  // --------------------------------------------------------------------------
  // Public API
  // --------------------------------------------------------------------------

  startScan() {
    if (!noble) { this.emit('state', 'unsupported'); return; }
    this._foundDevices.clear();
    this._scanning = true;
    if (noble.state === 'poweredOn') {
      this._startScanInternal();
    }
    // Otherwise wait for stateChange → poweredOn
  }

  stopScan() {
    if (!noble) return;
    this._scanning = false;
    noble.stopScanning();
  }

  connect(deviceId) {
    if (!noble) return;
    const entry = this._foundDevices.get(deviceId);
    if (!entry) {
      console.error('[BLE] unknown device id', deviceId);
      return;
    }
    this.stopScan();
    const peripheral = entry._peripheral;
    peripheral.connect((err) => {
      if (err) {
        console.error('[BLE] connect error', err);
        return;
      }
      this._peripheral = peripheral;
      peripheral.once('disconnect', () => {
        this._peripheral = null;
        this._rxChar = null;
        this._txChar = null;
        this._encrypted = false;
        this.emit('disconnected');
      });
      this._discoverNus(peripheral);
    });
  }

  disconnect() {
    if (this._peripheral) {
      this._peripheral.disconnect();
    }
  }

  unpair() {
    // noble doesn't expose bond management directly; best effort is disconnect
    this.disconnect();
  }

  isEncrypted() {
    return this._encrypted;
  }

  /**
   * Send a JSON-serialisable object as a newline-terminated UTF-8 string on
   * the NUS RX characteristic.  Silently drops if not connected.
   */
  sendJson(obj) {
    if (!this._rxChar) return;
    const line = JSON.stringify(obj) + '\n';
    const buf = Buffer.from(line, 'utf8');
    // BLE notifications fragment at the MTU boundary (~20 bytes by default,
    // up to 512 with negotiation). noble handles write fragmentation for us
    // when we use writeWithoutResponse = false (acknowledged write).
    this._rxChar.write(buf, false, (err) => {
      if (err) console.error('[BLE] write error', err);
    });
  }

  // --------------------------------------------------------------------------
  // Private helpers
  // --------------------------------------------------------------------------

  _startScanInternal() {
    // Filter to devices that advertise the Nordic UART Service
    noble.startScanning([NUS_SERVICE], false, (err) => {
      if (err) console.error('[BLE] startScanning error', err);
    });
  }

  _onDiscover(peripheral) {
    const name = peripheral.advertisement.localName || peripheral.id;
    // Accept any device advertising NUS (we already filtered by service UUID
    // in startScanning, so all discovered peripherals are NUS devices)
    const entry = {
      id: peripheral.id,
      name,
      rssi: peripheral.rssi,
      _peripheral: peripheral,
    };
    this._foundDevices.set(peripheral.id, entry);
    this.emit('devices-found', this._publicDeviceList());
  }

  _publicDeviceList() {
    return Array.from(this._foundDevices.values()).map(({ id, name, rssi }) => ({ id, name, rssi }));
  }

  _discoverNus(peripheral) {
    peripheral.discoverSomeServicesAndCharacteristics(
      [NUS_SERVICE],
      [NUS_RX_CHAR, NUS_TX_CHAR],
      (err, _services, characteristics) => {
        if (err) {
          console.error('[BLE] discoverSomeServicesAndCharacteristics error', err);
          peripheral.disconnect();
          return;
        }
        for (const c of characteristics) {
          const uuid = c.uuid.replace(/-/g, '').toLowerCase();
          if (uuid === NUS_RX_CHAR) this._rxChar = c;
          if (uuid === NUS_TX_CHAR) this._txChar = c;
        }
        if (!this._rxChar || !this._txChar) {
          console.error('[BLE] NUS characteristics not found');
          peripheral.disconnect();
          return;
        }
        // Subscribe to TX notifications (device → desktop)
        this._txChar.subscribe((err2) => {
          if (err2) console.error('[BLE] subscribe error', err2);
        });
        this._txChar.on('data', (data) => {
          this._lineBuffer += data.toString('utf8');
          const lines = this._lineBuffer.split('\n');
          this._lineBuffer = lines.pop(); // keep incomplete trailing fragment
          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed) continue;
            try {
              const msg = JSON.parse(trimmed);
              this.emit('device-message', msg);
            } catch (e) {
              console.warn('[BLE] bad JSON from device:', trimmed);
            }
          }
        });
        this.emit('connected', peripheral.advertisement.localName || peripheral.id);
      }
    );
  }
}

module.exports = BleManager;
