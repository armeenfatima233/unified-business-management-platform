// Lead lifecycle (F3): intake, round-robin assignment, acknowledgement, escalation, reassignment on
// absence, recovery. Business rules live here; routes and the timer worker only call in.
//
// Concurrency (F3.8, Q5): every mutation runs inside tx() = BEGIN IMMEDIATE, which SQLite serialises.
// Each function re-reads the lead inside the transaction and re-checks its preconditions, so two
// timers firing together, a late acknowledgement, or a repeated request cannot produce two owners
// or two escalations.
import { randomUUID } from "node:crypto";
import { audit } from "../audit/audit.ts";
import { logActivity } from "../crm/common.ts";
import { tx, type Db } from "../db.ts";
import { publish } from "../events/bus.ts";
import { HttpError } from "../http.ts";

export type LeadSource = "web_form" | "message" | "manual";

export interface RoutingRules {
  workspace_id: string;
  ack_window_seconds: number;
  max_open_leads: number;
  escalation_levels: number;
  idle_seconds: number;
  level_window_seconds: string;
  backup_user_id: string | null;
  manager_user_id: string | null;
  cursor_user_id: string | null;
}

interface LeadRow {
  id: string;
  workspace_id: string;
  contact_id: string;
  source: LeadSource;
  message: string | null;
  owner_id: string;
  assigned_at: string;
  first_assigned_at: string;
  deadline_at: string | null;
  acknowledged_at: string | null;
  first_response_at: string | null;
  closed_at: string | null;
  escalation_count: number;
  level: number;
  handover_required: number;
  attention_reason: string | null;
  last_action_at: string;
  version: number;
  created_at: string;
}

const iso = (ms: number) => new Date(ms).toISOString();

export function getRules(db: Db, workspaceId: string): RoutingRules {
  let rules = db.prepare("SELECT * FROM lead_routing_rules WHERE workspace_id = ?").get(workspaceId) as RoutingRules | undefined;
  if (!rules) {
    // Workspaces created before routing existed get the same defaults as new ones.
    const owner = db.prepare("SELECT user_id FROM memberships WHERE workspace_id = ? AND base_level = 'owner'").get(workspaceId) as { user_id: string } | undefined;
    db.prepare("INSERT INTO lead_routing_rules (workspace_id, manager_user_id, updated_at) VALUES (?,?,?)").run(workspaceId, owner?.user_id ?? null, new Date().toISOString());
    rules = db.prepare("SELECT * FROM lead_routing_rules WHERE workspace_id = ?").get(workspaceId) as unknown as RoutingRules;
  }
  return rules;
}

// Seconds allowed at a given level (0 = first assignment); per-level overrides fall back to the default window.
export function windowSeconds(rules: RoutingRules, level: number): number {
  const overrides = JSON.parse(rules.level_window_seconds) as number[];
  return overrides[level] ?? rules.ack_window_seconds;
}

const getLead = (db: Db, workspaceId: string, leadId: string) =>
  db.prepare("SELECT * FROM leads WHERE workspace_id = ? AND id = ?").get(workspaceId, leadId) as LeadRow | undefined;

function openLeadCount(db: Db, workspaceId: string, userId: string): number {
  return (db.prepare("SELECT COUNT(*) AS n FROM leads WHERE workspace_id = ? AND owner_id = ? AND closed_at IS NULL").get(workspaceId, userId) as { n: number }).n;
}

// Available = status Available AND open-lead count below the cap (glossary, F3.3).
export function isEligible(db: Db, workspaceId: string, userId: string, rules: RoutingRules): boolean {
  const m = db.prepare("SELECT availability FROM memberships WHERE workspace_id = ? AND user_id = ? AND removed_at IS NULL").get(workspaceId, userId) as { availability: string } | undefined;
  return m?.availability === "available" && openLeadCount(db, workspaceId, userId) < rules.max_open_leads;
}

