// SP12b ephemeral safety policy — pure validators. No run core: SP12e calls
// these at submit time and enforces the sandbox at run time.

function issue(code, message) {
  return { code, message };
}

const norm = (s) => String(s ?? "").trim().replace(/\s+/g, " ");

export function matchCommand(candidate, allowlist = []) {
  const c = norm(candidate);
  return allowlist.some((entry) => {
    const e = String(entry ?? "");
    if (e.startsWith("re:")) {
      let re;
      try {
        re = new RegExp(e.slice(3));
      } catch {
        return false; // invalid pattern never matches; lint catches it at load
      }
      return re.test(c);
    }
    if (e.endsWith(" *")) {
      return c.startsWith(norm(e.slice(0, -2)) + " ") || c === norm(e.slice(0, -2));
    }
    return c === norm(e);
  });
}
