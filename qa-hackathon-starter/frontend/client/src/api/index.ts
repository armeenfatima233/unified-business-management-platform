import { dashboardMetrics, demoUser, navCounts, pulseSummary } from "@/mock/data";
import { getCollectedRevenue, getDashboardCounts, getOpenPipeline, getRecoveryLeads, leads, opportunities, payments, team } from "@/mock/store";

export { getCollectedRevenue, getDashboardCounts, getOpenPipeline, getRecoveryLeads, leads, opportunities, payments, team };

export async function getDemoSession() {
  return localStorage.getItem("leadsafe_session") === "demo" ? demoUser : null;
}

export async function createDemoSession() {
  localStorage.setItem("leadsafe_session", "demo");
  return demoUser;
}

export async function clearDemoSession() {
  localStorage.removeItem("leadsafe_session");
}

export async function getDashboard() {
  return { metrics: dashboardMetrics, pulse: pulseSummary, counts: navCounts };
}

export async function acknowledgeLead(id: string) {
  return { ok: true, id, acknowledgedAt: new Date().toISOString() };
}
