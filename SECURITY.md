# Security Policy

## Supported Versions

| Version | Supported |
|---------|-----------|
| 0.1.x   | ✅        |

## Reporting a Vulnerability

This is a private repository. Report vulnerabilities by opening an issue with
the `security` label, or contact the repository owner directly. Please include
reproduction steps and affected versions. You'll get an acknowledgement within
a few days.

## Security Model

Maestro executes CLI coding agents on your machine. The guardrails it ships
with:

- **Host command gating** — agent-requested host commands are denied unless the
  binary's basename is in `host_command_allow`; network binaries (curl, wget,
  ssh, …) are hard-denied regardless.
- **Env stripping** — `LD_PRELOAD`, `PATH`, `GIT_SSH_COMMAND`, and key-like
  variables are removed from agent-requested command environments.
- **Path traversal guards** — task/run file reads are confined to the
  `.maestro/` state directory.
- **Config redaction** — `*_key`, `*_token`, `*_secret`, `password`, and
  similar fields are stripped before config is exposed over MCP or HTTP.

Agents themselves run with your user's privileges — review what you approve.
