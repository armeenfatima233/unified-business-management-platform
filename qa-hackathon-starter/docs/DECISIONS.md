# Architecture Decision Log — proposals, NOT source requirements

Until team lead marks a row **Approved**, coding agents may not assume it is binding.

| ID | Proposed decision | Status | Reason / action |
|---|---|---|---|
| D01 | TypeScript monorepo: React + Vite frontend; Node.js + Express backend; PostgreSQL + ORM | PROPOSED | Common hackathon stack; team may prefer another |
| D02 | REST JSON `/api/v1` with OpenAPI contract | PROPOSED | Enables parallel work |
| D03 | Durable background worker that polls persisted escalation due times; DB transactions/locking | PROPOSED | No lost timers or duplicate owners |
| D04 | Use **Telegram Bot** as I4 provider | PROPOSED | Simple demo; account/chat setup still required |
| D05 | Support ≥2 pipelines to satisfy F2.3 despite one-pipeline wording in scope | PROPOSED | Explicit acceptance test needs two |
| D06 | On zero eligible users, retain a single configured accountable fallback/manager and flag queue | NEEDS PRODUCT DECISION | Must not violate capacity/availability or unowned-lead invariant; decide exact rule |
| D07 | For acknowledged lead whose owner goes on leave/offline: retain ownership but mark handover required, OR reassign | NEEDS PRODUCT DECISION | Source explicitly asks for defined visible behavior |
| D08 | Store dates UTC, render user/workspace timezone with explicit offset | PROPOSED | Correct cross-zone bookings |
| D09 | WebSocket or Server-Sent Events for live updates (with safe polling fallback) | PROPOSED | Q11 no-refresh requirement |
| D10 | New workspace seeds a minimal pipeline/stage configuration | PROPOSED | Onboarding convenience; avoid adding new features |
| D11 | Decide email/password invite flow and token/session strategy | NEEDS PRODUCT DECISION | F1 requires invite, signup, logout, persistent sessions |
| D12 | Define who can edit a lead after acknowledgement and order of eligible backups | NEEDS PRODUCT DECISION | Prevents different agent implementations |

## Approval convention
Change status to `APPROVED (YYYY-MM-DD, lead initials)` in a reviewed PR. Decisions altering requirements need explicit rationale and updated tests.
