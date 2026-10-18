// Durable escalation timer (D03, Q5). Nothing lives only in memory: due times are columns on the
// lead, so after a crash or restart the first tick finds everything that came due while the
// server was down. escalateLead() re-checks the lead inside its own transaction, so overlapping
// ticks or multiple processes cannot escalate the same lead twice.
import type { Db } from "../db.ts";
import { dueLeads, escalateLead } from "./service.ts";

export function runLeadTick(db: Db, nowMs = Date.now(), workspaceId?: string): number {
  let escalated = 0;
  for (const due of dueLeads(db, nowMs, 100, workspaceId)) {
    try {
      if (escalateLead(db, due.workspace_id, due.id, nowMs) === "escalated") escalated++;
    } catch (err) {
      console.error("escalation failed for lead", due.id, err); // one bad lead must not stop the rest
    }
  }
  return escalated;
}

export function startWorker(db: Db, intervalMs: number, extraTicks: Array<() => Promise<void> | void> = []) {
  let running = false;
  const timer = setInterval(async () => {
    if (running) return; // never overlap with itself
    running = true;
    try {
      runLeadTick(db);
      for (const tick of extraTicks) await tick();
    } catch (err) {
      console.error("worker tick failed", err);
    } finally {
      running = false;
    }
  }, intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}
