'use strict';

/**
 * HeartbeatBuilder
 *
 * Converts GitHub Copilot cloud agent session data (fetched via the GitHub
 * Actions / Issues APIs) into the heartbeat snapshot format described in the
 * Claude Hardware Buddy BLE protocol reference.
 *
 * Snapshot shape:
 * {
 *   total:        <int>   – all open agent sessions (in-progress workflow runs)
 *   running:      <int>   – actively generating (in_progress)
 *   waiting:      <int>   – blocked on a permission / review prompt
 *   msg:          <str>   – one-line summary for small displays
 *   entries:      <str[]> – recent log lines, newest first
 *   tokens:       <int>   – cumulative tokens (not available from GitHub API; 0)
 *   tokens_today: <int>   – tokens today (not available; 0)
 *   prompt:       <obj>   – present only when a decision is needed
 * }
 */
class HeartbeatBuilder {
  constructor() {
    this._cumulativeTokens = 0;
    this._tokensToday = 0;
    this._lastMidnight = HeartbeatBuilder._midnightEpoch();
  }

  /**
   * Build a heartbeat snapshot from an array of CopilotSession objects.
   *
   * Each CopilotSession:
   * {
   *   id:        string   – unique identifier (workflow run id or issue number string)
   *   title:     string   – short description (PR title, issue title, step name …)
   *   status:    'running' | 'waiting' | 'completed' | 'failed'
   *   startedAt: string   – ISO timestamp
   *   logLine:   string?  – latest log / step description
   *   prompt:    { id, tool, hint }?  – present if decision needed
   * }
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

    const snapshot = {
      total,
      running,
      waiting,
      msg,
      entries,
      tokens: this._cumulativeTokens,
      tokens_today: this._tokensToday,
    };

    // Include prompt from the first waiting session
    const waitingSessions = sessions.filter((s) => s.status === 'waiting' && s.prompt);
    if (waitingSessions.length > 0) {
      snapshot.prompt = waitingSessions[0].prompt;
    }

    return snapshot;
  }

  /**
   * Build a turn event from a completed agent step.
   * Only emitted for events that are ≤ 4 KB serialised.
   */
  buildTurnEvent(role, contentBlocks) {
    const evt = { evt: 'turn', role, content: contentBlocks };
    const serialised = JSON.stringify(evt);
    if (Buffer.byteLength(serialised, 'utf8') > 4096) return null;
    return evt;
  }

  // --------------------------------------------------------------------------
  // Private helpers
  // --------------------------------------------------------------------------

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
      const d = new Date(isoString);
      return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
    } catch {
      return '';
    }
  }
}

module.exports = HeartbeatBuilder;
