/**
 * ble.js — Web Bluetooth wrapper for the Nordic UART Service (NUS)
 *
 * Replaces the noble-based BleManager from the Electron build with the
 * browser Web Bluetooth API.  No device scanning list — Chrome shows its
 * own native device picker when requestAndConnect() is called.
 *
 * Key differences from the Electron version:
 *   • Uses EventTarget / CustomEvent instead of Node EventEmitter
 *   • requestDevice() requires a user gesture (button click)
 *   • Automatic reconnect is attempted when gattserverdisconnected fires
 *     (no new gesture needed; we already hold the BluetoothDevice reference)
 *   • Writes are chunked at 512 bytes (Web Bluetooth per-write limit)
 */

const NUS_SERVICE = '6e400001-b5a3-f393-e0a9-e50e24dcca9e';
const NUS_RX_UUID = '6e400002-b5a3-f393-e0a9-e50e24dcca9e'; // desktop → device (write)
const NUS_TX_UUID = '6e400003-b5a3-f393-e0a9-e50e24dcca9e'; // device → desktop (notify)

const BLE_WRITE_CHUNK = 512; // max bytes per writeValueWithResponse call
const RECONNECT_DELAY_MS = 2000;
const MAX_RECONNECT_ATTEMPTS = 5;

export class BleManager extends EventTarget {
  constructor() {
    super();
    this._device = null;
    this._rxChar = null;
    this._txChar = null;
    this._lineBuffer = '';
    this._reconnectAttempts = 0;
    this._intentionalDisconnect = false;
  }

  get isSupported() {
    return Boolean(navigator.bluetooth);
  }

  get isConnected() {
    return Boolean(this._device && this._device.gatt && this._device.gatt.connected);
  }

  get deviceName() {
    return this._device ? (this._device.name || this._device.id) : null;
  }

  /**
   * Show the browser's native Bluetooth device picker filtered to NUS devices,
   * then connect.  Must be called from a user gesture (click handler).
   */
  async requestAndConnect() {
    if (!this.isSupported) {
      throw new Error('Web Bluetooth is not supported in this browser. Use Chrome 56+ on desktop.');
    }

    this._intentionalDisconnect = false;
    this._reconnectAttempts = 0;

    const device = await navigator.bluetooth.requestDevice({
      filters: [{ services: [NUS_SERVICE] }],
    });

    this._device = device;
    device.addEventListener('gattserverdisconnected', () => this._onGattDisconnected());

    await this._connectGatt();
  }

  /** Gracefully disconnect and suppress auto-reconnect. */
  async disconnect() {
    this._intentionalDisconnect = true;
    if (this._device && this._device.gatt.connected) {
      this._device.gatt.disconnect();
    }
    this._rxChar = null;
    this._txChar = null;
  }

  /**
   * Send a JSON-serialisable object as a newline-terminated line.
   * Silently drops if not connected.
   */
  async sendJson(obj) {
    if (!this._rxChar) return;
    const encoded = new TextEncoder().encode(JSON.stringify(obj) + '\n');
    for (let offset = 0; offset < encoded.length; offset += BLE_WRITE_CHUNK) {
      const chunk = encoded.slice(offset, offset + BLE_WRITE_CHUNK);
      try {
        await this._rxChar.writeValueWithResponse(chunk);
      } catch (err) {
        console.warn('[BLE] write error', err);
        return;
      }
    }
  }

  // --------------------------------------------------------------------------
  // Private
  // --------------------------------------------------------------------------

  async _connectGatt() {
    const server = await this._device.gatt.connect();
    const service = await server.getPrimaryService(NUS_SERVICE);
    this._rxChar = await service.getCharacteristic(NUS_RX_UUID);
    this._txChar = await service.getCharacteristic(NUS_TX_UUID);

    this._txChar.addEventListener('characteristicvaluechanged', (e) => this._onData(e.target.value));
    await this._txChar.startNotifications();

    this._reconnectAttempts = 0;
    this.dispatchEvent(new CustomEvent('connected', { detail: this._device.name || this._device.id }));
  }

  _onGattDisconnected() {
    this._rxChar = null;
    this._txChar = null;

    if (this._intentionalDisconnect) {
      this.dispatchEvent(new Event('disconnected'));
      return;
    }

    // Auto-reconnect
    if (this._reconnectAttempts < MAX_RECONNECT_ATTEMPTS) {
      this._reconnectAttempts += 1;
      const delay = RECONNECT_DELAY_MS * this._reconnectAttempts;
      console.log(`[BLE] reconnecting in ${delay}ms (attempt ${this._reconnectAttempts})`);
      setTimeout(() => {
        this._connectGatt().catch((err) => {
          console.warn('[BLE] reconnect failed', err);
          this.dispatchEvent(new Event('disconnected'));
        });
      }, delay);
    } else {
      this.dispatchEvent(new Event('disconnected'));
    }
  }

  _onData(dataView) {
    this._lineBuffer += new TextDecoder().decode(dataView);
    const lines = this._lineBuffer.split('\n');
    this._lineBuffer = lines.pop(); // keep trailing incomplete fragment
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const msg = JSON.parse(trimmed);
        this.dispatchEvent(new CustomEvent('message', { detail: msg }));
      } catch {
        console.warn('[BLE] bad JSON from device:', trimmed);
      }
    }
  }
}
