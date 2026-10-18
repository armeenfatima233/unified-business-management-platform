# Data Model — proposed conceptual schema, not final migrations

Every tenant-owned business record has a `workspace_id` used by **all** queries and uniqueness checks; foreign keys prevent cross-tenant links. Exact SQL types/ORM await architecture approval.

## Core entities
- `workspaces(id, name, settings)`
- `users(id, email, password_hash, ...)` and `memberships(workspace_id, user_id, base_level, availability, ...)`
- `roles(id, workspace_id, name)` and `role_permissions` / `member_permissions` (manager is permission-based)
- `companies(id, workspace_id, name)`
- `contacts(id, workspace_id, company_id, name, phone, opt_out, ...)`
- `pipelines(id, workspace_id, name)`, `stages(id, pipeline_id, ordering, type, ...)`
- `custom_field_definitions(id, workspace_id, pipeline_id, entity_type, type, options, required_stage_id?)`
- `opportunities(id, workspace_id, contact_id, pipeline_id, stage_id, owner_id, value, currency, ...)`
- `custom_field_values` (typed/validated, related to definition/record)
- `leads(id, workspace_id, contact_id, source, owner_id, assigned_at, deadline_at, acknowledged_at, escalation_count, ...)`
- `lead_assignment_history`, `lead_routing_rules`, `lead_routing_cursor` (durable fairness and escalation config)
- `activities`, `audit_events` (append-only application API), `saved_filters`, `dashboard_preferences`
- `conversations`, `messages` (provider message ID unique per connection)
- `payments`, `payment_events` (provider event ID unique per connection)
- `appointments` (Google event reference, timezone, contact/opportunity)
- `integration_connections` (workspace-scoped encrypted secrets), `integration_events`, `notification_destinations`, `delivery_attempts`

## Critical constraints
1. Lead has one owner in committed state. Zero-eligible-owner policy unresolved: see D06.
2. Atomic lead-owner update guarded by transaction/lock/version and escalation attempt idempotency.
3. Unique provider-event identifiers scoped by integration connection; duplicate deliveries must not duplicate business effects.
4. Related foreign keys must belong to same workspace; don't accept mismatched `contact_id` or `opportunity_id`.
5. Store UTC timestamps and external provider references; ensure appropriate indexes for due deadlines, workspace + stages, and filtered lists.
6. Contact phone normalized sufficiently to match Twilio sender; document country format rules.
7. Protect secrets at rest; never store payment card numbers.
8. Audit rows cannot be updated/deleted through product endpoints.

## Migration protocol
Any proposed entity/field change must list source requirement, migration impact, API effect, data backfill, and approval from affected owners. No editing another contributor's migration without coordinating.
