# API contract v1 (core backend) — implemented

This describes what `backend/` serves today. The integration endpoints (messaging, payments, calendar,
notifications, integrations page) belong to Member 3 and are listed at the end as **not implemented**.
Behaviour is covered by the automated tests in `backend/tests/` (run `npm test`).

## Conventions
- Base `/api/v1`, JSON in and out, camelCase. Times are UTC ISO-8601; the client formats them in the user's time zone.
- Auth is an httpOnly session cookie (`ubmp_session`). Send `credentials: "include"`. The workspace comes from the
  session only; **never send a workspace id**. A record of another workspace answers `404`, not `403`.
- Errors always look like `{ "error": { "code": "STRING", "message": "plain explanation", "details"?: {} } }`.
  Codes used: `VALIDATION_ERROR` 400, `UNAUTHENTICATED` 401, `FORBIDDEN` 403, `CSRF_BLOCKED` 403, `NOT_FOUND` 404,
  `VERSION_CONFLICT` 409, `HAS_RELATED_RECORDS` 409, `STAGE_NOT_EMPTY` 409, `REQUIRED_FIELDS_MISSING` 422,
  `PAYLOAD_TOO_LARGE` 413, `TOO_MANY_ATTEMPTS` 429, `RATE_LIMITED` 429 and others named below.
- Lists take `page` (from 1) and `pageSize` (default 25, max 100) and return `{ items, page, pageSize, total }`.
- Editable records carry a `version`. `PATCH` must send the version it read; a stale one returns `409 VERSION_CONFLICT`.
- Permissions (capabilities, not role names): `crmView`, `crmCreate`, `crmEdit`, `crmDelete`, `crmExport`,
  `manageAssignmentRules`, `manageIntegrations`, `viewAuditLog`, `viewOpportunityValue`. Owner has all and cannot be
  reduced; Admin has all by default; User has `crmView`, `crmCreate`, `crmEdit`. "Manager" is just a permission set.
- Opportunity `value` is `null` (with `valueHidden: true`) for anyone without `viewOpportunityValue`, in lists, detail,
  the customer view, dashboard, exports and audit snapshots.
- State-changing browser requests with a foreign `Origin` get `403 CSRF_BLOCKED`. CORS allows only `CORS_ORIGINS`.

## Auth and members (F1)
| Method and path | Who | Notes |
|---|---|---|
| `POST /auth/signup` `{email,password(≥10),name,workspaceName}` | public | creates workspace + Owner, seeds a "Sales" pipeline; `409 EMAIL_TAKEN` |
| `POST /auth/login` `{email,password}` | public | `401 INVALID_CREDENTIALS`, `429 TOO_MANY_ATTEMPTS` |
| `POST /auth/logout` | session | revokes the session server-side |
| `GET /auth/me` | session | `{user, workspace, baseLevel, availability, permissions[]}` (same shape as login/signup) |
| `POST /auth/accept-invitation` `{token,name,password}` | public | single-use token, 7 days; logs the new member in |
| `GET /members` | session | team list; `permissions` only shown to Owner/Admin |
| `POST /members/invitations` `{email,baseLevel: admin\|user}` | Owner/Admin | Admin may invite Users only; returns `token` once |
| `PATCH /members/:id/role` `{baseLevel}` | Owner | resets that member's permission overrides |
| `PUT /members/:id/permissions` `{permissions[]}` | Owner; Admin for Users | full desired set |
| `DELETE /members/:id` | Owner; Admin for Users | open leads move to others, sessions end, history kept |
| `PATCH /members/me/availability`, `PATCH /members/:id/availability` `{availability}` | self / Owner,Admin | `available\|busy\|on_leave\|offline`; On leave/Offline reassigns unacknowledged leads at once |

