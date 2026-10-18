# Draft API Contract — interface proposal, not an implemented API

**Freeze only after lead/team approval.** All authenticated endpoints infer workspace from session, **never** from client-controlled workspace selection. All IDs are opaque examples; final types depend on approved schema.

## Conventions (proposed)
- Base: `/api/v1`; JSON requests/responses; auth via approved session mechanism.
- Standard error: `{ "error": { "code": "FORBIDDEN", "message": "..." } }`.
- Lists: pagination, filters, server-side permissions and value redaction.
- Mutations needing safe retry accept `Idempotency-Key` where applicable.
- Role permissions are capability-based, not only named roles.

## Routes to agree before implementation
| Operation | Proposed endpoint | Source IDs | Owner |
|---|---|---|---|
| Signup/login/logout/me | `POST /auth/signup`, `POST /auth/login`, `POST /auth/logout`, `GET /auth/me` | F1.1 | 1 |
| Invite and roles | `POST /members/invitations`, `PATCH /members/:id/role`, `GET /permissions` | F1.2–1.5 | 1 |
| CRM CRUD | `/contacts`, `/companies`, `/opportunities` | F2.1, F2.7–2.8 | 1+2 |
| Custom fields | `/settings/custom-fields` | F2.2–2.4 | 1+2 |
| Pipelines/stages | `/pipelines`, `/pipelines/:id/stages`, `PATCH /opportunities/:id/stage` | F2.3–2.5 | 1+2 |
| Saved filtered lists | `/saved-filters`, `/opportunities?filters=...` | F2.6 | 1+2 |
| Manual lead intake | `POST /leads` | F3.1 | 1 |
| Public lead form | `POST /public/leads` | F3.1 | 1 |
| Availability | `PATCH /me/availability` | F3.2/F3.6 | 1 |
| Routing settings | `/settings/lead-routing` | F3.3–3.5 | 1 |
| Acknowledge | `POST /leads/:id/acknowledge` | F3.4 | 1 |
| Recovery queue | `GET /leads/recovery` | F3.7 | 1 |
| Audit | `GET /audit-events` | F4 | 1 |
| Dashboard | `GET /dashboard/summary`, `/dashboard/preferences` | F5 | 1+2 |
| Conversation and send | `/conversations`, `POST /conversations/:id/messages` | I1 | 3 |
| Twilio webhooks | `POST /webhooks/twilio/inbound`, `/webhooks/twilio/status` | I1 | 3 |
| Stripe payment | `POST /opportunities/:id/payment-requests`, `POST /webhooks/stripe` | I2 | 3 |
| Calendar | `/integrations/google/connect`, `/integrations/google/callback`, `/appointments` | I3 | 3 |
| Integration overview | `GET /integrations`, `GET /integrations/events` | I5 | 3 |
| Notification destination | `/me/notification-destination` | I4 | 3 |

## Critical payload expectations (proposal)
`POST /public/leads`: `{ "name": "Example", "contact": "...", "message": "..." }`, source is assigned **on server**, never trusted from client.

`GET /leads/:id`: `id`, `ownerId` (**single**), `source`, `assignedAt`, `acknowledgedAt`, `deadlineAt`, `escalationCount`, `status`. Clarify allowable `status` vocabulary before code.

`POST /leads/:id/acknowledge`: requires owner or explicit permission, is safe against duplicate calls, updates first response only once; writes audit event.

`GET /dashboard/summary`: must follow glossary for all calculations and suppress unauthorized amounts, even when API is called directly.

## Contracts still required before backend/frontend parallel code
Create machine-readable `openapi.yaml` and validate it in CI **after** endpoint names, identities, fields, error codes and pagination semantics are approved. Do not let agents invent them independently.
