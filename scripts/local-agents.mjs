#!/usr/bin/env node
// Example agents that exercise the built-in Ollama (local LLM) provider
// through the real TerminalAgentRunner dispatch path.
//
//   node scripts/local-agents.mjs ocr <image>   OCR agent (vision model)
//   node scripts/local-agents.mjs eval          system evaluator agent
//
// Env overrides:
//   MAESTRO_OLLAMA_BIN           ollama binary or alias (default "ollama")
//   MAESTRO_OLLAMA_MODEL         text model            (default "llama3.2")
//   MAESTRO_OLLAMA_VISION_MODEL  vision model          (default "llama3.2-vision")

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";

import { TerminalAgentRunner } from "../src/agent-runner.mjs";
import { DEFAULT_OLLAMA_MODEL } from "../src/adapters/ollama.mjs";

const USAGE = `Usage: node scripts/local-agents.mjs <ocr|eval> [args]

  ocr <image-path>   Extract all text from an image with a local vision model.
  eval               Evaluate this machine's readiness for local LLM work.

Env: MAESTRO_OLLAMA_BIN, MAESTRO_OLLAMA_MODEL, MAESTRO_OLLAMA_VISION_MODEL
`;

const OLLAMA_BIN = process.env.MAESTRO_OLLAMA_BIN || "ollama";
const TEXT_MODEL = process.env.MAESTRO_OLLAMA_MODEL || DEFAULT_OLLAMA_MODEL;
const VISION_MODEL = process.env.MAESTRO_OLLAMA_VISION_MODEL || "llama3.2-vision";

function providerDef() {
  return {
    label: "Ollama (local)",
    adapter: "built-in:ollama",
    default_alias: OLLAMA_BIN,
  };
}

async function runAgent({ role, prompt, model }) {
  const cwd = process.cwd();
  const logDir = path.join(cwd, ".maestro", "logs", "local-agents",
    new Date().toISOString().replace(/[:.]/g, "-"));
  const runner = new TerminalAgentRunner({ timeoutMs: 600_000 });
  const result = await runner.runStep({
    provider: "ollama",
    role,
    prompt,
    cwd,
    logDir,
    options: { model },
    providerDef: providerDef(),
  });
  return result;
}

async function gatherSystemFacts() {
  const cpus = os.cpus();
  let disk = "unknown";
  try {
    const stats = await fs.statfs(os.homedir());
    const freeGb = (stats.bavail * stats.bsize) / 1024 ** 3;
    const totalGb = (stats.blocks * stats.bsize) / 1024 ** 3;
    disk = `${freeGb.toFixed(1)} GiB free of ${totalGb.toFixed(1)} GiB`;
  } catch {
    // statfs unsupported on this platform; report what we have.
  }
  return [
    `platform: ${os.platform()} ${os.release()} (${os.arch()})`,
    `cpu: ${cpus[0]?.model ?? "unknown"} x${cpus.length}`,
    `memory: ${(os.freemem() / 1024 ** 3).toFixed(1)} GiB free of ${(os.totalmem() / 1024 ** 3).toFixed(1)} GiB`,
    `disk (home): ${disk}`,
    `node: ${process.version}`,
    `load average (1m/5m/15m): ${os.loadavg().map((n) => n.toFixed(2)).join(" / ")}`,
  ].join("\n");
}

async function ocrAgent(imageArg) {
  if (!imageArg) {
    process.stderr.write(`Missing image path.\n\n${USAGE}`);
    process.exit(1);
  }
  const imagePath = path.resolve(imageArg);
  try {
    await fs.access(imagePath);
  } catch {
    process.stderr.write(`Image not found: ${imagePath}\n`);
    process.exit(1);
  }
  const prompt = [
    "You are an OCR agent.",
    "Transcribe ALL text visible in the image below, preserving line breaks and reading order.",
    "Respond with the transcribed text only — no commentary, no markdown fences.",
    "If the image contains no text, respond exactly with: NO TEXT FOUND",
    "",
    imagePath,
  ].join("\n");
  return runAgent({ role: "ocr", prompt, model: VISION_MODEL });
}

async function evalAgent() {
  const facts = await gatherSystemFacts();
  const prompt = [
    "You are a system evaluator agent.",
    "Assess the machine described below for (a) general developer workload health",
    "and (b) suitability for running local LLMs via Ollama.",
    "Flag concrete risks (low disk, low RAM, high load), then give a one-line",
    "verdict: READY, READY WITH WARNINGS, or NOT READY.",
    "",
    "System facts:",
    facts,
  ].join("\n");
  return runAgent({ role: "system-evaluator", prompt, model: TEXT_MODEL });
}

async function main() {
  const [, , command, ...rest] = process.argv;
  let result;
  try {
    if (command === "ocr") {
      result = await ocrAgent(rest[0]);
    } else if (command === "eval") {
      result = await evalAgent();
    } else {
      process.stderr.write(USAGE);
      process.exit(command ? 1 : 0);
    }
  } catch (error) {
    if (error?.exitCode === 127 || error?.code === "ENOENT") {
      process.stderr.write(
        `Could not run "${OLLAMA_BIN}". Install Ollama (https://ollama.com/download), then:\n` +
        `  ollama pull ${TEXT_MODEL}\n  ollama pull ${VISION_MODEL}\n`,
      );
    } else {
      process.stderr.write(`${error.message}\n`);
      if (error.stderr) process.stderr.write(`${error.stderr}\n`);
      if (error.stdoutPath) process.stderr.write(`logs: ${error.stdoutPath}\n`);
    }
    process.exit(1);
  }
  process.stdout.write(result.stdout.trim() ? `${result.stdout.trim()}\n` : "(empty response)\n");
  process.stderr.write(`logs: ${result.stdoutPath}\n`);
}

await main();
