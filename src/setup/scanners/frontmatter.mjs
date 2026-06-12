// Lenient YAML-frontmatter parser for external artifacts (SKILL.md, subagent
// .md files). Unlike workflow.mjs's strict parser, malformed frontmatter
// degrades to { frontmatter: null } so a single bad file never aborts a scan.

import YAML from "yaml";

export function parseFrontmatter(text) {
  const source = String(text ?? "");
  const lines = source.split(/\r?\n/);
  // the opening delimiter must be a bare "---" line — "---title: x" is body
  if (lines[0]?.trim() !== "---") {
    return { frontmatter: null, body: source.trim() };
  }
  let endIndex = -1;
  for (let index = 1; index < lines.length; index += 1) {
    if (lines[index].trim() === "---") {
      endIndex = index;
      break;
    }
  }
  if (endIndex === -1) {
    return { frontmatter: null, body: source.trim() };
  }
  let frontmatter = null;
  try {
    const parsed = YAML.parse(lines.slice(1, endIndex).join("\n"));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      frontmatter = parsed;
    }
  } catch {
    // malformed YAML — treat as no frontmatter
  }
  return {
    frontmatter,
    body: lines.slice(endIndex + 1).join("\n").trim(),
  };
}
