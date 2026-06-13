/**
 * OpenTelemetry SDK initialisation for Maestro.
 *
 * Activated when OTEL_EXPORTER_OTLP_ENDPOINT is set (standard OTel env var).
 * Exports traces via OTLP/HTTP proto. Auto-instruments http, pg, and dns.
 *
 * Import this as the VERY FIRST import in any entry point (before other imports)
 * so instrumentation patches are in place before modules are evaluated.
 *
 * No-op when the env var is absent — zero overhead in local dev.
 */

const endpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;

if (endpoint) {
  // Dynamic import: keeps the SDK out of the cold-start path when OTel is off.
  const { NodeSDK } = await import("@opentelemetry/sdk-node");
  const { OTLPTraceExporter } = await import("@opentelemetry/exporter-trace-otlp-proto");
  const { getNodeAutoInstrumentations } = await import("@opentelemetry/auto-instrumentations-node");
  const { Resource } = await import("@opentelemetry/sdk-node");
  const { SEMRESATTRS_SERVICE_NAME, SEMRESATTRS_SERVICE_VERSION } =
    await import("@opentelemetry/semantic-conventions");

  const { readFileSync } = await import("node:fs");
  const { createRequire } = await import("node:module");
  const { fileURLToPath } = await import("node:url");

  let serviceName = "maestro";
  let serviceVersion = "0.0.0";
  try {
    const req = createRequire(fileURLToPath(import.meta.url));
    const pkg = req("../../package.json");
    serviceName = pkg.name ?? serviceName;
    serviceVersion = pkg.version ?? serviceVersion;
  } catch { /* best effort */ }

  const sdk = new NodeSDK({
    resource: new Resource({
      [SEMRESATTRS_SERVICE_NAME]: process.env.OTEL_SERVICE_NAME ?? serviceName,
      [SEMRESATTRS_SERVICE_VERSION]: serviceVersion,
    }),
    traceExporter: new OTLPTraceExporter({ url: `${endpoint}/v1/traces` }),
    instrumentations: [
      getNodeAutoInstrumentations({
        "@opentelemetry/instrumentation-fs": { enabled: false },
      }),
    ],
  });

  sdk.start();

  process.on("SIGTERM", () => sdk.shutdown().finally(() => process.exit(0)));
  process.on("SIGINT", () => sdk.shutdown().finally(() => process.exit(0)));
}
