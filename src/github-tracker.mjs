function trackerError(code, message = code, cause = null) {
  const error = new Error(`${code}: ${message}`);
  error.code = code;
  if (cause) error.cause = cause;
  return error;
}

export function normalizeGitHubIssue(raw) {
  const labels = (raw.labels ?? []).map((l) => (typeof l === "string" ? l : l?.name)).filter(Boolean);
  // Priority from label "priority:high" / "priority:medium" / "priority:low"
  const priorityLabel = labels.find((l) => l.startsWith("priority:"));
  const PRIORITY_MAP = { "priority:urgent": 1, "priority:high": 2, "priority:medium": 3, "priority:low": 4 };
  const priority = priorityLabel ? (PRIORITY_MAP[priorityLabel] ?? null) : null;
  return {
    id: String(raw.id ?? raw.number),
    identifier: `GH-${raw.number}`,
    title: raw.title ?? null,
    description: raw.body ?? null,
    priority,
    state: raw.state ?? null,
    labels,
    url: raw.html_url ?? null,
    created_at: raw.created_at ?? null,
    updated_at: raw.updated_at ?? null,
  };
}

export class GitHubTrackerClient {
  constructor({
    owner,
    repo,
    label = "maestro",
    token,
    fetchImpl = fetch,
    pageSize = 100,
    rateLimitThreshold = 10,
    backoffFn = () => new Promise((r) => setTimeout(r, 60_000)),
  }) {
    this.owner = owner;
    this.repo = repo;
    this.label = label;
    this.token = token;
    this.fetchImpl = fetchImpl;
    this.pageSize = pageSize;
    this.rateLimitThreshold = rateLimitThreshold;
    this.backoffFn = backoffFn;
  }

  _headers() {
    return {
      Authorization: `Bearer ${this.token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "Content-Type": "application/json",
    };
  }

  async _checkRateLimit(response) {
    const remaining = Number.parseInt(response.headers.get("x-ratelimit-remaining") ?? "", 10);
    if (Number.isFinite(remaining) && remaining <= this.rateLimitThreshold) {
      await this.backoffFn();
    }
  }

  async fetchCandidates() {
    const url = `https://api.github.com/repos/${this.owner}/${this.repo}/issues?labels=${encodeURIComponent(this.label)}&state=open&per_page=${this.pageSize}`;
    let response;
    try {
      response = await this.fetchImpl(url, { headers: this._headers() });
    } catch (err) {
      throw trackerError("github_api_request", err.message, err);
    }
    if (!response.ok) throw trackerError("github_api_status", String(response.status));
    await this._checkRateLimit(response);
    const payload = await response.json();
    const items = Array.isArray(payload) ? payload : (payload.items ?? []);
    return items.map(normalizeGitHubIssue);
  }

  // Orchestrator adapter: delegates to fetchCandidates (activeStates unused for
  // GitHub — issues are filtered by label, not state names).
  async fetchCandidateIssues(_activeStates) {
    return this.fetchCandidates();
  }

  // Orchestrator adapter: re-fetch individual issues by numeric id/number to get
  // current state ("open" / "closed"). GitHub has no batch endpoint, so we fan
  // out sequentially; the list is at most maxConcurrentAgents long.
  async fetchIssueStatesByIds(issueIds) {
    if (!Array.isArray(issueIds) || issueIds.length === 0) return [];
    const results = [];
    for (const id of issueIds) {
      // id is stored as String(raw.number) by normalizeGitHubIssue
      const url = `https://api.github.com/repos/${this.owner}/${this.repo}/issues/${id}`;
      let response;
      try {
        response = await this.fetchImpl(url, { headers: this._headers() });
      } catch (err) {
        throw trackerError("github_api_request", err.message, err);
      }
      if (!response.ok) throw trackerError("github_api_status", String(response.status));
      await this._checkRateLimit(response);
      const raw = await response.json();
      results.push(normalizeGitHubIssue(raw));
    }
    return results;
  }

  // Orchestrator adapter: close the issue when status is "succeeded"; for other
  // statuses (waiting_user / waiting_approval) add a label. GitHub has no
  // workflow-state concept, so stateName is interpreted as an action keyword:
  //   "closed" / "done"  → close the issue
  //   anything else      → add as a label
  async transitionIssue(issueId, stateName) {
    if (!issueId || !stateName) return false;
    const lower = String(stateName).toLowerCase();
    if (lower === "closed" || lower === "done") {
      await this.closeIssue(issueId);
    } else {
      await this.addLabel(issueId, stateName);
    }
    return true;
  }

  async commentOnIssue(number, body) {
    const url = `https://api.github.com/repos/${this.owner}/${this.repo}/issues/${number}/comments`;
    const response = await this.fetchImpl(url, {
      method: "POST",
      headers: this._headers(),
      body: JSON.stringify({ body }),
    });
    if (!response.ok) throw trackerError("github_api_status", String(response.status));
  }

  async closeIssue(number) {
    const url = `https://api.github.com/repos/${this.owner}/${this.repo}/issues/${number}`;
    const response = await this.fetchImpl(url, {
      method: "PATCH",
      headers: this._headers(),
      body: JSON.stringify({ state: "closed" }),
    });
    if (!response.ok) throw trackerError("github_api_status", String(response.status));
  }

  async addLabel(number, label) {
    const url = `https://api.github.com/repos/${this.owner}/${this.repo}/issues/${number}/labels`;
    const response = await this.fetchImpl(url, {
      method: "POST",
      headers: this._headers(),
      body: JSON.stringify({ labels: [label] }),
    });
    if (!response.ok) throw trackerError("github_api_status", String(response.status));
  }
}