// Round-robin over eligible employees, continuing after the last chosen one (durable cursor).
function nextRoundRobin(db: Db, workspaceId: string, rules: RoutingRules, exclude: Set<string>): string | null {
  const members = db.prepare("SELECT user_id FROM memberships WHERE workspace_id = ? AND removed_at IS NULL ORDER BY created_at, user_id").all(workspaceId) as { user_id: string }[];
  if (members.length === 0) return null;
  const start = Math.max(0, members.findIndex((m) => m.user_id === rules.cursor_user_id) + 1);
  for (let i = 0; i < members.length; i++) {
    const id = members[(start + i) % members.length]!.user_id;
    if (!exclude.has(id) && isEligible(db, workspaceId, id, rules)) {
      db.prepare("UPDATE lead_routing_rules SET cursor_user_id = ? WHERE workspace_id = ?").run(id, workspaceId);
      return id;
    }
  }
  return null;
}

function managerFallback(db: Db, workspaceId: string, rules: RoutingRules): string {
  if (rules.manager_user_id) return rules.manager_user_id;
  const owner = db.prepare("SELECT user_id FROM memberships WHERE workspace_id = ? AND base_level = 'owner'").get(workspaceId) as { user_id: string };
  return owner.user_id;
}

function recordAssignment(db: Db, lead: { id: string; workspace_id: string }, from: string | null, to: string, reason: string, actorId: string | null) {
  db.prepare("INSERT INTO lead_assignment_history (id, workspace_id, lead_id, from_user_id, to_user_id, reason, created_at) VALUES (?,?,?,?,?,?,?)").run(
    randomUUID(), lead.workspace_id, lead.id, from, to, reason, new Date().toISOString(),
  );
  audit(db, {
    workspaceId: lead.workspace_id, actorId, action: reason === "escalation" ? "lead.escalated" : reason === "manual" || reason === "absence" ? "lead.reassigned" : "lead.assigned",
    targetType: "lead", targetId: lead.id, before: { ownerId: from }, after: { ownerId: to, reason },
  });
}

const userName = (db: Db, id: string) => (db.prepare("SELECT name FROM users WHERE id = ?").get(id) as { name: string } | undefined)?.name ?? "Unknown";

export interface CreateLeadInput {
  workspaceId: string;
  contactId: string;
  source: LeadSource;
  message?: string | null;
  actorId: string | null; // null for public form / provider webhooks
}

export function createLead(db: Db, input: CreateLeadInput): LeadRow {
  return tx(db, () => {
    const rules = getRules(db, input.workspaceId);
    const now = Date.now();
    let ownerId = nextRoundRobin(db, input.workspaceId, rules, new Set());
    let attention: string | null = null;
    let reason: "intake" | "fallback" = "intake";
    if (!ownerId) {
      // D06: nobody eligible -> the manager fallback is accountable and the lead is flagged.
      ownerId = managerFallback(db, input.workspaceId, rules);
      attention = "No eligible employee";
      reason = "fallback";
    }
    const id = randomUUID();
    db.prepare(
      `INSERT INTO leads (id, workspace_id, contact_id, source, message, owner_id, assigned_at, first_assigned_at, deadline_at,
                          escalation_count, level, attention_reason, last_action_at, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,0,0,?,?,?)`,
    ).run(id, input.workspaceId, input.contactId, input.source, input.message ?? null, ownerId, iso(now), iso(now), iso(now + windowSeconds(rules, 0) * 1000), attention, iso(now), iso(now));
    const lead = getLead(db, input.workspaceId, id)!;
    audit(db, { workspaceId: input.workspaceId, actorId: input.actorId, action: "lead.created", targetType: "lead", targetId: id, after: { source: input.source, contactId: input.contactId } });
    recordAssignment(db, lead, null, ownerId, reason, input.actorId);
    logActivity(db, { workspaceId: input.workspaceId, contactId: input.contactId, type: "lead", text: `Lead received from ${input.source.replace("_", " ")}; assigned to ${userName(db, ownerId)}.`, actorId: input.actorId });
    publish(input.workspaceId, { type: "newLead", title: "New lead assigned", detail: `${input.source.replace("_", " ")} lead assigned to ${userName(db, ownerId)}.`, tone: "info", leadId: id });
    return lead;
  });
}

