# QA and Acceptance Test Plan

Track each test as PASS / FAIL / BLOCKED with evidence URL, environment and tester. These scenarios are not all exhaustive: expand to every ID in SOURCE_REQUIREMENTS before declaring completion.

| Test | Requirement | Steps / expected evidence |
|---|---|---|
| T01 | F1.1 | Sign up → Owner + workspace; login, refresh persists, logout invalidates |
| T02 | F1.2–F1.5 | Admin cannot modify Owner; unauthorized API call gets 403; opportunity value absent in list/detail/export |
| T03 | F1.6/Q2 | User from workspace A guesses workspace B record ID → no read/write or cross-workspace leaks |
| T04 | F2.1–F2.5 | Relationships work; type five custom fields; per-pipeline fields; required-stage block; occupied-stage deletion safe |
| T05 | F2.6–F2.8 | 3 filters combined and saved; auto-updates; chronological history and contact 360 view |
| T06 | F3.1–F3.4 | Web form + manual + real Twilio intake; verify source, eligible round-robin, cap, countdown, acknowledgement |
| T07 | F3.5/F3.7 | Configure seconds-long timeout; run next → backup → manager; recovery queue displays reasons |
| T08 | F3.6 | Set owner leave/offline; unacknowledged leads reassign immediately; acknowledged policy matches approved D07 |
| T09 | F3.8/Q5 | Fire two timers / restart worker around due time; one effective reassignment with immutable audit trail |
| T10 | F3.9/I4 | Escalation triggers actual external notification ≤60 seconds, link/details correct |
| T11 | F4 | Filter audit; cannot update/delete history; unauthorized audit request rejected |
| T12 | F5 | All 8 dashboard categories correct; 3 drill-downs; role gating; saved widget visibility |
| T13 | I1 | Real handset → Twilio sandbox → signature-verified webhook → lead; reply arrives; status callback; opt-out; replay idempotent; failed send visible |
| T14 | I2 | Stripe hosted test payment; verified webhook updates record; replay no duplication; refund sync; unpaid != collected |
| T15 | I3 | Consent via Google OAuth; real event created; conflict warning; correct timezone; update/cancel; revoked token surfaced |
| T16 | I5 | Each workspace has separate credentials; integration event history; denied access; provider outage isolated; retries bounded |
| T17 | Q3/Q4 | Malformed payloads rejected; script content rendered safe; remove linked pipeline stage without orphans |
| T18 | Q6–Q14 | Restart persistence, mobile/tablet/laptop, keyboard, pagination, loading errors, live update, metric consistency, fresh checkout setup |

## Evidence rule
For each real integration attach sanitized provider dashboard screenshot or transaction/event ID plus application screen/log. Never put provider secrets or user phone numbers in public commits.
