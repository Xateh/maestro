// Pure coverage file parsers. All functions return {pct: number} or null.
// Never throw; parse errors → null.

function safeFloat(v) {
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : null;
}

function parseC8OrJest(content) {
  let parsed;
  try { parsed = JSON.parse(content); } catch { return null; }
  const pct = parsed?.total?.lines?.pct;
  return safeFloat(pct) !== null ? { pct: safeFloat(pct) } : null;
}

function parseLcov(content) {
  let totalLF = 0;
  let totalLH = 0;
  let found = false;
  for (const line of content.split("\n")) {
    const lf = line.match(/^LF:(\d+)/);
    const lh = line.match(/^LH:(\d+)/);
    if (lf) { totalLF += parseInt(lf[1], 10); found = true; }
    if (lh) { totalLH += parseInt(lh[1], 10); }
  }
  if (!found || totalLF === 0) return null;
  return { pct: (totalLH / totalLF) * 100 };
}

function parseXmlAttr(content, attrName) {
  const m = content.match(new RegExp(`\\b${attrName}="([^"]+)"`));
  return m ? safeFloat(m[1]) : null;
}

function parseCobertura(content) {
  const rate = parseXmlAttr(content, "line-rate");
  return rate !== null ? { pct: rate * 100 } : null;
}

function parseClover(content) {
  const covered = parseXmlAttr(content, "coveredelements");
  const total = parseXmlAttr(content, "elements");
  if (covered === null || total === null || total === 0) return null;
  return { pct: (covered / total) * 100 };
}

function parseRegex(content, opts) {
  if (!opts?.pct) return null;
  let re;
  try { re = new RegExp(opts.pct); } catch { return null; }
  const m = re.exec(content);
  if (!m || m[1] === undefined) return null;
  const pct = safeFloat(m[1]);
  return pct !== null ? { pct } : null;
}

/**
 * Parse a coverage file.
 * @param {string} format - one of: c8-json, lcov, jest-json, cobertura, clover, regex
 * @param {string} content - file content as string
 * @param {object} [opts]  - format-specific options (regex: { pct: string })
 * @returns {{ pct: number } | null}
 */
export function parseCoverage(format, content, opts) {
  try {
    switch (format) {
      case "c8-json":   return parseC8OrJest(content);
      case "jest-json": return parseC8OrJest(content);
      case "lcov":      return parseLcov(content);
      case "cobertura": return parseCobertura(content);
      case "clover":    return parseClover(content);
      case "regex":     return parseRegex(content, opts);
      default:          return null;
    }
  } catch {
    return null;
  }
}
