/**
 * heartbeat.js — HeartbeatBuilder adapted for the browser
 *
 * Identical logic to src/copilot/HeartbeatBuilder.js but:
 *   • No require() / module.exports — ES module export
 *   • Buffer.byteLength replaced with TextEncoder
 */

export class HeartbeatBuilder {
  constructor() {
    this._cumulativeTokens = 0;
    this._tokensToday = 0;
    this._lastMidnight = HeartbeatBuilder._midnightEpoch();
  }

  /**
   * Build a heartbeat snapshot from an array of CopilotSession objects.
   */
  build(sessions) {
    this._rolloverTokensIfNeeded();

    const running = sessions.filter((s) => s.status === 'running').length;
    const waiting = sessions.filter((s) => s.status === 'waiting').length;
    const total   = sessions.length;

    const entries = sessions
      .slice()
      .sort((a, b) => (b.startedAt || '').localeCompare(a.startedAt || ''))
      .slice(0, 5)
      .map((s) => {
        const time = s.startedAt ? HeartbeatBuilder._shortTime(s.startedAt) : '';
        const label = s.logLine || s.title || s.id;
        return time ? `${time} ${label}` : label;
      });

    let msg = 'No active sessions';
    if (waiting > 0) {
      const w = sessions.find((s) => s.status === 'waiting');
      msg = `approve: ${w.prompt ? w.prompt.tool : w.title}`;
    } else if (running > 0) {
      const r = sessions.find((s) => s.status === 'running');
      msg = `running: ${r.logLine || r.title || r.id}`;
    } else if (total > 0) {
      msg = `${total} session${total !== 1 ? 's' : ''} open`;
    }

    const snapshot = { total, running, waiting, msg, entries,
      tokens: this._cumulativeTokens,
      tokens_today: this._tokensToday,
    };

    const waitingSessions = sessions.filter((s) => s.status === 'waiting' && s.prompt);
    if (waitingSessions.length > 0) {
      snapshot.prompt = waitingSessions[0].prompt;
    }

    return snapshot;
  }

  /**
   * Build a turn event capped at 4 KB.
   */
  buildTurnEvent(role, contentBlocks) {
    const evt = { evt: 'turn', role, content: contentBlocks };
    const serialised = JSON.stringify(evt);
    if (new TextEncoder().encode(serialised).byteLength > 4096) return null;
    return evt;
  }

  _rolloverTokensIfNeeded() {
    const midnight = HeartbeatBuilder._midnightEpoch();
    if (midnight > this._lastMidnight) {
      this._tokensToday = 0;
      this._lastMidnight = midnight;
    }
  }

  static _midnightEpoch() {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    return d.getTime();
  }

  static _shortTime(isoString) {
    try {
      return new Date(isoString).toLocaleTimeString([], {
        hour: '2-digit', minute: '2-digit', hour12: false,
      });
    } catch {
      return '';
    }
  }
}
