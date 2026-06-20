import assert from "node:assert/strict";
import { test } from "node:test";
import { GitHubTrackerClient, normalizeGitHubIssue } from "../src/github-tracker.mjs";

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
  let calledDelay = false;
  const raw = [{ id: 1, number: 1, title: "T", body: "", state: "open",
    labels: [{ name: "maestro" }], html_url: "http://gh/1",
    created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z" }];
  const client = new GitHubTrackerClient({
    owner: "acme", repo: "backend", label: "maestro", token: "ghp_fake",
    fetchImpl: makeMockFetch(raw, { "x-ratelimit-remaining": "5" }),
    backoffFn: async () => { calledDelay = true; }, // injectable for test
  });
  await client.fetchCandidates();
  assert.ok(calledDelay, "backoff should be called when rate limit is low");
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
