export type LeadState = "SAFE" | "WATCH" | "CRITICAL" | "ESCALATED" | "RECOVERY";
export type Availability = "Available" | "Busy" | "On leave" | "Offline";

export const leads = [
  { id: "lead-1", name: "Maya Chen", company: "Northstar Studio", source: "Web form", owner: "Ava Patel", state: "CRITICAL" as LeadState, secondsRemaining: 272, escalation: "L1", acknowledged: false },
  { id: "lead-2", name: "Jon Bell", company: "Ridgeway Homes", source: "WhatsApp", owner: "Noah Williams", state: "WATCH" as LeadState, secondsRemaining: 668, escalation: "L1", acknowledged: false },
  { id: "lead-3", name: "Sofia Ramirez", company: "Lumen Dental", source: "Manual", owner: "Ethan Kim", state: "ESCALATED" as LeadState, secondsRemaining: 0, escalation: "Backup", acknowledged: true },
  { id: "lead-4", name: "Jordan Lee", company: "Brightwell Labs", source: "Web form", owner: "Ava Patel", state: "SAFE" as LeadState, secondsRemaining: 900, escalation: "L1", acknowledged: true },
];

export const opportunities = [
  { id: "opp-1", name: "Maya Chen", company: "Northstar Studio", value: 18500, stage: "New lead", owner: "Ava Patel", priority: "Hot" },
  { id: "opp-2", name: "Jordan Lee", company: "Brightwell Labs", value: 12200, stage: "New lead", owner: "Noah Williams", priority: "Normal" },
  { id: "opp-3", name: "Priya Shah", company: "Goodfolk Market", value: 8400, stage: "New lead", owner: "Ethan Kim", priority: "Normal" },
  { id: "opp-4", name: "Jon Bell", company: "Ridgeway Homes", value: 24000, stage: "Qualified", owner: "Noah Williams", priority: "Warm" },
  { id: "opp-5", name: "Alicia Gomez", company: "Morrow & Co.", value: 16800, stage: "Qualified", owner: "Ava Patel", priority: "Normal" },
  { id: "opp-6", name: "Sofia Ramirez", company: "Lumen Dental", value: 31500, stage: "Proposal", owner: "Ethan Kim", priority: "Hot" },
  { id: "opp-7", name: "Marcus Young", company: "Peak Fitness", value: 9750, stage: "Proposal", owner: "Ava Patel", priority: "Normal" },
  { id: "opp-8", name: "Nadia Wilson", company: "Atlas Works", value: 42000, stage: "Negotiation", owner: "Noah Williams", priority: "Hot" },
];

export const payments = [
  { id: "pay-1", customer: "Northstar Studio", amount: 8400, status: "Paid" },
  { id: "pay-2", customer: "Ridgeway Homes", amount: 4200, status: "Pending" },
  { id: "pay-3", customer: "Lumen Dental", amount: 3600, status: "Paid" },
  { id: "pay-4", customer: "Peak Fitness", amount: 2200, status: "Refunded" },
];

export const team = [
  { id: "user-1", name: "Ava Patel", role: "Sales lead", status: "Available" as Availability, openLeads: 2, limit: 8 },
  { id: "user-2", name: "Noah Williams", role: "Account executive", status: "Busy" as Availability, openLeads: 4, limit: 6 },
  { id: "user-3", name: "Ethan Kim", role: "Account executive", status: "Available" as Availability, openLeads: 1, limit: 8 },
];

export const getRecoveryLeads = () => leads.filter(lead => lead.state === "RECOVERY" || lead.state === "CRITICAL" || lead.state === "ESCALATED");
export const getOpenPipeline = () => opportunities.filter(opportunity => !["Won", "Lost"].includes(opportunity.stage));
export const getCollectedRevenue = () => payments.filter(payment => payment.status === "Paid").reduce((total, payment) => total + payment.amount, 0);
export const getDashboardCounts = () => ({ leads: leads.length, recovery: getRecoveryLeads().length, conversations: 3, opportunities: getOpenPipeline().length, pipelineValue: getOpenPipeline().reduce((total, opportunity) => total + opportunity.value, 0), collected: getCollectedRevenue() });
