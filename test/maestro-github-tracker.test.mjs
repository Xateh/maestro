import assert from "node:assert/strict";
import { test } from "node:test";
import { GitHubTrackerClient, normalizeGitHubIssue } from "../src/github-tracker.mjs";
import { MaestroOrchestrator } from "../src/orchestrator.mjs";

// ── normalizeGitHubIssue ──────────────────────────────────────────────────────
test("normalizeGitHubIssue: maps GitHub REST issue to NormalizedIssue shape", () => {
  const raw = {
    id: 12345,
    number: 42,
    title: "Fix the bug",
    body: "Details here",
    state: "open",
    labels: [{ name: "maestro" }, { name: "priority:high" }],
    html_url: "https://github.com/acme/backend/issues/42",
    created_at: "2026-06-01T00:00:00Z",
    updated_at: "2026-06-02T00:00:00Z",
  };
  const issue = normalizeGitHubIssue(raw);
  assert.equal(issue.identifier, "GH-42");
  assert.equal(issue.title, "Fix the bug");
  assert.equal(issue.description, "Details here");
  assert.deepEqual(issue.labels, ["maestro", "priority:high"]);
  assert.equal(issue.state, "open");
  assert.ok(issue.url.includes("42"));
});

// ── fetchCandidates ───────────────────────────────────────────────────────────
function makeMockFetch(issues, headers = {}) {
  return async () => ({
    ok: true,
    headers: {
      get: (h) => ({ "x-ratelimit-remaining": "50", ...headers })[h] ?? null,
    },
    json: async () => ({ items: issues }),
  });
}

test("fetchCandidates: returns normalized issues with matching label", async () => {
  const raw = [{
    id: 1, number: 7, title: "Task A", body: "body", state: "open",
    labels: [{ name: "maestro" }], html_url: "http://gh/7",
    created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z",
  }];
  const client = new GitHubTrackerClient({
    owner: "acme", repo: "backend", label: "maestro",
    token: "ghp_fake",
    fetchImpl: makeMockFetch(raw),
  });
  const issues = await client.fetchCandidates();
  assert.equal(issues.length, 1);
  assert.equal(issues[0].identifier, "GH-7");
});

