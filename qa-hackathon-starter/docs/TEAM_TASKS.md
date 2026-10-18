# Three-person implementation plan and handoffs

## Ground rules
Nobody codes dependent features until team agrees on decisions, data model, and API routes. Create GitHub Issues with precise requirement IDs and use PRs to integrate. Each contributor owns their feature files and requests review for shared contracts.

### Member 1 — Team Lead / Core Backend
1. GitHub setup, collaborators, branch protection, issue labels, PR reviews.
2. F1/Q1/Q2: auth, workspace, base roles, permission checks, value field hiding.
3. Database fundamentals, contacts/company/opportunity ownership and workspace scoping needed by others.
4. F3: lead intake API, round-robin assignment, availability/capacity, ack, persisted deadlines, escalations, reassignments, recovery queue, concurrency tests.
5. F4 audit write/read permissions; F5 data endpoints; coordinate real-time events.
6. End-to-end testing, merge and demo orchestration.
**Avoid:** writing integration adapters owned by Member 3 or frontend pages owned by Member 2.

### Member 2 — Frontend / CRM
1. Login, workspace/team, role-aware navigation and visible access errors (using Member 1 APIs).
2. F2 CRM record screens, editable pipeline board, typed field settings, saved lists, contact unified view.
3. F3 assignment UI, acknowledgement countdown, availability switch, recovery queue.
4. F4 audit UI and F5 metrics/dashboard/drill-down/customization.
5. I5 integrations status UI based on Member 3 endpoints; responsive/accessibility Q7/Q8.
**Avoid:** business authorization in client-only code, changing backend APIs without review.

### Member 3 — Integrations / External reliability
1. I1 Twilio inbound/outbound/status, signatures, opt-out, duplicates, failed retries.
2. I2 Stripe test checkout, verified webhook, idempotent payments/refunds/status.
3. I3 Google OAuth, token refresh/revocation, availability/book/reschedule/cancel.
4. I4 selected external notifications, per-user routing, under-one-minute target, bounded retry and error visibility.
5. I5 centralized status/sync logs/workspace secrets/isolated failures.
6. Supply provider test evidence and public HTTPS webhook plan.
**Avoid:** inventing CRM schema; request shared tables via approved model change.

## Parallel execution stages
| Stage | Team Lead | Member 2 | Member 3 | Exit gate |
|---|---|---|---|---|
| 0: Contract | Approve stack, schema & routes | Review payloads/screens | Review webhooks/secrets | Decisions + interfaces agreed |
| 1: Skeleton | Auth/tenant/roles/DB | Layout/forms/mock UI **only for UI testing** | Provider account setup/adapter interfaces | Start scripts and smoke tests |
| 2: Core | Lead lifecycle/audit | CRM/pipelines/lead screens | Twilio/Stripe | Real intake→owned lead demo |
| 3: Complete | Timers/queue/dashboard endpoints | Dashboard/unified view | Calendar/I4/reliability | Every mandatory requirement exercised |
| 4: QA | Security + concurrency + merge | Accessibility + E2E UI | Provider live test evidence | Test plan + demo pass |

## Pull-request review routing
Member 1 reviews all PRs; Member 2 reviews frontend changes; Member 3 reviews provider/security integration changes. Lead changes get peer review. Never direct-push `main`.
