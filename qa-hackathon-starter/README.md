# Unified Business Management Platform | QA Hackathon

> Specification-first starter repository. **Documentation and guardrails only; this is not a functioning application.**

## Source of truth
`docs/SOURCE_REQUIREMENTS.md` maps mandatory requirements to the supplied problem statement. `docs/PRD.md` translates them into outcomes and acceptance criteria. `docs/DECISIONS.md` clearly separates proposed technology/behavior from source mandates. Do not code unresolved decisions as if approved.

## Team
- **Member 1 (team lead):** repository, auth/tenancy/RBAC, lead routing engine, API integration/reviews.
- **Member 2:** frontend, CRM screens, customizable forms/pipelines, dashboard.
- **Member 3:** Twilio, Stripe, Google Calendar, selected notification provider, webhook reliability.

Details and handoffs: `docs/TEAM_TASKS.md`.

## Start here
1. Read `AGENTS.md`, `docs/PRD.md`, `docs/SOURCE_REQUIREMENTS.md`.
2. Settle the open decisions in `docs/DECISIONS.md`, particularly stack, I4 provider, manager escalation, and lead behavior when nobody is eligible.
3. Agree on `docs/DATA_MODEL.md` and `docs/API_CONTRACT.md` and freeze the first version before parallel coding.
4. Create repo in GitHub and invite two collaborators using `docs/GITHUB_SETUP.md`.
5. Make a feature branch, implement only assigned acceptance criteria, run tests and open PR using the included template.

## Demonstration
Follow `docs/DEMO_SCRIPT.md`. Provider accounts and public HTTPS webhook endpoints are needed for real demonstrations.

## Boundaries
No accounting, payroll, ad attribution, BI report builder, training, marketing website, or platform subscription billing. No fabricated external callbacks.
