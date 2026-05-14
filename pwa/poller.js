/**
 * poller.js — GitHub API poller for Copilot cloud agent sessions
 *
 * Browser-native equivalent of src/copilot/CopilotPoller.js:
 *   • Uses fetch() instead of @octokit/rest
 *   • Settings read/written via the Settings helper (localStorage)
 *   • Uses EventTarget instead of Node EventEmitter
 *
 * Events (CustomEvent.detail):
 *   snapshot  – heartbeat snapshot object
 *   error     – Error object
 */

import { HeartbeatBuilder } from './heartbeat.js';

// --------------------------------------------------------------------------
// Lightweight GitHub API client (fetch-based)
// --------------------------------------------------------------------------

class GitHubClient {
  constructor(token) {
    this._token = token;
  }

  async get(path, params = {}) {
    const query = new URLSearchParams(params).toString();
    const url = `https://api.github.com${path}${query ? '?' + query : ''}`;
    const res = await fetch(url, {
      headers: {
        Authorization: `Bearer ${this._token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
      },
    });
    if (!res.ok) {
      throw new Error(`GitHub API ${res.status} ${res.statusText}: ${path}`);
    }
    return res.json();
  }

  async post(path, body) {
    const res = await fetch(`https://api.github.com${path}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this._token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`GitHub API ${res.status}: ${path} — ${text}`);
    }
    // 204 No Content is a success with no body
    if (res.status === 204) return null;
    return res.json();
  }
}

// --------------------------------------------------------------------------
// CopilotPoller
// --------------------------------------------------------------------------

export class CopilotPoller extends EventTarget {
  constructor(settings) {
    super();
    this._settings = settings; // { githubToken, githubOwner, pollIntervalMs }
    this._timer = null;
    this._heartbeatBuilder = new HeartbeatBuilder();
    this._lastSnapshot = null;
    this._runReviewMap = new Map();
    this._gh = null;
  }

  start() {
    this._buildClient();
    if (!this._gh) return;
    this._poll();
    const interval = Math.max(5000, this._settings.pollIntervalMs || 10000);
    this._timer = setInterval(() => this._poll(), interval);
  }

  stop() {
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = null;
    }
  }

  restart() {
    this.stop();
    this.start();
  }

  lastSnapshot() {
    return this._lastSnapshot;
  }

  updateSettings(settings) {
    this._settings = settings;
    this.restart();
  }

  applyPermissionDecision(promptId, decision) {
    if (!this._runReviewMap.has(promptId)) return;
    const { owner, repo, runId, environmentName } = this._runReviewMap.get(promptId);
    this._runReviewMap.delete(promptId);
    const action = decision === 'once' ? 'approved' : 'rejected';
    this._reviewRun(owner, repo, runId, environmentName, action).catch((e) =>
      console.warn('[Poller] review error', e.message)
    );
  }

  // --------------------------------------------------------------------------
  // Private
  // --------------------------------------------------------------------------

  _buildClient() {
    const token = this._settings.githubToken;
    this._gh = token ? new GitHubClient(token) : null;
  }

  async _poll() {
    if (!this._gh) return;
    try {
      const sessions = await this._fetchCopilotSessions();
      const snapshot = this._heartbeatBuilder.build(sessions);
      this._lastSnapshot = snapshot;
      this.dispatchEvent(new CustomEvent('snapshot', { detail: snapshot }));
    } catch (err) {
      this.dispatchEvent(new CustomEvent('error', { detail: err }));
    }
  }

  async _fetchCopilotSessions() {
    const repos = await this._listAccessibleRepos();
    const sessions = [];
    this._runReviewMap = new Map();

    await Promise.allSettled(
      repos.map(async (repo) => {
        const [owner, name] = repo.split('/');
        const runs = await this._fetchCopilotRunsForRepo(owner, name);
        sessions.push(...runs);
      })
    );

    return sessions;
  }

  async _listAccessibleRepos() {
    const owner = this._settings.githubOwner;
    try {
      if (owner) {
        // Try org first, then user
        try {
          const data = await this._gh.get(`/orgs/${encodeURIComponent(owner)}/repos`, { per_page: 100 });
          return data.map((r) => `${r.owner.login}/${r.name}`);
        } catch {
          const data = await this._gh.get(`/users/${encodeURIComponent(owner)}/repos`, { per_page: 100 });
          return data.map((r) => `${r.owner.login}/${r.name}`);
        }
      }
      const data = await this._gh.get('/user/repos', {
        per_page: 100,
        affiliation: 'owner,collaborator,organization_member',
      });
      return data.map((r) => `${r.owner.login}/${r.name}`);
    } catch (err) {
      this.dispatchEvent(new CustomEvent('error', { detail: err }));
      return [];
    }
  }

  async _fetchCopilotRunsForRepo(owner, repo) {
    const sessions = [];
    for (const status of ['in_progress', 'waiting', 'queued']) {
      let runs;
      try {
        const data = await this._gh.get(`/repos/${owner}/${repo}/actions/runs`, {
          status,
          per_page: 20,
          // GitHub Copilot coding agent runs are triggered by the
          // copilot-swe-agent[bot] actor.  This is the only actor used by
          // the GitHub-managed Copilot cloud agent feature (as of 2025).
          actor: 'copilot-swe-agent[bot]',
        });
        runs = data.workflow_runs;
      } catch {
        continue;
      }
      for (const run of runs) {
        const session = await this._runToSession(owner, repo, run, status);
        if (session) sessions.push(session);
      }
    }
    return sessions;
  }

  async _runToSession(owner, repo, run, status) {
    const sessionStatus = CopilotPoller._mapRunStatus(run.status, run.conclusion);
    let logLine = run.display_title || run.name || '';
    let prompt = null;

    try {
      const data = await this._gh.get(`/repos/${owner}/${repo}/actions/runs/${run.id}/jobs`, {
        per_page: 5,
        filter: 'latest',
      });
      const latestJob = data.jobs[0];
      if (latestJob && latestJob.steps) {
        const step = latestJob.steps.find((s) => s.status === 'in_progress');
        if (step) logLine = step.name || logLine;
      }
    } catch { /* ignore */ }

    if (status === 'waiting') {
      try {
        const pending = await this._gh.get(
          `/repos/${owner}/${repo}/actions/runs/${run.id}/pending_deployments`
        );
        if (Array.isArray(pending) && pending.length > 0) {
          const p = pending[0];
          const promptId = `run_${run.id}_env_${p.environment.id}`;
          prompt = {
            id: promptId,
            tool: 'DeploymentApproval',
            hint: `Approve deployment to "${p.environment.name}" for ${owner}/${repo}`,
          };
          this._runReviewMap.set(promptId, {
            owner, repo, runId: run.id, environmentName: p.environment.name,
          });
        }
      } catch { /* ignore */ }
    }

    return {
      id: String(run.id),
      title: `${owner}/${repo}: ${run.display_title || run.name}`,
      status: sessionStatus,
      startedAt: run.run_started_at || run.created_at,
      logLine,
      prompt,
    };
  }

  async _reviewRun(owner, repo, runId, environmentName, state) {
    // Resolve environment ID
    let environmentIds = [];
    try {
      const pending = await this._gh.get(
        `/repos/${owner}/${repo}/actions/runs/${runId}/pending_deployments`
      );
      if (Array.isArray(pending)) {
        const match = pending.find((d) => d.environment && d.environment.name === environmentName);
        if (match) environmentIds = [match.environment.id];
      }
    } catch { /* proceed with empty list */ }

    await this._gh.post(`/repos/${owner}/${repo}/actions/runs/${runId}/pending_deployments`, {
      environment_ids: environmentIds,
      state,
      comment: `${state === 'approved' ? 'Approved' : 'Rejected'} via Copilot Desktop Buddy`,
    });
  }

  static _mapRunStatus(status, conclusion) {
    if (status === 'in_progress') return 'running';
    if (status === 'queued') return 'running';
    if (status === 'waiting') return 'waiting';
    if (conclusion === 'success') return 'completed';
    return 'failed';
  }
}