## CRM (F2)
| Path | Permission | Notes |
|---|---|---|
| `GET/POST /contacts`, `GET/PATCH/DELETE /contacts/:id` | view / create / view / edit / delete | filters: `search`, `tag`, `ownerId`, `companyId`, `stageId`, `pipelineId`, `createdFrom`, `createdTo`, repeated `cf=<fieldId>:<value>`; delete is `409` while linked records exist |
| `GET /contacts/:id` | view | **customer view**: contact, custom fields, opportunities, conversations, payments, appointments, activities (newest first), leads |
| `POST /contacts/:id/notes` `{text}` | edit | counts as a recorded action (acknowledges the owner's lead) |
| `GET /contacts/export.csv`, `GET /opportunities/export.csv` | export | formula-safe CSV; values masked without permission |
| `GET/POST /companies`, `GET/PATCH/DELETE /companies/:id` | view / create / edit / delete | |
| `GET/POST /opportunities`, `GET/PATCH/DELETE /opportunities/:id` | | create needs `contactId`, `pipelineId`; setting `value` needs `viewOpportunityValue` |
| `POST /opportunities/:id/move` `{stageId,version?,customFields?}` | edit | `422 REQUIRED_FIELDS_MISSING` with the field names until the stage's required fields are filled |
| `GET /pipelines` | view | each pipeline with stages, opportunity counts and `requiredFieldIds` |
| `POST /pipelines`, `PATCH/DELETE /pipelines/:id`, `POST /pipelines/:id/stages`, `PUT /pipelines/:id/stages/order` | Owner/Admin | delete refused while it holds opportunities |
| `PATCH /stages/:id`, `DELETE /stages/:id?moveTo=<stageId>`, `PUT /stages/:id/required-fields {fieldIds}` | Owner/Admin | deleting an occupied stage needs `moveTo`; moves are logged per opportunity |
| `GET /custom-fields?entity=&pipelineId=` | view | `POST/PATCH/DELETE /custom-fields` for Owner/Admin; types `text number date dropdown checkbox`; `pipelineId` scopes an opportunity field to one pipeline |
| `GET/POST /saved-filters`, `GET /saved-filters/:id/results`, `DELETE /saved-filters/:id` | view | criteria re-run on every read, so the list updates itself |

## Leads (F3)
Status vocabulary: `needs_acknowledgement`, `escalated`, `acknowledged`, `closed`.
A lead object: `id, contactId, contact, company, source (web_form|message|manual), message, ownerId, owner, assignedAt,
firstAssignedAt, deadlineAt, secondsRemaining, acknowledgedAt, firstResponseAt, closedAt, escalationCount, level, status,
handoverRequired, attentionReason, recoveryReasons[], lastActionAt, version, createdAt`.

| Path | Notes |
|---|---|
| `POST /public/leads/:publicKey` `{name, phone?\|email?, message?}` | no session; source is always `web_form`; rate limited; key from `GET /settings/public-form` |
| `POST /leads` `{contactId}` or `{contact:{name,phone?,email?}}`, `message?` | manual entry, needs `crmCreate` |
| `GET /leads?scope=mine\|all\|recovery&search&createdFrom&escalatedSince&includeClosed` | `all` and `recovery` show everything only with `manageAssignmentRules`; others see their own |
| `GET /leads/recovery` | unacknowledged beyond window, escalated twice or more, idle too long, or no eligible owner; each with `recoveryReasons` |
| `GET /leads/:id` | adds `history[]` (every assignment with reason) |
| `POST /leads/:id/acknowledge` | owner or manager; repeating it changes nothing |
| `POST /leads/:id/reassign {assigneeId}` | `manageAssignmentRules`; target must be Available and under the limit (`409 ASSIGNEE_UNAVAILABLE`) |
| `POST /leads/:id/close` | owner or manager; closed leads stop counting toward capacity |
| `GET/PUT /settings/lead-routing` | `manageAssignmentRules`: `ackWindowSeconds, maxOpenLeads, escalationLevels (1-3), idleSeconds, levelWindowSeconds[], backupUserId, managerUserId` |
| `GET /settings/public-form` | `{publicKey, submitPath}` |

Decisions in force (see `docs/DECISIONS.md`): no eligible employee → the manager fallback owns the lead and it is flagged;
an acknowledged lead whose owner goes On leave/Offline keeps its owner and shows `handoverRequired`.

## Audit (F4), dashboard (F5), live events (Q11)
- `GET /audit-events?eventType=&actorId=&from=&to=` needs `viewAuditLog`. `eventType` matches an exact action or a prefix
  (`lead` matches `lead.escalated`). There is no write or delete endpoint, and the database rejects UPDATE/DELETE.
- `GET /dashboard/summary?tz=<IANA zone>`: `scope` is `company` for Owner/Admin/managers and `personal` for Users. Returns
  `metrics` (`newLeads, openPipeline, responseTime, recovery, escalations, availability, appointments, payments`),
  `definitions`, `hidden` and a `drilldown` path for the figures that have one.
- `GET/PUT /dashboard/preferences` `{hidden: widgetId[]}` remembers show/hide per user.
- `GET /events` is Server-Sent Events: `data: {"type": "newLead|escalation|incomingMessage|leadUpdated|paymentUpdated", "title", "detail", "tone", "leadId"}`.

## Not implemented here (Member 3, I1-I5)
Messaging conversations and Twilio webhooks, Stripe payment requests and webhooks, Google Calendar OAuth and appointments,
the escalation alert sender (I4), and the integrations status page. The core exposes these hooks for them (register routers in `backend/src/integrations/index.ts`; webhooks get the exact bytes as `req.rawBody` plus an `IntegrationContext` with the database, the encrypted-secrets key, the public base URL and an injectable `fetch`): tables
`conversations, messages, payments, appointments, integration_connections, integration_events, processed_events,
notification_destinations, delivery_attempts`; `processOnce()` for webhook de-duplication in
`src/integrations/core.ts`; `createLead()`/`recordLeadAction()`; `findOrCreateContact()`; and pending alert rows in
`delivery_attempts` that the sender must deliver and update.
