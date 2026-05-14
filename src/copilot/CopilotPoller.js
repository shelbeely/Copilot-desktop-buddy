'use strict';

const EventEmitter = require('events');
const { Octokit } = require('@octokit/rest');
const HeartbeatBuilder = require('./HeartbeatBuilder');

/**
 * CopilotPoller
 *
 * Polls the GitHub API for active Copilot cloud agent workflow runs and emits
 * periodic heartbeat snapshots compatible with the Hardware Buddy BLE protocol.
 *
 * GitHub Copilot coding agent runs appear as GitHub Actions workflow runs
 * triggered by the `copilot` actor on a repository, or as runs on the special
 * workflow "Copilot" / "copilot-setup-steps.yml". We collect all in-progress
 * workflow runs across the repos the user has access to and aggregate them.
 *
 * Events:
 *   snapshot(obj)  – heartbeat snapshot (send over BLE)
 *   turn(obj)      – turn event from a completed agent step
 *   error(Error)   – transient API error
 */
class CopilotPoller extends EventEmitter {
  constructor(store) {
    super();
    this._store = store;
    this._timer = null;
    this._heartbeatBuilder = new HeartbeatBuilder();
    this._lastSnapshot = null;
    this._pendingDecisions = new Map(); // prompt id → { resolve, reject }
    this._seenRunIds = new Set();       // track already-reported completed runs
    this._octokit = null;
  }

  // --------------------------------------------------------------------------
  // Lifecycle
  // --------------------------------------------------------------------------

  start() {
    this._buildOctokit();
    if (!this._octokit) return;
    this._poll();
    const interval = this._store.get('pollIntervalMs') || 10000;
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

  /**
   * Called when the hardware device sends a permission decision.
   * We store the decision so the next poll cycle can pick it up.
   * (Copilot cloud agent itself handles approvals on the GitHub side via
   * workflow run approvals / environment protection rules.)
   */
  applyPermissionDecision(promptId, decision) {
    const cb = this._pendingDecisions.get(promptId);
    if (cb) {
      cb(decision);
      this._pendingDecisions.delete(promptId);
    }
    // Also attempt to approve/reject the corresponding workflow run review
    // if we have a stored mapping.
    if (this._runReviewMap && this._runReviewMap.has(promptId)) {
      const { owner, repo, runId, environmentName } = this._runReviewMap.get(promptId);
      if (decision === 'once') {
        this._approveWorkflowRun(owner, repo, runId, environmentName).catch((e) =>
          console.warn('[Poller] approve error', e.message)
        );
      } else {
        this._rejectWorkflowRun(owner, repo, runId, environmentName).catch((e) =>
          console.warn('[Poller] reject error', e.message)
        );
      }
      this._runReviewMap.delete(promptId);
    }
  }

  // --------------------------------------------------------------------------
  // Private: polling
  // --------------------------------------------------------------------------

  _buildOctokit() {
    const token = this._store.get('githubToken');
    if (!token) {
      this._octokit = null;
      return;
    }
    this._octokit = new Octokit({ auth: token });
  }

  async _poll() {
    if (!this._octokit) return;

    try {
      const sessions = await this._fetchCopilotSessions();
      const snapshot = this._heartbeatBuilder.build(sessions);
      this._lastSnapshot = snapshot;
      this.emit('snapshot', snapshot);
    } catch (err) {
      this.emit('error', err);
    }
  }

  /**
   * Fetch all active Copilot cloud agent sessions.
   *
   * Strategy:
   * 1. List all repositories the authenticated user has access to.
   * 2. For each repo, list workflow runs with status=in_progress OR status=waiting
   *    that were triggered by the "copilot" actor or match the copilot workflow.
   * 3. Map each run to a CopilotSession object.
   *
   * For repos with waiting runs that require environment approval, build a
   * prompt object so the hardware device can approve/deny.
   */
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
    // Use the owner (org or user) from settings if provided; otherwise fall
    // back to all repos the token can see.
    const owner = this._store.get('githubOwner');
    try {
      if (owner) {
        // Try as org first, then as user
        let repos = [];
        try {
          const res = await this._octokit.paginate(
            this._octokit.repos.listForOrg,
            { org: owner, per_page: 100 },
            (r) => r.data.map((d) => `${d.owner.login}/${d.name}`)
          );
          repos = res;
        } catch {
          const res = await this._octokit.paginate(
            this._octokit.repos.listForUser,
            { username: owner, per_page: 100 },
            (r) => r.data.map((d) => `${d.owner.login}/${d.name}`)
          );
          repos = res;
        }
        return repos;
      }
      // No owner configured — use the authenticated user's repos
      const res = await this._octokit.paginate(
        this._octokit.repos.listForAuthenticatedUser,
        { per_page: 100, affiliation: 'owner,collaborator,organization_member' },
        (r) => r.data.map((d) => `${d.owner.login}/${d.name}`)
      );
      return res;
    } catch (err) {
      this.emit('error', err);
      return [];
    }
  }