// Acknowledge or act (F3.4). Idempotent: repeating it never moves the first-response time.
export function acknowledgeLead(db: Db, workspaceId: string, leadId: string, userId: string, canManage: boolean, how: "click" | "action" = "click"): LeadRow {
  return tx(db, () => {
    const lead = getLead(db, workspaceId, leadId);
    if (!lead) throw new HttpError(404, "NOT_FOUND", "Lead not found.");
    if (lead.owner_id !== userId && !canManage) throw new HttpError(403, "FORBIDDEN", "Only the lead owner or a manager can acknowledge this lead.");
    if (lead.closed_at) throw new HttpError(409, "LEAD_CLOSED", "This lead is closed.");
    if (lead.acknowledged_at) return lead; // duplicate request: no second first-response, no second audit row
    const now = iso(Date.now());
    db.prepare(
      `UPDATE leads SET acknowledged_at = ?, first_response_at = COALESCE(first_response_at, ?), deadline_at = NULL,
              attention_reason = NULL, last_action_at = ?, version = version + 1 WHERE id = ? AND acknowledged_at IS NULL`,
    ).run(now, now, now, leadId);
    audit(db, { workspaceId, actorId: userId, action: "lead.acknowledged", targetType: "lead", targetId: leadId, after: { how, ownerId: lead.owner_id } });
    logActivity(db, { workspaceId, contactId: lead.contact_id, type: "lead", text: `Lead acknowledged by ${userName(db, userId)}.`, actorId: userId });
    publish(workspaceId, { type: "leadUpdated", title: "Lead acknowledged", detail: `${userName(db, userId)} acknowledged a lead.`, tone: "success", leadId });
    return getLead(db, workspaceId, leadId)!;
  });
}

// Any recorded action on the contact (note, message, stage change, appointment) by the lead owner
// counts as acknowledgement and refreshes the idle timer (glossary: Acknowledged).
export function recordLeadAction(db: Db, workspaceId: string, contactId: string, userId: string) {
  tx(db, () => {
    const leads = db.prepare("SELECT id, owner_id, acknowledged_at FROM leads WHERE workspace_id = ? AND contact_id = ? AND closed_at IS NULL").all(workspaceId, contactId) as {
      id: string; owner_id: string; acknowledged_at: string | null;
    }[];
    for (const lead of leads) {
      if (lead.owner_id === userId && !lead.acknowledged_at) acknowledgeLead(db, workspaceId, lead.id, userId, false, "action");
      else if (lead.owner_id === userId) db.prepare("UPDATE leads SET last_action_at = ? WHERE id = ?").run(iso(Date.now()), lead.id);
    }
  });
}

// Moves an unacknowledged lead to `toUserId` and restarts the clock for the new owner.
function moveLead(db: Db, lead: LeadRow, toUserId: string, level: number, reason: "escalation" | "manual" | "absence" | "fallback", actorId: string | null, rules: RoutingRules, attention: string | null = null) {
  const now = Date.now();
  db.prepare(
    `UPDATE leads SET owner_id = ?, assigned_at = ?, deadline_at = ?, acknowledged_at = NULL, level = ?, handover_required = 0,
            attention_reason = ?, escalation_count = escalation_count + ?, last_action_at = ?, version = version + 1 WHERE id = ?`,
  ).run(toUserId, iso(now), iso(now + windowSeconds(rules, level) * 1000), level, attention, reason === "escalation" ? 1 : 0, iso(now), lead.id);
  recordAssignment(db, lead, lead.owner_id, toUserId, reason, actorId);
  logActivity(db, { workspaceId: lead.workspace_id, contactId: lead.contact_id, type: "assignment", text: `Lead ${reason === "escalation" ? "escalated" : "reassigned"} from ${userName(db, lead.owner_id)} to ${userName(db, toUserId)}.`, actorId });
}

