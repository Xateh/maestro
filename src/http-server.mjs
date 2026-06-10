import http from "node:http";

function sendJson(response, status, body, extraHeaders = {}) {
  const payload = JSON.stringify(body);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
    "cache-control": "no-store",
    ...extraHeaders,
  });
  response.end(payload);
}

function sendHtml(response) {
  const body = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>Maestro</title>
  <style>
    body { font-family: system-ui, sans-serif; margin: 2rem; color: #17202a; }
    code { background: #eef2f5; padding: 0.15rem 0.3rem; border-radius: 4px; }
  </style>
</head>
<body>
  <h1>Maestro</h1>
  <p>Use <code>/api/v1/state</code>, <code>/api/v1/&lt;issue_identifier&gt;</code>, and <code>POST /api/v1/refresh</code>.</p>
</body>
</html>`;
  response.writeHead(200, {
    "content-type": "text/html; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store",
  });
  response.end(body);
}

function methodNotAllowed(response, allowed) {
  sendJson(response, 405, {
    error: { code: "method_not_allowed", message: `Allowed methods: ${allowed.join(", ")}` },
  }, { allow: allowed.join(", ") });
}

export function createMaestroHttpHandler({ orchestrator, host = "127.0.0.1" }) {
  return async function maestroHttpHandler(request, response) {
    const url = new URL(request.url ?? "/", `http://${host}`);
    try {
      if (url.pathname === "/") {
        if (request.method !== "GET") return methodNotAllowed(response, ["GET"]);
        sendHtml(response);
        return;
      }

      if (url.pathname === "/api/v1/state") {
        if (request.method !== "GET") return methodNotAllowed(response, ["GET"]);
        sendJson(response, 200, orchestrator.snapshot());
        return;
      }

      if (url.pathname === "/api/v1/refresh") {
        if (request.method !== "POST") return methodNotAllowed(response, ["POST"]);
        sendJson(response, 202, await orchestrator.refresh());
        return;
      }

      const detailMatch = url.pathname.match(/^\/api\/v1\/([^/]+)$/);
      if (detailMatch) {
        if (request.method !== "GET") return methodNotAllowed(response, ["GET"]);
        const identifier = decodeURIComponent(detailMatch[1]);
        const details = orchestrator.issueDetails(identifier);
        if (!details) {
          sendJson(response, 404, {
            error: { code: "issue_not_found", message: `No Maestro state for ${identifier}` },
          });
          return;
        }
        sendJson(response, 200, details);
        return;
      }

      sendJson(response, 404, {
        error: { code: "not_found", message: url.pathname },
      });
    } catch (error) {
      sendJson(response, 500, {
        error: { code: "internal_error", message: error.message },
      });
    }
  };
}

export async function startMaestroHttpServer({ orchestrator, port, host = "127.0.0.1" }) {
  const server = http.createServer(createMaestroHttpHandler({ orchestrator, host }));

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolve();
    });
  });

  return {
    server,
    host,
    port: server.address().port,
    close: () => new Promise((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    }),
  };
}
