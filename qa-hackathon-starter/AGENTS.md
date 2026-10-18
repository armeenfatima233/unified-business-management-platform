# Coding Agent Instructions (mandatory)

## Mission and authority
Implement only the **Unified Business Management Platform** requirements in `docs/PRD.md` and `docs/SOURCE_REQUIREMENTS.md` as supported by the supplied problem statement. The source document wins if a paraphrase conflicts with it. `docs/DECISIONS.md` contains **proposals and unresolved choices**, not additional hackathon mandates.

## Required sequence before code
1. Read `README.md`, this file, `docs/SOURCE_REQUIREMENTS.md`, `docs/PRD.md`, `docs/DECISIONS.md`.
2. Identify the exact requirement IDs for the requested task.
3. Inspect the existing repository and relevant files; do not assume frameworks or paths.
4. Explain intended files, API/schema changes, tests, and potential coordination risks briefly.
5. If implementation requires an unresolved product choice, stop that portion and ask the team lead; implement independent work only.

## Non-negotiable restrictions
- DO NOT add features, pages, services, infrastructure, dependencies or refactors outside the task's stated requirement IDs.
- DO NOT delete, rename, reformat, or rewrite teammates' unrelated files.
- DO NOT silently alter an established API contract, shared schema, role/permission vocabulary or environment variable names. Propose change and wait for approval.
- DO NOT implement mocked provider services as proof of meeting I1–I4; stubs are acceptable only in isolated automated tests and must be labelled.
- DO NOT use an in-memory database for required persistent data or in-process-only timers for dependable escalation.
- DO NOT hardcode secrets, commit `.env`, output access tokens, store credit card data, or expose secrets to the browser.
- DO NOT trust client-supplied workspace IDs or permissions. Obtain tenant/identity context from the authenticated session on the server.
- DO NOT bypass authorization checks on list, detail, export, webhook-management or mutation endpoints.
- DO NOT assume webhook order or uniqueness. Verify signatures, deduplicate by provider event ID, record results, and tolerate retries.
- DO NOT report a passing test that wasn't executed. Never claim an integration works without a real provider test.

## Engineering invariants
- Exactly one accountable lead owner at any given time, including during reassignment; address no-eligible-user case via approved decision.
- Assignment must exclude users who are Busy, On leave, Offline, or at configured open-lead capacity.
- Escalations must be atomic, idempotent and durable across server restart.
- Workspace isolation and field-level opportunity-value protection are enforced server-side and in exports.
- Audit events are append-only through the application, with actor/time/action/target and before/after as appropriate.
- All provider credentials and configuration are workspace-scoped.
- Each external provider's failure must not prevent the rest of the platform from working.
- Date/time stored unambiguously and presented in correct user timezone.

## Module ownership
- `backend/` shared core: Member 1. Integration adapters: Member 3 only in jointly agreed integration module boundaries.
- `frontend/`: Member 2; coordinate API integration with Member 1.
- `docs/API_CONTRACT.md`, `docs/DATA_MODEL.md`: changes require agreement from all affected members.

## Definition of done (every PR)
- Cite requirement IDs addressed; link issue.
- Tests for happy path, rejected permissions, cross-workspace access, duplicates/retries and invalid inputs where relevant.
- Update contract, environment example and docs only when approved changes require it.
- Provide commands run and real outputs, list untested work explicitly.
- No new scope, secrets, unresolved merge conflicts or broken tests.

## Agent final response format
**Requirement IDs:** ...
**Files changed:** ...
**Behavior implemented:** ...
**Tests run/results:** ...
**Remaining gaps/decisions:** ...