test("fetchCandidates: backs off when x-ratelimit-remaining <= 10", async () => {
  let calledLimiter = false;
  const raw = [{ id: 1, number: 1, title: "T", body: "", state: "open",
    labels: [{ name: "maestro" }], html_url: "http://gh/1",
    created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z" }];
  const client = new GitHubTrackerClient({
    owner: "acme", repo: "backend", label: "maestro", token: "ghp_fake",
    fetchImpl: makeMockFetch(raw, { "x-ratelimit-remaining": "5" }),
    providerLimiter: {
      acquire: async () => {
        calledLimiter = true;
      },
    },
  });
  await client.fetchCandidates();
  assert.ok(calledLimiter, "acquire should be called when rate limit is low");
});

test("fetchCandidates: non-ok response throws github_api_status error", async () => {
  const client = new GitHubTrackerClient({
    owner: "acme", repo: "backend", label: "maestro", token: "ghp_fake",
    fetchImpl: async () => ({ ok: false, status: 403, headers: { get: () => null }, json: async () => ({}) }),
  });
  await assert.rejects(() => client.fetchCandidates(), /github_api_status/);
});

// ── write-backs ───────────────────────────────────────────────────────────────
test("commentOnIssue: posts to /repos/owner/repo/issues/N/comments", async () => {
  let captured = null;
  const client = new GitHubTrackerClient({
    owner: "acme", repo: "backend", label: "maestro", token: "ghp_fake",
    fetchImpl: async (url, opts) => {
      captured = { url, body: JSON.parse(opts.body) };
      return { ok: true, headers: { get: () => "50" }, json: async () => ({}) };
    },
  });
  await client.commentOnIssue(42, "Run completed: succeeded");
  assert.ok(captured.url.includes("/issues/42/comments"), captured.url);
  assert.equal(captured.body.body, "Run completed: succeeded");
});

// ── orchestrator adapter methods ──────────────────────────────────────────────

test("fetchCandidateIssues: delegates to fetchCandidates, ignores activeStates param", async () => {
  const raw = [{ id: 1, number: 9, title: "T", body: "", state: "open",
    labels: [{ name: "maestro" }], html_url: "http://gh/9",
    created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z" }];
  const client = new GitHubTrackerClient({
    owner: "acme", repo: "backend", label: "maestro", token: "tok",
    fetchImpl: makeMockFetch(raw),
  });
  const results = await client.fetchCandidateIssues(["open", "in-progress"]);
  assert.equal(results.length, 1);
  assert.equal(results[0].identifier, "GH-9");
});

test("fetchIssueStatesByIds: fetches each id individually and returns normalized issues", async () => {
  const fetched = [];
  const client = new GitHubTrackerClient({
    owner: "acme", repo: "backend", label: "maestro", token: "tok",
    fetchImpl: async (url) => {
      fetched.push(url);
      const num = url.split("/").pop();
      return {
        ok: true,
        headers: { get: () => "50" },
        json: async () => ({ id: Number(num), number: Number(num), title: "T",
          body: "", state: "closed", labels: [], html_url: `http://gh/${num}`,
          created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z" }),
      };
    },
  });
  const results = await client.fetchIssueStatesByIds(["5", "7"]);
  assert.equal(results.length, 2);
  assert.ok(results.every((r) => r.state === "closed"));
  assert.ok(fetched.some((u) => u.endsWith("/issues/5")));
  assert.ok(fetched.some((u) => u.endsWith("/issues/7")));
});

test("fetchIssueStatesByIds: returns empty array for empty input (no fetch)", async () => {
  const client = new GitHubTrackerClient({
    owner: "acme", repo: "backend", label: "maestro", token: "tok",
    fetchImpl: async () => { throw new Error("should not be called"); },
  });
  assert.deepEqual(await client.fetchIssueStatesByIds([]), []);
});

test("transitionIssue: 'done' closes the issue via PATCH state=closed", async () => {
  const calls = [];
  const client = new GitHubTrackerClient({
    owner: "acme", repo: "backend", label: "maestro", token: "tok",
    fetchImpl: async (url, opts) => {
      calls.push({ url, body: JSON.parse(opts?.body ?? "{}") });
      return { ok: true, headers: { get: () => "50" }, json: async () => ({}) };
    },
  });
  const result = await client.transitionIssue("42", "done");
  assert.equal(result, true);
  assert.ok(calls[0].url.endsWith("/issues/42"));
  assert.equal(calls[0].body.state, "closed");
});

test("transitionIssue: 'closed' closes the issue", async () => {
  const calls = [];
  const client = new GitHubTrackerClient({
    owner: "acme", repo: "backend", label: "maestro", token: "tok",
    fetchImpl: async (url, opts) => {
      calls.push({ url, body: JSON.parse(opts?.body ?? "{}") });
      return { ok: true, headers: { get: () => "50" }, json: async () => ({}) };
    },
  });
  await client.transitionIssue("42", "closed");
  assert.equal(calls[0].body.state, "closed");
});

test("transitionIssue: non-done stateName adds it as a label", async () => {
  const calls = [];
  const client = new GitHubTrackerClient({
    owner: "acme", repo: "backend", label: "maestro", token: "tok",
    fetchImpl: async (url, opts) => {
      calls.push({ url, body: JSON.parse(opts?.body ?? "{}") });
      return { ok: true, headers: { get: () => "50" }, json: async () => ({}) };
    },
  });
  await client.transitionIssue("42", "blocked");
  assert.deepEqual(calls[0].body.labels, ["blocked"]);
  assert.ok(calls[0].url.endsWith("/issues/42/labels"));
});

test("transitionIssue: returns false for null issueId or stateName without fetching", async () => {
  let called = false;
  const client = new GitHubTrackerClient({
    owner: "acme", repo: "backend", label: "maestro", token: "tok",
    fetchImpl: async () => { called = true; return { ok: true, headers: { get: () => null }, json: async () => ({}) }; },
  });
  assert.equal(await client.transitionIssue(null, "done"), false);
  assert.equal(await client.transitionIssue("42", null), false);
  assert.equal(called, false);
});

// ── orchestrator + GitHub tracker path ───────────────────────────────────────

function ghIssueNormalized(overrides = {}) {
  return normalizeGitHubIssue({
    id: 101, number: 42, title: "Fix the thing", body: "desc", state: "open",
    labels: [{ name: "maestro" }], html_url: "https://github.com/a/b/issues/42",
    created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-02T00:00:00Z",
    ...overrides,
  });
}

function buildOrchestratorWithGithubTracker({ runStatus = "succeeded", notifyConfig = null, transitionIssue } = {}) {
  const tracker = {
    fetchCandidateIssues: async () => [ghIssueNormalized()],
    fetchIssueStatesByIds: async () => [],
    transitionIssue: transitionIssue ?? (async () => true),
  };
  const runner = { run: async () => ({ status: runStatus }), cancel: () => {} };
  const config = {
    tracker: { kind: "github", activeStates: ["open"], terminalStates: ["closed"], doneState: null, blockedState: null },
    polling: { intervalMs: 30_000 },
    agent: { maxConcurrentAgents: 2, maxConcurrentAgentsByState: {}, maxRetryBackoffMs: 300_000, stallTimeoutMs: 300_000 },
    notify: notifyConfig,
  };
  const orchestrator = new MaestroOrchestrator({
    config, tracker, runner,
    workspaceManager: { removeForIssue: async () => {} },
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    timers: { setTimeout: () => ({}), clearTimeout: () => {} },
  });
  return { orchestrator };
}

test("orchestrator tick dispatches issues from GitHubTrackerClient.fetchCandidateIssues", async () => {
  const dispatched = [];
  const { orchestrator } = buildOrchestratorWithGithubTracker({ runStatus: "succeeded" });
  orchestrator.runner = {
    run: async ({ issue }) => { dispatched.push(issue.identifier); return { status: "succeeded" }; },
    cancel: () => {},
  };
  await orchestrator.tick();
  assert.ok(dispatched.includes("GH-42"), `expected GH-42 in dispatched, got: ${dispatched}`);
});

test("orchestrator records succeeded status in completed map after GitHub tracker run", async () => {
  const issue = ghIssueNormalized();
  const { orchestrator } = buildOrchestratorWithGithubTracker({ runStatus: "succeeded" });
  await orchestrator.runIssue(issue, 0, false);
  const entry = [...orchestrator.runtime.completed.values()][0];
  assert.equal(entry.status, "succeeded");
  assert.equal(entry.issue_identifier, "GH-42");
});

test("orchestrator calls transitionIssue(doneState) via GitHub tracker on succeeded run", async () => {
  const transitions = [];
  const issue = ghIssueNormalized();
  const { orchestrator } = buildOrchestratorWithGithubTracker({
    runStatus: "succeeded",
    transitionIssue: async (id, state) => { transitions.push({ id, state }); return true; },
  });
  orchestrator.config.tracker.doneState = "done";
  await orchestrator.runIssue(issue, 0, false);
  assert.deepEqual(transitions, [{ id: "101", state: "done" }]);
});

test("orchestrator sendNotification is fire-and-forget: run completes even with unreachable notify URL", async () => {
  const issue = ghIssueNormalized();
  const { orchestrator } = buildOrchestratorWithGithubTracker({
    runStatus: "succeeded",
    notifyConfig: { on: ["completed"], url: "http://localhost:19999/no-such-endpoint", format: "generic" },
  });
  // notify fetch will fail (connection refused) but must not propagate
  await assert.doesNotReject(() => orchestrator.runIssue(issue, 0, false));
  assert.equal(orchestrator.runtime.completed.size, 1);
});

test("orchestrator does not call notify when notifyConfig is null", async () => {
  const issue = ghIssueNormalized();
  const { orchestrator } = buildOrchestratorWithGithubTracker({ runStatus: "succeeded", notifyConfig: null });
  await assert.doesNotReject(() => orchestrator.runIssue(issue, 0, false));
  assert.equal(orchestrator.lastError, null);
});
