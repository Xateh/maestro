# Maestro Target Import Candidates

**Date:** 2026-06-20
**Status:** Internal candidate list
**Purpose:** Seed an import/replication test corpus for checking how well
Maestro can ingest external agent setups and reproduce them as Maestro
workflows.

This is not a roadmap commitment. It is a target list for stress-testing
`maestro setup import`, role normalization, workflow replication, MCP capture,
and portable bundle export/import across coding-agent ecosystems.

## Evaluation Questions

- Can Maestro discover the artifact without custom one-off code?
- Can Maestro preserve enough source metadata to credit and re-import it?
- Can Maestro map it to a workflow role, instruction attachment, MCP config,
  hook, or recorded-only manifest entry?
- Can Maestro replicate the useful behavior in a `.maestro/workflow.json`
  without falsely claiming enforcement it does not have?
- Can export/import round-trip the replicated workflow without leaking local
  secrets or machine-specific paths?

## High-Value Targets

| Target | Kind | Why it matters | Desired Maestro mapping |
|---|---|---|---|
| Skills | Skill/workflow instructions | Reusable agent workflow format; good match for Maestro role instructions and attachments across coding agents. | Record as skill source; attach `SKILL.md` or equivalent docs to roles; optionally convert focused skills into native `.maestro/roles/*.md`. |
| Plugins | Plugin bundle | Bundles skills, MCP config, hooks, assets, and app integrations. Tests whether Maestro can preserve multi-artifact provenance. | Recorded plugin source plus extracted skills/MCP/hooks where supported. |
| Custom agents / subagents | Agent role | Natural role-unit import target for planner, builder, reviewer, and QA agents. | Convert to Maestro roles with provider, permission, model, and instructions preserved. |
| Lifecycle hooks | Lifecycle guardrail | Useful for secret scans, validation gates, graph updates, and stop-time checks. | Record as hooks; optionally suggest equivalent Maestro command/scoring/regression stages, but do not execute external hooks automatically. |
| MCP config | Tool/server config | Captures tool surfaces used by existing workflows. | Record server names, commands, URLs, env key names, and tool policy hints; redact values. |
| Context7 MCP | Developer-docs MCP | Tests live documentation dependency capture for frontend/backend stacks. | MCP config recorded; roles may attach doc-lookup instructions. |
| Figma MCP | Design MCP | Tests design-to-code workflows, asset references, and UI role specialization. | MCP config recorded; frontend/design roles reference it as an advisory tool dependency. |
| Playwright MCP | Browser automation MCP | Tests browser inspection and UI verification workflows. | MCP config recorded; QA roles can reference Playwright as verification tool dependency. |
| Chrome DevTools MCP | Browser/debug MCP | Tests console/network/performance debugging import. | MCP config recorded; QA/perf roles can receive advisory tool policy. |
| GitHub MCP / plugin | Repo + PR integration | Tests issue, PR, CI, and Actions workflow replication. | MCP/plugin source recorded; role instructions can map to triage, CI-fix, PR-review stages. |
| Sentry MCP | Production telemetry MCP | Tests external incident/log context and production-debug workflows. | MCP config recorded; incident/debug roles reference it as read-only context. |
| Canva plugin/skills | Creative production plugin | Tests non-code creative workflow import: presentations, brand kits, resize/translate flows. | Plugin/skill source recorded; creative roles imported as instruction-heavy roles. |
| Notion plugin/skills | Knowledge/task plugin | Tests docs, decision capture, meeting prep, and task handoff workflows. | Plugin/skill source recorded; docs/research roles imported or attached. |
| Sites plugin | Deployable web app workflow | Tests hosted-site lifecycle: build, save version, deploy, env vars, access control. | Recorded plugin dependency; release roles replicate the lifecycle as explicit guarded stages. |
| shadcn/ui project setup | Frontend scaffold convention | Tests whether Maestro can import project-local UI conventions and reproduce component-building workflow. | Instruction docs attached to frontend roles; no provider execution implied. |
| Storybook config | UI state/test harness | Tests design-system and visual regression workflow capture. | Record config/docs; QA role can run command-stage verification if commands are declared. |
| Supabase project config | Backend service stack | Tests backend DB/auth/storage workflow replication without leaking secrets. | Record docs/config and env key names; backend roles attach migration/auth/storage guidance. |
| Convex project config | Reactive backend stack | Tests TypeScript backend workflow capture and live-data app conventions. | Record docs/config and env key names; backend roles attach Convex workflow guidance. |
| Vercel AI SDK app | AI app scaffold | Tests streaming/tool-call/chat app workflows. | Attach app docs to frontend/agent roles; command stages run local tests/builds. |
| Agents SDK workflow | Agent orchestration framework | Tests importing multi-agent handoff designs into Maestro's graph model. | Convert agents to roles where possible; handoffs become explicit transitions. |
| LangGraph workflow | Graph-based agent workflow | Direct comparison target for Maestro's graph orchestration. | Translate graph nodes to roles and edges to transitions when deterministic enough; otherwise record-only plus manual mapping notes. |

## Replication Patterns To Test

### Skill To Role

Input: one `SKILL.md` or equivalent skill document with focused trigger and
instructions.

Expected output:

- Manifest source entry with hash and credit.
- Optional native role file when the skill is agent-role-shaped.
- Role `instruction_paths` attachment when the skill is supporting context.

### Plugin To Workflow Pack

Input: plugin manifest containing skills, MCP config, and hooks.

Expected output:

- One manifest entry for the plugin root.
- Child entries for discovered skills, MCP servers, and hooks.
- No automatic execution of hooks or remote tools.
- Export bundle keeps credits and redacts secret-shaped values.

### MCP To Advisory Tool Policy

Input: MCP server config with tool names and env var names.

Expected output:

- Recorded server metadata.
- Role-level advisory tool dependency when a role references that MCP.
- No claim that Maestro can enforce MCP tool policy unless the provider can.

### Agent Graph To Maestro Workflow

Input: Agents SDK, LangGraph, or another multi-agent workflow.

Expected output:

- Agent nodes become roles.
- Handoffs/edges become explicit `transitions`.
- Human-in-loop, approval, and deploy steps become guarded states.
- Ambiguous dynamic routing remains recorded-only with manual mapping notes.

### App Scaffold To Verification Workflow

Input: frontend/backend scaffold with scripts and docs.

Expected output:

- Design/build/test roles attach project conventions.
- Command stages declare lint, test, build, browser, or coverage checks.
- Secret values stay machine-local; bundles carry env key names only.

## Priority Order

1. Skills, custom agents/subagents, lifecycle hooks, and MCP config.
2. Figma, Context7, Playwright, Chrome DevTools, GitHub, and Sentry MCP.
3. Agents SDK and LangGraph workflows.
4. Sites, Canva, and Notion plugin workflows.
5. App scaffolds: shadcn/ui, Storybook, Supabase, Convex, Vercel AI SDK.

The first group should exercise current importer paths. Later groups are
expected to expose gaps in plugin-bundle parsing, graph translation, external
service provenance, and deploy/release workflow replication.