// Escalation (F3.5): next eligible employee -> designated backup -> manager. Safe to call from
// several timers and after a restart: it acts only if the lead is still unacknowledged and overdue.
export function escalateLead(db: Db, workspaceId: string, leadId: string, nowMs = Date.now()): "escalated" | "exhausted" | "skipped" {
  return tx(db, () => {
    const lead = getLead(db, workspaceId, leadId);
    if (!lead || lead.closed_at || lead.acknowledged_at || !lead.deadline_at) return "skipped";
    if (new Date(lead.deadline_at).getTime() > nowMs) return "skipped"; // another path already moved it
    const rules = getRules(db, workspaceId);
    const step = lead.level + 1;
    if (step > rules.escalation_levels) {
      db.prepare("UPDATE leads SET deadline_at = NULL, attention_reason = 'Escalation chain exhausted', version = version + 1 WHERE id = ?").run(lead.id);
      audit(db, { workspaceId, actorId: null, action: "lead.escalation_exhausted", targetType: "lead", targetId: lead.id, after: { ownerId: lead.owner_id } });
      return "exhausted";
    }
    const tried = new Set((db.prepare("SELECT to_user_id FROM lead_assignment_history WHERE lead_id = ?").all(lead.id) as { to_user_id: string }[]).map((r) => r.to_user_id));
    let target: string | null = null;
    let usedStep = step;
    for (let s = step; s <= 3 && !target; s++) {
      usedStep = s;
      if (s === 1) target = nextRoundRobin(db, workspaceId, rules, tried);
      else if (s === 2) target = rules.backup_user_id && rules.backup_user_id !== lead.owner_id && isEligible(db, workspaceId, rules.backup_user_id, rules) ? rules.backup_user_id : null;
      else target = managerFallback(db, workspaceId, rules);
    }
    if (!target || target === lead.owner_id) {
      // The manager already holds it and nobody else can take it: stay accountable, keep it visible.
      db.prepare("UPDATE leads SET deadline_at = NULL, level = ?, attention_reason = 'Escalation chain exhausted', escalation_count = escalation_count + 1, version = version + 1 WHERE id = ?").run(Math.max(step, usedStep), lead.id);
      audit(db, { workspaceId, actorId: null, action: "lead.escalation_exhausted", targetType: "lead", targetId: lead.id, after: { ownerId: lead.owner_id } });
      return "exhausted";
    }
    moveLead(db, lead, target, Math.max(step, usedStep), "escalation", null, rules);
    queueEscalationAlert(db, workspaceId, lead.id, target, `Not acknowledged within ${windowSeconds(rules, lead.level)} seconds by ${userName(db, lead.owner_id)}`);
    publish(workspaceId, { type: "escalation", title: "Lead escalated", detail: `A lead moved from ${userName(db, lead.owner_id)} to ${userName(db, target)}.`, tone: "warning", leadId: lead.id });
    return "escalated";
  });
}

// F3.9 / I4: the alert is persisted in the same transaction as the escalation; the dispatcher sends it.
function queueEscalationAlert(db: Db, workspaceId: string, leadId: string, userId: string, reason: string) {
  db.prepare(
    `INSERT INTO delivery_attempts (id, workspace_id, lead_id, user_id, channel, reason, status, attempts, next_attempt_at, created_at)
     VALUES (?,?,?,?,'email',?,'pending',0,?,?)`,
  ).run(randomUUID(), workspaceId, leadId, userId, reason, iso(Date.now()), iso(Date.now()));
}

export function reassignLead(db: Db, workspaceId: string, leadId: string, actorId: string, assigneeId: string): LeadRow {
  return tx(db, () => {
    const lead = getLead(db, workspaceId, leadId);
    if (!lead) throw new HttpError(404, "NOT_FOUND", "Lead not found.");
    if (lead.closed_at) throw new HttpError(409, "LEAD_CLOSED", "This lead is closed.");
    const member = db.prepare("SELECT 1 FROM memberships WHERE workspace_id = ? AND user_id = ? AND removed_at IS NULL").get(workspaceId, assigneeId);
    if (!member) throw new HttpError(404, "NOT_FOUND", "Assignee not found.");
    if (assigneeId === lead.owner_id) return lead;
    const rules = getRules(db, workspaceId);
    if (!isEligible(db, workspaceId, assigneeId, rules)) {
      throw new HttpError(409, "ASSIGNEE_UNAVAILABLE", "That person is not Available or is at their open-lead limit.");
    }
    moveLead(db, lead, assigneeId, 0, "manual", actorId, rules);
    publish(workspaceId, { type: "leadUpdated", title: "Lead reassigned", detail: `Lead reassigned to ${userName(db, assigneeId)}.`, tone: "info", leadId });
    return getLead(db, workspaceId, leadId)!;
  });
}

