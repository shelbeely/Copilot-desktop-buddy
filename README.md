# Copilot Desktop Buddy

A desktop application that bridges your **GitHub Copilot cloud agent sessions** to any Bluetooth LE hardware device using the [Claude Hardware Buddy BLE protocol](https://github.com/anthropics/claude-desktop-buddy/blob/main/REFERENCE.md).

It does for GitHub Copilot what the Claude desktop app does for Claude — sending live heartbeat snapshots, permission prompts, and turn events to a small hardware device (Arduino, ESP32, nRF52, Raspberry Pi with BLE, …) over the **Nordic UART Service**.

---

## Features

| Feature | Details |
|---|---|
| **BLE bridge** | Scans for and connects to any device advertising the Nordic UART Service (NUS) |
| **Session monitoring** | Polls the GitHub Actions API for active Copilot cloud agent workflow runs |
| **Heartbeat snapshots** | Sends `total / running / waiting / msg / entries` payloads every poll cycle (≥ 10 s) |
| **Permission prompts** | Surfaces deployment-approval gates as hardware-buddy permission prompts; approve or deny from the device *or* the UI |
| **One-shot on connect** | Sends time-sync and owner-name messages immediately on device connection |
| **Status command** | Responds to `{"cmd":"status"}` polls from the device |
| **Settings UI** | Configure your GitHub token, owner/org, and poll interval — no config files needed |
| **Developer mode** | Adds a Developer menu for quick access to the BLE pairing window and DevTools |

---

## Prerequisites

- **Node.js 18 +** and **npm 9 +**
- **Bluetooth LE adapter** on your desktop (built-in or USB dongle)
  - macOS: built-in; grant Bluetooth permission when prompted
  - Linux: BlueZ ≥ 5.50; run as root or grant `CAP_NET_ADMIN` to the node binary
  - Windows: requires a WinUSB-compatible BLE adapter; see [noble docs](https://github.com/abandonware/noble#windows)
- A **GitHub Personal Access Token** with `repo` + `workflow` scopes
- A hardware device advertising the Nordic UART Service whose name starts with `Claude` (the default NUS scanner filter) or any NUS device — the app lists everything it finds

---

## Setup

```bash
# 1. Install dependencies
npm install

# 2. Start the app
npm start
```

On first launch the Settings panel opens automatically. Enter your GitHub token and (optionally) a username or organisation name to scope the repo search, then click **Save**.

Click the 📡 button (or enable Developer Mode → Developer → Open Hardware Buddy…) to scan for and connect your BLE device.

---

## Configuration

| Setting | Description |
|---|---|
| **GitHub Personal Access Token** | Classic PAT with `repo` and `workflow` scopes, or a fine-grained token with Actions read/write permissions |
| **GitHub Owner / Organisation** | Narrows the repo search. Leave blank to search all repos the token can see |
| **Poll Interval (ms)** | How often to refresh session data. Minimum 5 000 ms; the app also sends a keepalive every cycle even if nothing changed |
| **Developer Mode** | Adds a Developer menu to the menu bar (identical to Claude's "Enable Developer Mode") |

---

## BLE Protocol

This app implements the **desktop side** of the Hardware Buddy BLE protocol exactly as documented in [REFERENCE.md](https://github.com/anthropics/claude-desktop-buddy/blob/main/REFERENCE.md). Your hardware device does not need to know anything about GitHub — it just speaks the same NUS JSON-line protocol it would speak to the Claude desktop app.

### Heartbeat snapshot mapping

| Claude field | Copilot equivalent |
|---|---|
| `total` | Active Copilot agent workflow runs |
| `running` | Runs with `status = in_progress` or `queued` |
| `waiting` | Runs with `status = waiting` (pending deployment approval) |
| `msg` | `"approve: DeploymentApproval"` when waiting, otherwise latest step name |
| `entries` | Latest 5 runs, formatted as `HH:MM <owner>/<repo>: <title>` |
| `tokens` / `tokens_today` | `0` — GitHub API does not expose Copilot token counts |
| `prompt` | Present when a deployment-environment review is pending |

### Permission decisions

When `prompt` is present, your device can send:

```json
{"cmd":"permission","id":"run_12345_env_67","decision":"once"}
{"cmd":"permission","id":"run_12345_env_67","decision":"deny"}
```

`"once"` triggers a GitHub Actions deployment approval; `"deny"` rejects it.

You can also approve/deny directly in the desktop UI using the banner that appears.

---

## Project structure

```
src/
  main.js                  Electron main process — app lifecycle, IPC, wiring
  preload.js               Context bridge — exposes safe API to renderer
  ble/
    BleManager.js          Noble-based BLE manager (scan, connect, send/receive)
  copilot/
    CopilotPoller.js       GitHub API poller — fetches Copilot agent runs
    HeartbeatBuilder.js    Maps session data → BLE heartbeat snapshot format
  renderer/
    index.html             Main UI
    style.css              Dark-theme styles
    app.js                 UI logic
```

---

## Building a distributable

```bash
npm run build
```

Outputs platform-specific installers to `dist/` via `electron-builder`.

---

## Troubleshooting

**"noble not available — BLE features disabled"**
The native BLE module failed to compile. Run `npm rebuild` and check that you have the platform prerequisites installed (Python 3, make, a C++ compiler). On Linux also check BlueZ is installed.

**No devices appear during scan**
Make sure your device advertises the Nordic UART Service (`6e400001-…`). The app filters by that service UUID. Also verify your OS Bluetooth adapter is on and your app has Bluetooth permission (macOS will prompt on first scan).

**GitHub API rate limiting**
With a PAT the REST API allows 5 000 requests/hour. With a large number of repos and a 5 s poll interval you may approach this. Increase the poll interval or scope the Owner field to a specific org/user.
