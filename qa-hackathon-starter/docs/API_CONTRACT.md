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

## Escalation alerts by email (F3.9, I4)
When a lead escalates (or is reassigned because its owner went On leave or was removed), the core writes a pending alert in the same transaction.
A worker sends it through the Resend adapter (`integrations/resend`) within seconds, to the new owner, naming the lead, its source, the reason
and a link `FRONTEND_URL/?lead=<id>` that opens the lead after sign-in. The link must be https (the adapter requires it).
| Path | Who | Notes |
|---|---|---|
| `GET /notifications/alerts?status=pending\|sent\|failed` | `manageIntegrations` | every alert with recipient, status, attempts, plain-language `lastError` and attempt `history` |
| `POST /notifications/alerts/:id/retry` | `manageIntegrations` | only failed alerts; audited |
| `GET/PUT/DELETE /me/notification-destination` `{email}` | any member | where my alerts go; defaults to the sign-in address |
Environment: `RESEND_API_KEY`, `RESEND_FROM_EMAIL` (server only, never sent to the browser). Without them alerts are recorded as failed with an explanation.
`sent` means the provider accepted the email, not that it reached an inbox.

## Integrations (final routes on `integration/combined`)
Route names are frozen as agreed with the integrations owner; this section only adds what is built on top of them.

**Resend (email)**
| Path | Who | Notes |
|---|---|---|
| `POST /webhooks/resend/:webhookKey` | public, Svix-signed | workspace from the key; signature verified with that workspace's signing secret; `200 {kind: processed\|duplicate\|ignored}`, `401 INVALID_SIGNATURE`, `400 INVALID_WEBHOOK`, `500` so Resend retries. Every refusal or failure is recorded in the sync history |
| `GET/PUT/DELETE /integrations/resend` `{webhookSecret, apiKey?, fromEmail?, inboundAddress?}` | `manageIntegrations` | PUT creates the workspace's connection and returns `webhookUrl` to paste into Resend; secrets are encrypted and shown masked; the API key falls back to `RESEND_API_KEY` |

A received email matches or creates the contact by sender address and joins its `email` conversation. **Only a new sender also gets a lead** (`source: message`);
a later email from a known sender does not. Mail addressed to another inbox, or sent from the platform's own address, is recorded and ignored (HTTP 200, so it is not retried).
HTML-only mail is stored as plain text.

**Google Calendar** (prefix `/integrations/google/calendar`)
| Path | Who | Notes |
|---|---|---|
| `GET /oauth/start` `{authorizationUrl}`, `GET /oauth/callback?code&state` | session | session-bound single-use state (the callback redirect to the frontend is handled separately) |
| `GET /status` | session | `{state: connected\|needs_reconnection\|not_connected, lastError, account}`; Admins also get `employees[]` (I3.7) |
| `DELETE /` | session | disconnect my own account: revokes at Google, deletes the stored tokens (204; safe to repeat) |
| `GET /busy?from&to&timeZone&userId?` | `crmView` | busy periods for the booking screen; `409 CALENDAR_NOT_CONNECTED` names the employee |

**Appointments** (`/appointments`)
| Path | Who | Notes |
|---|---|---|
| `GET /appointments?from&to&userId&contactId&status&timezone&page` | `crmView` | `from=now` allowed; each item has UTC `startsAt/endsAt`, the booking `timezone`, and `startsAtLocal/endsAtLocal` in the viewer's `timezone` |
| `POST /appointments` `{contactId, opportunityId?, userId?, title, description?, startsAt, durationMinutes, timezone}` | `crmEdit` | `startsAt` must carry an explicit UTC offset (offset-free times are `400`); creates the event in the employee's Google Calendar; `409 CALENDAR_OVERLAP` on a clash (nothing is saved), `409 CALENDAR_NOT_CONNECTED / CALENDAR_NEEDS_RECONNECTION` for an employee who cannot be booked, `502 PROVIDER_ERROR` on a Google outage |
| `PATCH /appointments/:id` `{startsAt?, durationMinutes?, timezone?}` | `crmEdit` | reschedules in Google and on the record (the clash check ignores the event itself); `409 NOT_SYNCED` if it has no Google event |
| `DELETE /appointments/:id` | `crmEdit` | cancels in Google and marks the appointment `cancelled` (kept on the record); repeating it changes nothing |

Booking counts as a recorded action on the contact's lead; every change is in the contact's activity history and the audit log.

**Status page and history** (`manageIntegrations`): `GET /integrations` lists email, calendar and escalation alerts with `status`, `lastSuccessAt`, `recentErrors`, `details` and `limits`;
`GET /integrations/events?provider&result&page` is the synchronisation history.

## Notes for the frontend
- Alert emails link to `FRONTEND_URL/?lead=<id>`: after sign-in, open that lead (`GET /leads/:id`) and remove the query string. Without this the link only opens the overview.
- The public enquiry form is `FRONTEND_URL/?form=<key>` (key from `GET /settings/public-form`) posting to `POST /public/leads/:key`.
- Invitation links are `FRONTEND_URL/?invite=<token>` and complete with `POST /auth/accept-invitation`.
- Employees set their alert address with `GET/PUT/DELETE /me/notification-destination`; Admins see alert history at `GET /notifications/alerts`.
- Calendar screens: `GET /integrations/google/calendar/status` (+ `/oauth/start` to connect, `DELETE` to disconnect), `GET /appointments`, and the booking form posts to `POST /appointments` with a timezone-aware `startsAt`.

## Not implemented here (Member 3, I1-I5)
Messaging conversations and Twilio webhooks, and Stripe payment requests and webhooks. The core exposes these hooks for them (register routers in `backend/src/integrations/index.ts`; webhooks get the exact bytes as `req.rawBody` plus an `IntegrationContext` with the database, the encrypted-secrets key, the public base URL and an injectable `fetch`): tables
`conversations, messages, payments, appointments, integration_connections, integration_events, processed_events,
notification_destinations, delivery_attempts`; `processOnce()` for webhook de-duplication in
`src/integrations/core.ts`; `createLead()`/`recordLeadAction()`; `findOrCreateContact()`; and pending alert rows in
`delivery_attempts` that the sender must deliver and update.
