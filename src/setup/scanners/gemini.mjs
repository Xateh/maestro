// Scanner for ~/.gemini/settings.json — model defaults and MCP server names.

import fs from "node:fs/promises";
import path from "node:path";

export async function scanGeminiSettings(filePath) {
  let parsed;
  try {
    parsed = JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch {
    return null;
  }
  return {
    path: path.resolve(filePath),
    model: typeof parsed?.model === "string" ? parsed.model : (parsed?.model?.name ?? null),
    mcpServers: Object.keys(parsed?.mcpServers ?? {}),
  };
}
