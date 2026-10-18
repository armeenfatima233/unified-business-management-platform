# LeadSafe — Dashboard Outcomes

## Authenticated application shell and navigation

- [ ] Deliver an authenticated-style application shell with workspace/account context and left navigation for Dashboard, Leads, Pipeline, Contacts, Companies, Appointments, Payments, Conversations, Team, Integrations, and Settings.
- [ ] Keep the shell calm, premium, professional, accessible, and responsive at 375px, 768px, and 1440px.

## Operational attention dashboard

- [ ] Deliver a populated operational dashboard that answers what needs attention now, whether response speed is healthy, what is happening in the sales pipeline, what is happening with the team, and what appointments/payments are coming through.
- [ ] Include new leads today, average time to first response, escalations in the last 24 hours, and payments received this month with strong hierarchy rather than a generic card grid.

## Lead Safety Pulse and urgent leads

- [ ] Show the states SAFE, WATCH, CRITICAL, ESCALATED, and RECOVERY using meaningful text/icons and urgency colors only when urgency exists.
- [ ] Surface urgent leads with exactly one accountable owner, source, acknowledgement countdown, escalation status, clear next step, and a prominent accessible Acknowledge action.

## Recovery Queue and sales flow

- [ ] Deliver a Recovery Queue with explicit reasons: “Unacknowledged — deadline exceeded,” “Escalated 2 times,” and “No recorded activity for configured idle period,” plus ownership and resolution-oriented next steps.
- [ ] Deliver a compact open-pipeline visualization showing value by stage.

## Team, schedule, and payments

- [ ] Show employee availability and assignment readiness in the context of lead routing and escalation.
- [ ] Show upcoming appointments and recent payments without implying live production integrations.

## UI states and prototype boundaries

- [ ] Organize reusable UI architecture for populated, loading, empty, error, success, and permission-denied states.
- [ ] Use isolated prototype data only. Keep integration references labeled sandbox/test where shown. Do not invent production APIs or backend functionality.

## CRM shell and navigation refinement

- [ ] Use a clean Attio-inspired CRM visual system with white surfaces, subtle gray borders, one blue accent, rounded-lg cards, Inter typography, and restrained information density.
- [ ] Provide left navigation for Dashboard, Leads, Pipeline, Contacts, Conversations, Recovery Queue, Calendar, Integrations, and Audit Log.
- [ ] Provide a top-bar availability status dropdown with Available, Away, and Do not disturb states.

## Pipeline workspace

- [ ] Provide a responsive Pipeline page with Board and List views.
- [ ] Provide a Pipedrive-style Kanban board with New lead, Qualified, Proposal, and Negotiation stages.
- [ ] Support drag-and-drop movement of opportunities between stages using local prototype data.
- [ ] Provide a keyboard-accessible opportunity search field, Add opportunity action, labeled form inputs, and a local prototype creation modal.

## Complete CRM module coverage

- [ ] Expose Dashboard, Leads, Pipeline, Contacts, Companies, Conversations, Recovery Queue, Appointments, Payments, Team, Integrations, Audit Log, and Settings in the authenticated application navigation.
- [ ] Give each module a deliberate workspace state with a clear purpose, module metrics, representative record table, labeled actions, and explicit prototype/API boundaries.
- [ ] Preserve the Lead Safety Pulse as the product identity across Dashboard, Leads, Pipeline, and Recovery Queue.
