# Product Requirements Document (PRD)

**Product:** Unified Business Management Platform  
**Status:** Requirements baseline for QA Hackathon  
**Source:** Team-provided 12-page problem statement  
**Important:** Technology choices and missing edge-case policies live in `DECISIONS.md`, not here.

## 1. Problem
Small service businesses (5–30 employees) lose leads because requests are missed, ownership is unclear, employee absence is ignored, and customer events live in disconnected tools. The product is a multi-workspace platform that routes leads to an accountable person, automatically escalates missed responses, and unifies CRM, messages, payments and appointments with traceability.

## 2. Users and access
- Owner: creates workspace at signup, controls members, settings and permissions.
- Admin: delegated configuration without authority to modify Owner.
- User: sales/support employee, accesses only permitted resources.
- Manager: custom permission-based role, **not** a fourth hardcoded base level.
- Customer: external sender/payer/appointment attendee, not necessarily an authenticated platform user.

## 3. Required capabilities
### 3.1 Account and tenant security (F1)
Signup creates a workspace and Owner. Sessions survive refresh; logout revokes access. Permission granularity includes CRM view/create/edit/delete/export, assignment rules, integrations and audit. Opportunity value is masked from unauthorized users in API, screens and exports. Every request enforces workspace isolation and permission checks.

### 3.2 CRM customization (F2)
Contacts are related to companies and opportunities. Admins create typed fields (text, number, date, dropdown, checkbox) through UI. Different pipelines can display different custom fields. Stage-required fields block invalid moves with explanation. Stages can be added/renamed/reordered; occupied-stage deletion must be safe. Board/list stage moves, saved filters with ≥3 criteria, chronological activity and full contact view are required.

### 3.3 Lead safety (F3) – most important workflow
Web form, incoming Twilio message and manual entry create leads with source labels. Employee availability: Available/Busy/On leave/Offline. Configurable round-robin, open-lead capacity and acknowledgement time. Eligible users get assignment plus countdown. On expiry route to next eligible employee, designated backup and permission-defined manager, using configurable levels/times. Absence triggers immediate reassignment for unacknowledged leads. Recovery queue shows reasons. Concurrent timers must never double-escalate. Escalations trigger the I4 real external alert.

### 3.4 Audit (F4)
Assignment, acknowledgement, escalation, reassignment, permissions, configuration changes, integrations and deletions have immutable application-level history, actor/system, timestamp, target, before/after when relevant. Only audit-permitted users can query/filter history.

### 3.5 Dashboard (F5)
Show new leads today, open pipeline value by stage, average response time, recovery queue count, escalations in 24h, employee availability, upcoming appointments and collected payments this month. Three metrics drill down to filtered authorized records. Users see own metrics; Owner/Admin see workspace metrics. Widget visibility preference persists.

### 3.6 Real third-party integrations (I1–I5)
- **I1:** Twilio WhatsApp Sandbox (or accepted Twilio SMS alternative). Genuine phone→verified webhook→contact match/new lead→conversation; reply→phone; status callbacks; failed/ retry; opt-out; duplicate protection.
- **I2:** Stripe test mode hosted checkout/payment link, verified webhook-driven status, dedupe, refund/failure/expiry visibility, provider reference, confirmed collected totals; no card storage.
- **I3:** Google Calendar OAuth 2.0 per employee; server-only token handling/refresh; availability checks; create/reschedule/cancel real events; timezone safety; connect/disconnect/errors.
- **I4:** One of Slack/Telegram/transactional email for escalation; user-specific routing, within-minute delivery, contextual link, retry/error history.
- **Shared:** central integrations page, per-workspace connections, secured credentials, sync history, retry with delay, clear limitations, provider isolation and audit.

## 4. Nonfunctional acceptance (Q1–Q14)
- Password hashing, expiration/revocation, login throttling.
- Server-side RBAC and tenant isolation, safe validation/CSRF/XSS/injection prevention.
- Referential consistency, concurrent update safety; durable timers and duplicate webhooks.
- Real persistent database, per-workspace settings, responsive accessible UI.
- Paginated large lists, asynchronous feedback, live leads/escalations/messages without refresh.
- Shared metric definitions and maintainable layered code with secrets outside source.

## 5. Explicit exclusions
No accounting ledgers, payroll, ad campaign attribution, full BI designer, training/AI coaching, marketing website or billing subscriptions for this software.

## 6. Acceptance evidence
Each source requirement ID needs one test case in `docs/TEST_PLAN.md`, with screenshot/log/provider proof for a full end-to-end demo. A green unit test alone cannot prove an external integration is real.

## 7. Risks and dependencies
- Missing provider credentials / public HTTPS callback endpoints can block verified end-to-end integrations.
- Three parallel developers can introduce schema/API incompatibility unless first agreed.
- Durable escalation requires a persisted schedule or database job mechanism, not a browser countdown.
- No available assignee and acknowledged-lead absence policy must be approved (`DECISIONS.md`).
