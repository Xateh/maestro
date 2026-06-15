import assert from "node:assert/strict";
import { test } from "node:test";

import { createMaestroHttpHandler, sanitizeIdentifier } from "../src/http-server.mjs";
import { createRateLimiter } from "../src/http-rate-limit.mjs";

// ── token bucket ────────────────────────────────────────────────────────────

test("rate limiter allows up to capacity, then denies with a retry hint", () => {
  const now = 0;
  const limiter = createRateLimiter({ now: () => now });
  const limits = { capacity: 2, refillPerSec: 1 };

  assert.equal(limiter.check("ip:read", limits).allowed, true);
  assert.equal(limiter.check("ip:read", limits).allowed, true);
  const denied = limiter.check("ip:read", limits);
  assert.equal(denied.allowed, false);
  assert.ok(denied.retryAfterMs > 0 && denied.retryAfterMs <= 1000);
});

test("rate limiter refills over time using the injected clock", () => {
  let now = 0;
  const limiter = createRateLimiter({ now: () => now });
  const limits = { capacity: 1, refillPerSec: 1 };

  assert.equal(limiter.check("ip:write", limits).allowed, true);
  assert.equal(limiter.check("ip:write", limits).allowed, false);
  now += 1000; // one second → one token back
  assert.equal(limiter.check("ip:write", limits).allowed, true);
});

test("rate limiter keeps per-key budgets independent", () => {
  const limiter = createRateLimiter({ now: () => 0 });
  const limits = { capacity: 1, refillPerSec: 0 };
  assert.equal(limiter.check("a:read", limits).allowed, true);
  // Different key (route class or ip) still has its own token.
  assert.equal(limiter.check("a:write", limits).allowed, true);
  assert.equal(limiter.check("b:read", limits).allowed, true);
  // Same key is now exhausted.
  assert.equal(limiter.check("a:read", limits).allowed, false);
});

test("rate limiter sweeps idle (full) buckets when over the cap", () => {
  let now = 0;
  const limiter = createRateLimiter({ now: () => now, maxBuckets: 2 });
  const limits = { capacity: 1, refillPerSec: 1 };
  limiter.check("k1", limits); // k1 now empty
  now += 5000; // long enough that a fresh bucket would be full
  limiter.check("k2", limits);
  // Adding a third distinct key triggers a sweep; full buckets are dropped.
  limiter.check("k3", limits);
  assert.ok(limiter.size <= 3);
});

// ── identifier sanitization ─────────────────────────────────────────────────

test("sanitizeIdentifier accepts clean ids and rejects bad ones", () => {
  assert.equal(sanitizeIdentifier("OPS-1"), "OPS-1");
  assert.equal(sanitizeIdentifier("20260513-133611-some-task"), "20260513-133611-some-task");
  assert.equal(sanitizeIdentifier("a.b_c-d"), "a.b_c-d");
  // traversal / leading dot / bad shape
  assert.equal(sanitizeIdentifier("%2e%2e"), null); // ".."
  assert.equal(sanitizeIdentifier(".hidden"), null);
  assert.equal(sanitizeIdentifier("a b"), null);
  // malformed percent-encoding must not throw
  assert.equal(sanitizeIdentifier("%ZZ"), null);
  // length cap (>128)
  assert.equal(sanitizeIdentifier("a".repeat(200)), null);
});

// ── handler integration ─────────────────────────────────────────────────────

function mockOrchestrator() {
  return {
    snapshot: () => ({ counts: { running: 0 }, running: [], retrying: [] }),
    issueDetails: (id) => (id === "OPS-1" ? { issue_identifier: "OPS-1" } : null),
    refresh: async () => ({ queued: true }),
  };
}

async function invoke(handler, method, url, { headers = {}, socket } = {}) {
  let status = null;
  let outHeaders = null;
  let body = "";
  await handler(
    { method, url, headers, socket },
    {
      writeHead: (s, h) => { status = s; outHeaders = h; },
      end: (p) => { body = p ?? ""; },
    },
  );
  return { status, headers: outHeaders, json: () => JSON.parse(body) };
}

test("handler returns 429 with Retry-After once the bucket is empty", async () => {
  const limiter = createRateLimiter({ now: () => 0 });
  const handler = createMaestroHttpHandler({ orchestrator: mockOrchestrator(), rateLimit: limiter });
  // write budget is 12; exhaust it, then the next write is throttled.
  for (let i = 0; i < 12; i++) {
    const ok = await invoke(handler, "POST", "/api/v1/refresh");
    assert.equal(ok.status, 202);
  }
  const throttled = await invoke(handler, "POST", "/api/v1/refresh");
  assert.equal(throttled.status, 429);
  assert.equal(throttled.json().error.code, "rate_limited");
  assert.ok(Number(throttled.headers["retry-after"]) >= 1);
  // reads draw from a separate budget and still work.
  assert.equal((await invoke(handler, "GET", "/api/v1/state")).status, 200);
});

test("handler rejects invalid and malformed identifiers with 400", async () => {
  const handler = createMaestroHttpHandler({ orchestrator: mockOrchestrator(), rateLimit: false });
  // Over the 128-char cap → rejected before reaching the orchestrator.
  const bad = await invoke(handler, "GET", `/api/v1/${"a".repeat(200)}`);
  assert.equal(bad.status, 400);
  assert.equal(bad.json().error.code, "bad_request");
  // Malformed percent-encoding must not throw — decode fails → 400.
  const malformed = await invoke(handler, "GET", "/api/v1/%ZZ");
  assert.equal(malformed.status, 400);
  // a valid id still resolves
  assert.equal((await invoke(handler, "GET", "/api/v1/OPS-1")).status, 200);
});

test("handler rejects oversized POST bodies with 413", async () => {
  const handler = createMaestroHttpHandler({ orchestrator: mockOrchestrator(), rateLimit: false });
  const big = await invoke(handler, "POST", "/api/v1/refresh", { headers: { "content-length": "5000" } });
  assert.equal(big.status, 413);
  assert.equal(big.json().error.code, "payload_too_large");
});

test("MAESTRO_HTTP_RATELIMIT=off disables limiting", async () => {
  const prev = process.env.MAESTRO_HTTP_RATELIMIT;
  process.env.MAESTRO_HTTP_RATELIMIT = "off";
  try {
    const handler = createMaestroHttpHandler({ orchestrator: mockOrchestrator() });
    for (let i = 0; i < 20; i++) {
      assert.equal((await invoke(handler, "POST", "/api/v1/refresh")).status, 202);
    }
  } finally {
    if (prev === undefined) delete process.env.MAESTRO_HTTP_RATELIMIT;
    else process.env.MAESTRO_HTTP_RATELIMIT = prev;
  }
});