export function closeLead(db: Db, workspaceId: string, leadId: string, userId: string, canManage: boolean): LeadRow {
  return tx(db, () => {
    const lead = getLead(db, workspaceId, leadId);
    if (!lead) throw new HttpError(404, "NOT_FOUND", "Lead not found.");
    if (lead.owner_id !== userId && !canManage) throw new HttpError(403, "FORBIDDEN", "Only the lead owner or a manager can close this lead.");
    if (lead.closed_at) return lead;
    const now = iso(Date.now());
    db.prepare("UPDATE leads SET closed_at = ?, deadline_at = NULL, version = version + 1 WHERE id = ?").run(now, leadId);
    audit(db, { workspaceId, actorId: userId, action: "lead.closed", targetType: "lead", targetId: leadId });
    return getLead(db, workspaceId, leadId)!;
  });
}

// F3.6: runs in the same transaction as the status change. Unacknowledged leads move at once; leads
// the person already acknowledged stay with them but are flagged for handover (D07).
export function handleAvailabilityChange(db: Db, workspaceId: string, userId: string, availability: string) {
  tx(db, () => {
    if (availability === "available") {
      db.prepare("UPDATE leads SET handover_required = 0 WHERE workspace_id = ? AND owner_id = ?").run(workspaceId, userId);
      return;
    }
    if (availability !== "on_leave" && availability !== "offline") return; // Busy keeps leads but stops new ones
    const rules = getRules(db, workspaceId);
    const owned = db.prepare("SELECT * FROM leads WHERE workspace_id = ? AND owner_id = ? AND closed_at IS NULL").all(workspaceId, userId) as unknown as LeadRow[];
    for (const lead of owned) {
      if (lead.acknowledged_at) {
        if (!lead.handover_required) {
          db.prepare("UPDATE leads SET handover_required = 1, version = version + 1 WHERE id = ?").run(lead.id);
          audit(db, { workspaceId, actorId: null, action: "lead.handover_required", targetType: "lead", targetId: lead.id, after: { ownerId: userId, availability } });
          publish(workspaceId, { type: "leadUpdated", title: "Handover required", detail: `${userName(db, userId)} is ${availability.replace("_", " ")} and still owns an acknowledged lead.`, tone: "warning", leadId: lead.id });
        }
        continue;
      }
      let target = nextRoundRobin(db, workspaceId, rules, new Set([userId]));
      let reason: "absence" | "fallback" = "absence";
      let attention: string | null = null;
      if (!target) {
        target = managerFallback(db, workspaceId, rules);
        reason = "fallback";
        attention = "No eligible employee";
      }
      if (target === userId) {
        db.prepare("UPDATE leads SET attention_reason = 'No eligible employee', handover_required = 1, version = version + 1 WHERE id = ?").run(lead.id);
        continue; // the manager is the one who is away: keep exactly one owner, flag it
      }
      moveLead(db, lead, target, lead.level, reason === "absence" ? "absence" : "fallback", null, rules, attention);
      queueEscalationAlert(db, workspaceId, lead.id, target, `${userName(db, userId)} is now ${availability.replace("_", " ")}`); // the new owner is told outside the app too
    }
  });
}