  async _fetchCopilotRunsForRepo(owner, repo) {
    const sessions = [];

    for (const status of ['in_progress', 'waiting', 'queued']) {
      let runs;
      try {
        const res = await this._octokit.actions.listWorkflowRunsForRepo({
          owner,
          repo,
          status,
          per_page: 20,
          actor: 'copilot-swe-agent[bot]',
        });
        runs = res.data.workflow_runs;
      } catch {
        // Repo may not have Actions enabled or insufficient permissions
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

    // Fetch the most recent job step as the log line
    let logLine = run.display_title || run.name || '';
    let prompt = null;

    try {
      const jobsRes = await this._octokit.actions.listJobsForWorkflowRun({
        owner,
        repo,
        run_id: run.id,
        per_page: 5,
        filter: 'latest',
      });
      const latestJob = jobsRes.data.jobs[0];
      if (latestJob) {
        const inProgressStep = latestJob.steps
          ? latestJob.steps.find((s) => s.status === 'in_progress')
          : null;
        if (inProgressStep) {
          logLine = inProgressStep.name || logLine;
        }
      }
    } catch { /* ignore */ }

    // Check for pending deployment environment reviews (these are the
    // "permission prompts" equivalent for Copilot cloud agent workflows)
    if (status === 'waiting') {
      try {
        const reviewRes = await this._octokit.actions.getPendingDeploymentsForRun({
          owner,
          repo,
          run_id: run.id,
        });
        const pending = reviewRes.data[0];
        if (pending) {
          const promptId = `run_${run.id}_env_${pending.environment.id}`;
          prompt = {
            id: promptId,
            tool: 'DeploymentApproval',
            hint: `Approve deployment to "${pending.environment.name}" for ${owner}/${repo}`,
          };
          this._runReviewMap.set(promptId, {
            owner,
            repo,
            runId: run.id,
            environmentName: pending.environment.name,
          });
        }
      } catch { /* ignore — not all waiting runs have deployment reviews */ }
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

  async _approveWorkflowRun(owner, repo, runId, environmentName) {
    // Fetch the environment ID for the given name before approving
    const envId = await this._resolveEnvironmentId(owner, repo, runId, environmentName);
    await this._octokit.actions.reviewPendingDeploymentsForRun({
      owner,
      repo,
      run_id: runId,
      environment_ids: envId ? [envId] : [],
      state: 'approved',
      comment: 'Approved via Copilot Desktop Buddy',
    });
  }

  async _rejectWorkflowRun(owner, repo, runId, environmentName) {
    const envId = await this._resolveEnvironmentId(owner, repo, runId, environmentName);
    await this._octokit.actions.reviewPendingDeploymentsForRun({
      owner,
      repo,
      run_id: runId,
      environment_ids: envId ? [envId] : [],
      state: 'rejected',
      comment: 'Rejected via Copilot Desktop Buddy',
    });
  }

  /**
   * Returns the numeric environment ID for a pending deployment, or null.
   * We re-fetch pending deployments rather than caching to avoid stale data.
   */
  async _resolveEnvironmentId(owner, repo, runId, environmentName) {
    try {
      const res = await this._octokit.actions.getPendingDeploymentsForRun({
        owner,
        repo,
        run_id: runId,
      });
      const match = res.data.find(
        (d) => d.environment && d.environment.name === environmentName
      );
      return match ? match.environment.id : null;
    } catch {
      return null;
    }
  }

  static _mapRunStatus(status, conclusion) {
    if (status === 'in_progress') return 'running';
    if (status === 'queued') return 'running';
    if (status === 'waiting') return 'waiting';
    if (conclusion === 'success') return 'completed';
    return 'failed';
  }
}

module.exports = CopilotPoller;
