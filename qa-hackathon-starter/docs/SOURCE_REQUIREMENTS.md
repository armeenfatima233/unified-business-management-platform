# Source requirements and traceability

This file is an index to the user's 12-page **Unified Business Management Platform: Problem Statement**. IDs and requirements below come from that document. It is not a replacement for the original.

## Mandatory features
| ID | Source requirement | Owner |
|---|---|---|
| F1.1–F1.6 | Signup/login/logout/persistent session; Owner/Admin/User; configurable permissions; value masking; server-side RBAC; isolation | 1 (UI 2) |
| F2.1–F2.8 | CRM relations, typed custom fields, different fields by pipeline, required stage fields, editable stages, saved filters, activity, unified contact view | 2 (APIs 1) |
| F3.1–F3.9 | Three lead sources, availability, configurable capacity/round robin, acknowledgement, escalating chain, absence handling, recovery queue, concurrency safety, external alerts | 1 (UI 2, notification 3) |
| F4.1–F4.3 | Append-only audit for significant changes, permissioned visibility and filters | 1 (UI 2) |
| F5.1–F5.5 | Dashboard metrics, consistent definitions, 3 drill-downs, role-aware widgets, persisted hide/show | 2 (APIs 1) |
| I1.1–I1.9 | Real Twilio WhatsApp Sandbox **or SMS**, verified inbound/outbound/status, dedupe, opt-out, failure/retry, ownership | 3 |
| I2.1–I2.8 | Real Stripe test checkout, signature-verified events, dedupe, failed/expired/refunded states, collected revenue, traceability, no card storage | 3 |
| I3.1–I3.7 | Google Calendar OAuth, refresh/revocation, appointment CRUD, busy-time checks, timezone, connection state | 3 |
| I4.1–I4.4 | Choose **one**: Slack, Telegram, or transactional email. Timely contextual per-user alerts, retries/error visibility | 3 |
| I5.1–I5.8 | Central integration statuses, per-workspace config, safe secrets, sync history, resilience, limits, permissions, failure isolation | 3 (UI 2, auth 1) |
| Q1–Q14 | Auth safety, isolation, input safety, integrity, concurrency, persistence, responsiveness, accessibility, performance, errors, live updates, metric consistency, config/secrets, modularity | All |

## Explicitly excluded by source scope
Full accounting, payroll and shift/legal leave rules, advertising attribution, full BI report builder, training/AI roleplay, public marketing website, and platform subscription billing.

## Source ambiguities to resolve (do not silently change)
- Scope says **one customizable pipeline**, while F2.3 tests **two pipelines with different field sets**. Proposal: support multiple pipelines sufficient for the F2.3 test.
- Manager is a **configurable permission role**, not a fourth fixed base level (Owner/Admin/User).
- F3.5 requires next employee → designated backup → manager, but missing fallback when no eligible assignee is available. Define this before implementing.
- F3.6 requires documented behavior for already acknowledged leads upon leave/offline but doesn't dictate that behavior.
- Response-time and recovery-queue definitions must follow Section 7 exactly.
- Business-specific provider configuration and actual provider access depend on credentials not included in the statement.

## Source glossary (must be used consistently)
- **Lead:** intake record with source label.
- **Time to first response:** first assignment → first acknowledgement (which can be a recorded action).
- **Escalation:** automatic reassignment following expired acknowledgement window. Manual reassignment is separate.
- **Recovery queue:** beyond acknowledgement deadline, or escalated at least twice, or idle beyond configured duration.
- **Available employee:** status Available **and** open-lead count below cap.
- **Open pipeline value:** sum for opportunities not won/lost grouped by stage, permission-gated.
- **Collected revenue:** provider-confirmed payments minus confirmed refunds; not projected revenue.