// Removing a person (Q4): their open leads move to someone eligible (or the manager fallback), routing
// settings that named them are repaired, and their record is kept (soft removal) so history, audit and
// closed leads still make sense. Runs in the caller's transaction.
export function releaseMember(db: Db, workspaceId: string, userId: string, actorId: string) {
  tx(db, () => {
    const rules = getRules(db, workspaceId);
    const owner = db.prepare("SELECT user_id FROM memberships WHERE workspace_id = ? AND base_level = 'owner' AND removed_at IS NULL").get(workspaceId) as { user_id: string };
    if (rules.backup_user_id === userId) db.prepare("UPDATE lead_routing_rules SET backup_user_id = NULL WHERE workspace_id = ?").run(workspaceId);
    if (rules.manager_user_id === userId) db.prepare("UPDATE lead_routing_rules SET manager_user_id = ? WHERE workspace_id = ?").run(owner.user_id, workspaceId);
    db.prepare("UPDATE memberships SET removed_at = ? WHERE workspace_id = ? AND user_id = ?").run(iso(Date.now()), workspaceId, userId); // first, so they are never picked as a target
    const fresh = getRules(db, workspaceId);
    const owned = db.prepare("SELECT * FROM leads WHERE workspace_id = ? AND owner_id = ? AND closed_at IS NULL").all(workspaceId, userId) as unknown as LeadRow[];
    for (const lead of owned) {
      let target = nextRoundRobin(db, workspaceId, fresh, new Set([userId]));
      let reason: "absence" | "fallback" = "absence";
      let attention: string | null = null;
      if (!target) { target = managerFallback(db, workspaceId, fresh); reason = "fallback"; attention = "No eligible employee"; }
      moveLead(db, lead, target, lead.level, reason, actorId, fresh, attention);
      queueEscalationAlert(db, workspaceId, lead.id, target, `${userName(db, userId)} was removed from the workspace`);
    }
    db.prepare("UPDATE opportunities SET owner_id = NULL, version = version + 1 WHERE workspace_id = ? AND owner_id = ?").run(workspaceId, userId);
    db.prepare("UPDATE contacts SET owner_id = NULL, version = version + 1 WHERE workspace_id = ? AND owner_id = ?").run(workspaceId, userId);
    db.prepare("DELETE FROM notification_destinations WHERE workspace_id = ? AND user_id = ?").run(workspaceId, userId);
    db.prepare("DELETE FROM sessions WHERE workspace_id = ? AND user_id = ?").run(workspaceId, userId); // signed out everywhere at once
    audit(db, { workspaceId, actorId, action: "member.removed", targetType: "member", targetId: userId, after: { reassignedLeads: owned.length } });
  });
}

// ----- Reading -----

export interface LeadView {
  id: string; contactId: string; contact: string; company: string | null; source: LeadSource; message: string | null;
  ownerId: string; owner: string; assignedAt: string; firstAssignedAt: string; deadlineAt: string | null;
  secondsRemaining: number | null; acknowledgedAt: string | null; firstResponseAt: string | null; closedAt: string | null;
  escalationCount: number; level: number; status: "needs_acknowledgement" | "escalated" | "acknowledged" | "closed";
  handoverRequired: boolean; attentionReason: string | null; recoveryReasons: string[]; lastActionAt: string; version: number; createdAt: string;
}

export function recoveryReasons(lead: LeadRow, rules: RoutingRules, nowMs: number): string[] {
  if (lead.closed_at) return [];
  const reasons: string[] = [];
  if (!lead.acknowledged_at && (lead.deadline_at === null || new Date(lead.deadline_at).getTime() < nowMs)) reasons.push("Unacknowledged beyond its window");
  if (lead.escalation_count >= 2) reasons.push(`Escalated ${lead.escalation_count} times`);
  if (nowMs - new Date(lead.last_action_at).getTime() > rules.idle_seconds * 1000) reasons.push("No recorded action for the idle period");
  if (lead.attention_reason) reasons.push(lead.attention_reason);
  return reasons;
}

export function toView(db: Db, lead: LeadRow, rules: RoutingRules, nowMs = Date.now()): LeadView {
  const contact = db.prepare("SELECT c.name, co.name AS company FROM contacts c LEFT JOIN companies co ON co.id = c.company_id WHERE c.id = ?").get(lead.contact_id) as { name: string; company: string | null };
  return {
    id: lead.id, contactId: lead.contact_id, contact: contact.name, company: contact.company, source: lead.source, message: lead.message,
    ownerId: lead.owner_id, owner: userName(db, lead.owner_id), assignedAt: lead.assigned_at, firstAssignedAt: lead.first_assigned_at,
    deadlineAt: lead.deadline_at, secondsRemaining: lead.deadline_at ? Math.max(0, Math.ceil((new Date(lead.deadline_at).getTime() - nowMs) / 1000)) : null,
    acknowledgedAt: lead.acknowledged_at, firstResponseAt: lead.first_response_at, closedAt: lead.closed_at, escalationCount: lead.escalation_count, level: lead.level,
    status: lead.closed_at ? "closed" : lead.acknowledged_at ? "acknowledged" : lead.escalation_count > 0 ? "escalated" : "needs_acknowledgement",
    handoverRequired: lead.handover_required === 1, attentionReason: lead.attention_reason, recoveryReasons: recoveryReasons(lead, rules, nowMs),
    lastActionAt: lead.last_action_at, version: lead.version, createdAt: lead.created_at,
  };
}

