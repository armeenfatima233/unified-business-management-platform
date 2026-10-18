# Architecture Decision Log — proposals, NOT source requirements

Until team lead marks a row **Approved**, coding agents may not assume it is binding.

| ID | Proposed decision | Status | Reason / action |
|---|---|---|---|
| D01 | TypeScript monorepo: React + Vite frontend; Node.js + Express backend; PostgreSQL + ORM | APPROVED (2026-10-18, backend lead) | Express + SQLite (see D01a) on the backend; React + Vite frontend. PostgreSQL/Supabase migration is deferred and isolated in `backend/src/db.ts`. |
| D01a | Backend starts on SQLite (`node:sqlite`, persistent file) instead of PostgreSQL, because of limited hackathon time and no local Postgres; data access is isolated in `backend/src/db.ts` | APPROVED (2026-10-18, backend lead) | Revisit before F3 escalation work: row locking and concurrent workers are stronger on PostgreSQL |
| D02 | REST JSON `/api/v1` with OpenAPI contract | APPROVED (2026-10-18, backend lead) | REST JSON under `/api/v1`; machine-readable contract is `docs/API_CONTRACT.md`. |
| D03 | Durable background worker that polls persisted escalation due times; DB transactions/locking | APPROVED (2026-10-18, backend lead) | `backend/src/leads/worker.ts` polls persisted `deadline_at`; each escalation is a guarded transaction, so restarts and duplicate ticks are safe. |
| D04 | Use **Telegram Bot** as I4 provider | APPROVED (2026-10-18, backend lead) | Telegram bot is the I4 provider (per-user chat id, bounded retries). |
| D05 | Support ≥2 pipelines to satisfy F2.3 despite one-pipeline wording in scope | APPROVED (2026-10-18, backend lead) | Multiple pipelines per workspace; custom fields can be scoped to a pipeline. |
| D06 | On zero eligible users, retain a single configured accountable fallback/manager and flag queue | APPROVED (2026-10-18, backend lead) | No eligible employee: the lead goes to the workspace manager fallback (configured user, else the Owner), regardless of capacity, so there is always exactly one owner. It is flagged in the recovery queue with reason "No eligible employee". |
| D07 | For acknowledged lead whose owner goes on leave/offline: retain ownership but mark handover required, OR reassign | APPROVED (2026-10-18, backend lead) | Acknowledged lead whose owner goes On leave/Offline keeps its owner but is flagged `handoverRequired` (visible in lead lists and detail). A manager reassigns manually; unacknowledged leads are reassigned immediately. |
| D08 | Store dates UTC, render user/workspace timezone with explicit offset | APPROVED (2026-10-18, backend lead) | Correct cross-zone bookings |
| D09 | WebSocket or Server-Sent Events for live updates (with safe polling fallback) | APPROVED (2026-10-18, backend lead) | Server-Sent Events at `GET /api/v1/events`; the frontend may also poll. |
| D10 | New workspace seeds a minimal pipeline/stage configuration | APPROVED (2026-10-18, backend lead) | New workspace seeds one pipeline ("Sales") with stages New, Qualified, Proposal, Won, Lost. |
| D11 | Decide email/password invite flow and token/session strategy | APPROVED (2026-10-18, backend lead) | Owner/Admin creates an invitation (single-use token, 7-day expiry, only its hash stored); the invitee sets name and password. The link is returned to the inviter until an email provider is added. |
| D12 | Define who can edit a lead after acknowledgement and order of eligible backups | APPROVED (2026-10-18, backend lead) | After acknowledgement only the lead owner or a member with `manageAssignmentRules` (Owner/Admin/manager) may act on the lead; reassignment requires `manageAssignmentRules`. Backup order: configured next eligible employee, then backup user, then manager. |

## Approval convention
Change status to `APPROVED (YYYY-MM-DD, lead initials)` in a reviewed PR. Decisions altering requirements need explicit rationale and updated tests.
