# GitHub Setup for Team Lead

## Repository creation
1. Sign in at https://github.com and select **New repository**.
2. Suggested name: `qa-hackathon-unified-business-platform` (rename freely).
3. Choose **Private** if hackathon rules permit, add description, create repository. Upload this starter package or initialize git locally with the commands below.
4. Go to **Settings → Collaborators and teams** (UI labels may vary) → **Add people**; invite both teammates by their exact GitHub usernames or email. They must accept invitations.
5. Go to **Settings → Branches / Rules / Rulesets**. Where available, protect `main`: require pull request, at least one reviewer, passing CI; prevent force pushes. Some settings depend on repository/plan/org rules.
6. Create Issues from `TEAM_TASKS.md`, assign owners and labels `backend`, `frontend`, `integrations`, `qa`, `blocked`.
7. Set secrets only in local environment and GitHub Actions secrets when actually needed. Never share secrets through commits.

## Local commands (after copying project files)
```bash
git init
git add .
git commit -m "docs: initialize hackathon requirements and agent guardrails"
git branch -M main
git remote add origin https://github.com/YOUR_USERNAME/qa-hackathon-unified-business-platform.git
git push -u origin main
```
> If you initialized GitHub with a README, clone the remote first and copy files in to avoid divergent histories.

## Standard branch and PR workflow
```bash
git checkout main
git pull origin main
git checkout -b feat/auth-tenancy
# make only scoped changes
git add .
git commit -m "feat(auth): implement F1 tenant-aware login"
git push -u origin feat/auth-tenancy
```
Open PR on GitHub, link requirement IDs and issue, await review/checks, then merge. Never share one working branch across all three members.

## Suggested branches
- Team Lead: `feat/auth-tenancy`, `feat/lead-engine` (separate PRs)
- Member 2: `feat/crm-ui`, `feat/dashboard-ui`
- Member 3: `feat/twilio`, `feat/stripe`, `feat/google-calendar`, `feat/notifications`

## Collaborator access policy
Give write access only where needed; keep repository ownership/admin with team lead. Rotate any accidentally published credential immediately.