export interface LeadListOptions {
  scope: "mine" | "all" | "recovery";
  userId: string;
  canSeeAll: boolean;
  q?: string;
  includeClosed?: boolean;
  createdFrom?: string; // ISO time: leads created at or after
  escalatedSince?: string; // ISO time: leads with an escalation at or after
  limit: number;
  offset: number;
}

export function listLeads(db: Db, workspaceId: string, o: LeadListOptions) {
  const rules = getRules(db, workspaceId);
  const nowMs = Date.now();
  const where = ["l.workspace_id = ?"];
  const args: (string | number)[] = [workspaceId];
  if (o.scope === "mine" || !o.canSeeAll) { where.push("l.owner_id = ?"); args.push(o.userId); }
  if (!o.includeClosed) where.push("l.closed_at IS NULL");
  if (o.q) { where.push("c.name LIKE ? ESCAPE '\\'"); args.push(`%${o.q.replace(/[\\%_]/g, (m) => `\\${m}`)}%`); }
  if (o.createdFrom) { where.push("l.created_at >= ?"); args.push(o.createdFrom); }
  if (o.escalatedSince) {
    where.push("EXISTS (SELECT 1 FROM lead_assignment_history h WHERE h.lead_id = l.id AND h.reason = 'escalation' AND h.created_at >= ?)");
    args.push(o.escalatedSince);
  }
  if (o.scope === "recovery") {
    where.push(`l.closed_at IS NULL AND (
      (l.acknowledged_at IS NULL AND (l.deadline_at IS NULL OR l.deadline_at < ?))
      OR l.escalation_count >= 2 OR l.last_action_at < ? OR l.attention_reason IS NOT NULL)`);
    args.push(iso(nowMs), iso(nowMs - rules.idle_seconds * 1000));
  }
  const from = `FROM leads l JOIN contacts c ON c.id = l.contact_id WHERE ${where.join(" AND ")}`;
  const total = (db.prepare(`SELECT COUNT(*) AS n ${from}`).get(...args) as { n: number }).n;
  const rows = db.prepare(`SELECT l.* ${from} ORDER BY l.assigned_at DESC, l.rowid DESC LIMIT ? OFFSET ?`).all(...args, o.limit, o.offset) as unknown as LeadRow[];
  return { total, items: rows.map((r) => toView(db, r, rules, nowMs)) };
}

export function leadDetail(db: Db, workspaceId: string, leadId: string, userId: string, canSeeAll: boolean) {
  const lead = getLead(db, workspaceId, leadId);
  if (!lead || (!canSeeAll && lead.owner_id !== userId)) throw new HttpError(404, "NOT_FOUND", "Lead not found.");
  const history = db.prepare(
    `SELECT h.from_user_id, h.to_user_id, h.reason, h.created_at, uf.name AS from_name, ut.name AS to_name
     FROM lead_assignment_history h LEFT JOIN users uf ON uf.id = h.from_user_id JOIN users ut ON ut.id = h.to_user_id
     WHERE h.lead_id = ? ORDER BY h.created_at, h.rowid`,
  ).all(leadId) as unknown as { from_user_id: string | null; to_user_id: string; reason: string; created_at: string; from_name: string | null; to_name: string }[];
  return {
    ...toView(db, lead, getRules(db, workspaceId)),
    history: history.map((h) => ({ fromUserId: h.from_user_id, from: h.from_name, toUserId: h.to_user_id, to: h.to_name, reason: h.reason, at: h.created_at })),
  };
}

// Used by the timer worker: ids of leads whose window has passed.
export function dueLeads(db: Db, nowMs = Date.now(), limit = 100, workspaceId?: string): { id: string; workspace_id: string }[] {
  return db.prepare(
    `SELECT id, workspace_id FROM leads WHERE deadline_at IS NOT NULL AND deadline_at <= ? AND acknowledged_at IS NULL AND closed_at IS NULL
       AND (? IS NULL OR workspace_id = ?) ORDER BY deadline_at LIMIT ?`,
  ).all(iso(nowMs), workspaceId ?? null, workspaceId ?? null, limit) as { id: string; workspace_id: string }[];
}
