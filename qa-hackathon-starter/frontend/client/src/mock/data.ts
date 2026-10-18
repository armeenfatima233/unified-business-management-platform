export const demoUser = {
  name: "Alex Morgan",
  email: "alex@northstar.example",
  role: "Owner" as const,
  workspace: "Northstar Services",
};

export const dashboardMetrics = {
  newLeads: 24,
  firstResponse: "8m 42s",
  escalations24h: 4,
  recoveryQueue: 4,
  collectedRevenue: "$28.4k",
  openPipeline: "$361.0k",
};

export const pulseSummary = {
  score: 86,
  state: "SAFE" as const,
  unacknowledged: 2,
  averageResponse: "8m 42s",
  escalations: 4,
};

export const navCounts = { leads: 12, conversations: 3, recovery: 4 };

export const integrationStatus = [
  { name: "Twilio WhatsApp", label: "Sandbox", status: "Connected" },
  { name: "Stripe", label: "Test mode", status: "Connected" },
  { name: "Google Calendar", label: "OAuth 2.0", status: "Connected" },
  { name: "Telegram", label: "Escalation alerts", status: "Not connected" },
];
