# Judge Demo Script (with live providers)

## Prerequisites
Two independent workspaces, Owner/Admin/User accounts, two available employees plus designated backup/manager, a real Twilio sandbox joined phone, Stripe test account, Google OAuth test user/calendar, selected I4 destination, HTTPS public callback endpoints. Preconfigure short demo deadlines.

1. **Tenant boundaries:** log into Company A and Company B. Try direct cross-workspace URL/API access; rejected.
2. **Customization:** Admin adds a number/dropdown field, sets stage-required field, shows rejected move, creates distinct pipeline with different fields.
3. **Missed lead recovery:** submit public form. Eligible worker receives one lead and timer. Wait for configured expiry. Show atomic reassign, alert via I4, audit entries and recovery reason. Set another worker On leave, show immediate reassignment.
4. **Twilio reality:** send actual SMS/WhatsApp sandbox message from joined phone; view matched contact or new lead, reply from app, receive on phone, show provider delivery state.
5. **Stripe reality:** create test checkout from opportunity and pay through Stripe hosted page; demonstrate provider webhook updates contact/payment view and collected revenue.
6. **Google reality:** connect employee calendar with consent, book event, verify on Google Calendar; show busy conflict or cancellation.
7. **Manager control:** review dashboard metrics, 3 drill-downs, contact 360 timeline, audit and integration sync errors.
8. **Reliability proof:** replay a webhook / concurrent timer test and show no duplicated effect; make one provider unavailable and show core CRM continues.

## Honest fallback when external credentials unavailable
Show relevant automated tests and mark the actual live-provider acceptance **BLOCKED**, not PASS. Source explicitly requires real integrations.
