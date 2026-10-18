import { useEffect, useMemo, useState } from "react";
import {
  Activity,
  AlertCircle,
  ArrowDownRight,
  ArrowUpRight,
  Bell,
  Building2,
  CalendarDays,
  Check,
  ChevronDown,
  ChevronRight,
  CircleDollarSign,
  Clock3,
  Command,
  CreditCard,
  FileClock,
  Filter,
  GripVertical,
  Headphones,
  LayoutDashboard,
  LifeBuoy,
  Menu,
  MoreHorizontal,
  Plus,
  Search,
  Settings2,
  Settings,
  ShieldCheck,
  SlidersHorizontal,
  Sparkles,
  Users,
  X,
  Zap,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { useLocation } from "wouter";
import { getDashboardCounts } from "@/api";
import { NavProvider, notify, useSession, type NavParams } from "@/live/session";
import { setMyAvailability } from "@/live/api/team";
import { listLeads } from "@/live/api/leads";
import { useAsync } from "@/live/useAsync";
import { LivePage, moduleOfId } from "@/live/pages";
import { availabilityLabel, levelLabel } from "@/live/format";
import type { Availability, Permission } from "@/live/api/types";

// NOTE: this file is the shell (sidebar, top bar) of the app, connected to the backend. The page components further down
// (Dashboard, Pipeline, PaymentsView ... ModuleView) are the ORIGINAL STATIC PROTOTYPE and are no longer rendered: what the
// app shows now comes from client/src/live/pages, which reuse the same CSS classes and talk to the backend.

type Pulse = "SAFE" | "WATCH" | "CRITICAL" | "ESCALATED";
type Lead = { name: string; company: string; source: string; owner: string; initials: string; pulse: Pulse; time: string; timer: string; secondsRemaining: number; reason: string };
type Deal = { id: string; name: string; company: string; value: string; owner: string; initials: string; age: string; priority?: "Hot" | "Warm" };
type PipelineStage = { id: string; name: string; color: string; deals: Deal[] };

const navItems = [
  { section: "Overview", label: "Dashboard", icon: LayoutDashboard },
  { section: "Revenue", label: "Leads", icon: Zap },
  { section: "Revenue", label: "Pipeline", icon: Activity, needs: "crmView" as Permission },
  { section: "Revenue", label: "Contacts", icon: Users, needs: "crmView" as Permission },
  { section: "Revenue", label: "Companies", icon: Building2, needs: "crmView" as Permission },
  { section: "Engagement", label: "Conversations", icon: Headphones },
  { section: "Engagement", label: "Recovery Queue", icon: LifeBuoy, urgent: true },
  { section: "Operations", label: "Appointments", icon: CalendarDays },
  { section: "Operations", label: "Payments", icon: CreditCard },
  { section: "Operations", label: "Team", icon: Users },
  { section: "Workspace", label: "Integrations", icon: SlidersHorizontal, needs: "manageIntegrations" as Permission },
  { section: "Workspace", label: "Audit Log", icon: FileClock, needs: "viewAuditLog" as Permission },
  { section: "Workspace", label: "Settings", icon: Settings, adminOnly: true },
];

const leads: Lead[] = [
  { name: "Maya Chen", company: "Northstar Studio", source: "Website form", owner: "Ava Patel", initials: "MC", pulse: "CRITICAL", time: "2 min ago", timer: "04:32", secondsRemaining: 272, reason: "Needs acknowledgement" },
  { name: "Jon Bell", company: "Ridgeway Homes", source: "WhatsApp Sandbox", owner: "Noah Williams", initials: "JB", pulse: "WATCH", time: "8 min ago", timer: "11:08", secondsRemaining: 668, reason: "Approaching deadline" },
  { name: "Sofia Ramirez", company: "Lumen Dental", source: "Referral", owner: "Ethan Kim", initials: "SR", pulse: "ESCALATED", time: "18 min ago", timer: "—", secondsRemaining: 0, reason: "Owner reassigned" },
  { name: "Jordan Lee", company: "Brightwell Labs", source: "Web form", owner: "Ava Patel", initials: "JL", pulse: "SAFE", time: "25 min ago", timer: "15:00", secondsRemaining: 900, reason: "Follow-up queued" },
];

const stages: PipelineStage[] = [
  { id: "new", name: "New lead", color: "#2563eb", deals: [
    { id: "d1", name: "Maya Chen", company: "Northstar Studio", value: "$18,500", owner: "Ava Patel", initials: "AP", age: "2 days", priority: "Hot" },
    { id: "d2", name: "Jordan Lee", company: "Brightwell Labs", value: "$12,200", owner: "Noah Williams", initials: "NW", age: "5 days" },
    { id: "d3", name: "Priya Shah", company: "Goodfolk Market", value: "$8,400", owner: "Ethan Kim", initials: "EK", age: "7 days" },
  ] },
  { id: "qualified", name: "Qualified", color: "#7c3aed", deals: [
    { id: "d4", name: "Jon Bell", company: "Ridgeway Homes", value: "$24,000", owner: "Noah Williams", initials: "NW", age: "4 days", priority: "Warm" },
    { id: "d5", name: "Alicia Gomez", company: "Morrow & Co.", value: "$16,800", owner: "Ava Patel", initials: "AP", age: "9 days" },
  ] },
  { id: "proposal", name: "Proposal", color: "#db2777", deals: [
    { id: "d6", name: "Sofia Ramirez", company: "Lumen Dental", value: "$31,500", owner: "Ethan Kim", initials: "EK", age: "3 days", priority: "Hot" },
    { id: "d7", name: "Marcus Young", company: "Peak Fitness", value: "$9,750", owner: "Ava Patel", initials: "AP", age: "11 days" },
  ] },
  { id: "negotiation", name: "Negotiation", color: "#0891b2", deals: [
    { id: "d8", name: "Nadia Wilson", company: "Atlas Works", value: "$42,000", owner: "Noah Williams", initials: "NW", age: "6 days", priority: "Hot" },
  ] },
];

const team = [
  { name: "Ava Patel", role: "Sales lead", initials: "AP", status: "Available", tone: "available", load: "2 active leads", openLeads: 2, limit: 8 },
  { name: "Noah Williams", role: "Account executive", initials: "NW", status: "On a call", tone: "busy", load: "4 active leads", openLeads: 4, limit: 6 },
  { name: "Ethan Kim", role: "Account executive", initials: "EK", status: "Available", tone: "available", load: "1 active lead", openLeads: 1, limit: 8 },
];

function Avatar({ initials, tone = "indigo", small = false }: { initials: string; tone?: string; small?: boolean }) {
  return <span className={cn("avatar", `avatar-${tone}`, small && "avatar-small")}>{initials}</span>;
}

function useDemoRole() {
  const [role, setRole] = useState(() => localStorage.getItem("leadsafe_role") || "Owner");
  useEffect(() => { const sync = () => setRole(localStorage.getItem("leadsafe_role") || "Owner"); window.addEventListener("leadsafe-role-change", sync); return () => window.removeEventListener("leadsafe-role-change", sync); }, []);
  return [role, (next: string) => { localStorage.setItem("leadsafe_role", next); window.dispatchEvent(new Event("leadsafe-role-change")); }] as const;
}

function PulsePill({ pulse }: { pulse: Pulse }) {
  const map: Record<Pulse, { label: string; className: string; icon: typeof ShieldCheck }> = {
    SAFE: { label: "Safe", className: "pulse-safe", icon: ShieldCheck },
    WATCH: { label: "Watch", className: "pulse-watch", icon: Clock3 },
    CRITICAL: { label: "Critical", className: "pulse-critical", icon: AlertCircle },
    ESCALATED: { label: "Escalated", className: "pulse-escalated", icon: ArrowUpRight },
  };
  const item = map[pulse];
  const Icon = item.icon;
  return <span className={cn("pulse-pill", item.className)}><Icon size={13} />{item.label}</span>;
}

function TopBar({ activeNav, setAvailability, availability, onMenu, onGo }: { activeNav: string; setAvailability: (value: Availability) => void; availability: Availability; onMenu: () => void; onGo: (module: string) => void }) {
  const [open, setOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [accountOpen, setAccountOpen] = useState(false);
  const { user, signOut, liveEvents } = useSession();
  const [bellOpen, setBellOpen] = useState(false);
  const [, navigate] = useLocation();
  useEffect(() => { const onKey = (event: KeyboardEvent) => { if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") { event.preventDefault(); setPaletteOpen(true); } if (event.key === "Escape") setPaletteOpen(false); }; window.addEventListener("keydown", onKey); return () => window.removeEventListener("keydown", onKey); }, []);
  const paletteResults = ["Dashboard", "Leads", "Pipeline", "Contacts", "Companies", "Conversations", "Recovery Queue", "Appointments", "Payments", "Team", "Integrations", "Audit Log", "Settings"].filter(item => item.toLowerCase().includes(query.toLowerCase())).slice(0, 8);
  return <header className="topbar">
    <div className="topbar-left"><button className="icon-button mobile-menu" aria-label="Open navigation" onClick={onMenu}><Menu size={21} /></button><div className="breadcrumb"><span>{user?.workspaceName}</span><ChevronRight size={15} /><strong>{activeNav}</strong></div></div>
    <div className="top-actions">
      <button className="command-button" onClick={() => setPaletteOpen(true)} aria-label="Open command palette"><Command size={14} /><span>Quick find</span><kbd>⌘ K</kbd></button>
      <span className="live-top-indicator"><i /> Live</span><div className="availability-wrap"><button className="availability-button" aria-haspopup="listbox" aria-expanded={open} onClick={() => setOpen(!open)}><span className={cn("availability-dot", availability === "busy" && "busy", availability === "on_leave" && "away", availability === "offline" && "dnd")} />{availabilityLabel[availability]}<ChevronDown size={14} /></button>{open && <div className="availability-menu" role="listbox">{(["available", "busy", "on_leave", "offline"] as Availability[]).map(status => <button key={status} onClick={() => { setAvailability(status); setOpen(false); }}><span className={cn("availability-dot", status === "busy" && "busy", status === "on_leave" && "away", status === "offline" && "dnd")} />{availabilityLabel[status]}{status === availability && <Check size={14} />}</button>)}</div>}</div><div className="role-switcher availability-wrap"><span className="role-button" title="Your level in this workspace. The Owner sets it and the server enforces it."><span>ROLE</span>{user ? levelLabel[user.baseLevel] : ""}</span></div>
      <div className="availability-wrap"><button className="icon-button notification-button" aria-label="Recent activity" onClick={() => setBellOpen(!bellOpen)}><Bell size={18} />{liveEvents.length > 0 && <span className="notification-dot" />}</button>{bellOpen && <div className="availability-menu" style={{ minWidth: 280, right: 0 }} role="region" aria-label="Recent activity">{liveEvents.length === 0 ? <p style={{ margin: 0, padding: 10, fontSize: 12, color: "#667685" }}>Nothing new yet. New leads, escalations and messages appear here as they happen.</p> : liveEvents.map((event, index) => <div key={index} style={{ padding: "8px 10px", fontSize: 12 }}><strong>{event.title}</strong><br /><span style={{ color: "#667685" }}>{event.detail}</span></div>)}</div>}</div><div className="avatar-menu-wrap availability-wrap"><button className="avatar-menu-trigger" aria-label="Open account menu" onClick={() => setAccountOpen(!accountOpen)}><Avatar initials={user?.initials ?? "?"} tone="coral" small /></button>{accountOpen && <div className="account-menu"><strong>{user?.name}</strong><span>{user ? levelLabel[user.baseLevel] : ""} · {user?.workspaceName}</span><button onClick={async () => { await signOut(); navigate("/login"); }}>Log out</button></div>}</div>
    </div>{paletteOpen && <div className="command-overlay" role="dialog" aria-modal="true" aria-label="Command palette" onClick={() => setPaletteOpen(false)}><div className="command-palette" onClick={event => event.stopPropagation()}><div className="command-input"><Search size={17} /><input autoFocus value={query} onChange={event => setQuery(event.target.value)} placeholder="Search pages, leads, contacts…" /><kbd>ESC</kbd></div><div className="command-results">{paletteResults.map(item => <button key={item} onClick={() => { setPaletteOpen(false); setQuery(""); onGo(item); }}>{item.includes(" ") && !["Recovery Queue", "Audit Log"].includes(item) ? <Users size={15} /> : <LayoutDashboard size={15} />}<span>{item}</span><ArrowUpRight size={13} /></button>)}{paletteResults.length === 0 && <div className="command-empty">No matching pages or records.</div>}</div></div></div>}</header>;
}

function Dashboard({ onNavigate }: { onNavigate: (page: string) => void }) {
  const [acknowledged, setAcknowledged] = useState<string[]>([]);
  const [filter, setFilter] = useState<"all" | "urgent">("all");
  const [remaining, setRemaining] = useState<Record<string, number>>(() => Object.fromEntries(leads.map(lead => [lead.name, lead.secondsRemaining])));
  const [escalated, setEscalated] = useState<string[]>([]);
  const [toast, setToast] = useState("");
  const dashboardSummary = getDashboardCounts();
  useEffect(() => { const timer = window.setInterval(() => setRemaining(current => Object.fromEntries(Object.entries(current).map(([name, seconds]) => [name, Math.max(0, seconds - 1)]))), 1000); return () => window.clearInterval(timer); }, []);
  useEffect(() => { const newlyExpired = leads.find(lead => lead.secondsRemaining > 0 && remaining[lead.name] === 0 && !escalated.includes(lead.name)); if (newlyExpired) { setEscalated(value => [...value, newlyExpired.name]); setToast(`${newlyExpired.name} escalated to the next owner`); window.setTimeout(() => setToast(""), 3500); } }, [remaining, escalated]);
  const liveLeads = leads.map(lead => ({ ...lead, timer: `${String(Math.floor((remaining[lead.name] ?? 0) / 60)).padStart(2, "0")}:${String((remaining[lead.name] ?? 0) % 60).padStart(2, "0")}`, pulse: escalated.includes(lead.name) ? "ESCALATED" as Pulse : lead.pulse, owner: escalated.includes(lead.name) ? "Noah Williams" : lead.owner, reason: escalated.includes(lead.name) ? "Owner reassigned automatically" : lead.reason }));
  const visibleLeads = useMemo(() => filter === "urgent" ? liveLeads.filter(lead => lead.pulse === "CRITICAL" || lead.pulse === "ESCALATED") : liveLeads, [filter, remaining, escalated]);
  return <>
    <section className="page-heading"><div><p className="eyebrow"><span className="eyebrow-dot" /> Monday, 18 Oct 2026</p><h1>Operations overview</h1><p className="subheading">Ownership, response SLAs, and pipeline movement across Northstar Services.</p></div><div className="heading-actions"><button className="secondary-button"><CalendarDays size={16} /> This week <ChevronDown size={15} /></button><button className="primary-button"><Plus size={17} /> Add lead</button></div></section>
    <section className="pulse-hero"><div className="pulse-hero-copy"><p className="pulse-kicker"><span className="pulse-kicker-dot" /> Lead Safety Pulse</p><h2>Pipeline health is <strong>SAFE</strong></h2><p>Every active lead has an accountable owner. Two leads are approaching their acknowledgement window.</p><div className="pulse-hero-stats"><span><b>86</b> pulse score</span><span><b>02</b> unacknowledged</span><span><b>08m 42s</b> avg. first response</span></div></div><div className="pulse-ring-wrap" aria-label="Lead Safety Pulse score 86, safe"><div className="pulse-ring pulse-ring-outer" /><div className="pulse-ring pulse-ring-middle" /><div className="pulse-ring pulse-ring-inner"><span>86</span><small>SAFE</small></div><div className="pulse-ring-signal signal-one" /><div className="pulse-ring-signal signal-two" /></div><div className="pulse-hero-side"><span className="hero-live"><i /> Live monitoring</span><strong>2</strong><span>leads need attention</span><button className="hero-link" onClick={() => onNavigate("Leads")}>Review now <ArrowUpRight size={14} /></button></div></section>
    <section className="metric-strip" aria-label="Key metrics">
      <div className="metric-cell"><div className="metric-icon metric-icon-blue"><Zap size={17} /></div><div><p>Leads captured today</p><strong>24</strong><span className="metric-trend trend-up"><ArrowUpRight size={13} /> 18.4%</span></div><span className="sparkline sparkline-blue"><i /><i /><i /><i /><i /><i /><i /><i /></span></div>
      <div className="metric-cell"><div className="metric-icon metric-icon-purple"><Clock3 size={17} /></div><div><p>First response SLA</p><strong>8m 42s</strong><span className="metric-trend trend-up"><ArrowDownRight size={13} /> 12.6%</span></div><span className="sparkline sparkline-purple"><i /><i /><i /><i /><i /><i /><i /><i /></span></div>
      <div className="metric-cell"><div className="metric-icon metric-icon-amber"><ArrowUpRight size={17} /></div><div><p>Escalations · last 24h</p><strong>04</strong><span className="metric-trend trend-flat">— 2 less than yesterday</span></div></div>
      <div className="metric-cell metric-cell-last"><div className="metric-icon metric-icon-mint"><CircleDollarSign size={17} /></div><div><p>Collected this month</p><strong>$28.4k</strong><span className="metric-trend trend-up"><ArrowUpRight size={13} /> 9.2%</span></div><span className="sparkline sparkline-mint"><i /><i /><i /><i /><i /><i /><i /><i /></span></div>
    </section>
    <section className="attention-panel panel"><div className="section-heading"><div><div className="section-title-row"><span className="live-dot" /><h2>Attention needed</h2><span className="count-badge">{visibleLeads.filter(lead => !acknowledged.includes(lead.name)).length}</span></div><p>Leads that need a response before they slip.</p></div><div className="section-tools"><div className="segmented"><button className={filter === "all" ? "selected" : ""} onClick={() => setFilter("all")}>All leads</button><button className={filter === "urgent" ? "selected" : ""} onClick={() => setFilter("urgent")}>Urgent <span>{liveLeads.filter(lead => lead.pulse === "CRITICAL" || lead.pulse === "ESCALATED").length}</span></button></div><button className="icon-button subtle" aria-label="Filter attention list"><Filter size={16} /></button></div></div>
      <div className="lead-table"><div className="lead-table-head"><span>Lead</span><span>Owner</span><span>Pulse</span><span>Time remaining</span><span>Next step</span><span /></div>{visibleLeads.map(lead => { const done = acknowledged.includes(lead.name); return <div className={cn("lead-row", done && "lead-row-done")} key={lead.name}><div className="lead-identity"><Avatar initials={lead.initials} tone={lead.pulse === "CRITICAL" ? "coral" : lead.pulse === "WATCH" ? "amber" : "violet"} /><div><strong>{lead.name}</strong><span>{lead.company} <b>·</b> {lead.source}</span></div></div><div className="owner-cell"><Avatar initials={lead.owner.split(" ").map(part => part[0]).join("")} tone="slate" small /><span>{lead.owner}</span></div><div><PulsePill pulse={lead.pulse} /></div><div className={cn("timer-cell", lead.pulse === "CRITICAL" && "timer-critical")}><Clock3 size={15} /><strong>{done ? "Acknowledged" : lead.timer}</strong>{!done && <small>{lead.time}</small>}</div><div className="next-step"><span>{done ? "Follow-up queued" : lead.reason}</span></div><div className="row-action">{done ? <span className="done-check"><Check size={15} /> Done</span> : <button className="ack-button" onClick={() => setAcknowledged(current => [...current, lead.name])}>Acknowledge</button>}<button className="icon-button subtle" aria-label={`More actions for ${lead.name}`}><MoreHorizontal size={17} /></button></div></div>; })}</div>
      <button className="view-all-button" onClick={() => onNavigate("Leads")}>View all leads <ArrowUpRight size={15} /></button>
    </section>
    <div className="dashboard-grid"><section className="panel pipeline-panel"><div className="section-heading compact"><div><h2>Open pipeline</h2><p>Value by stage <span className="dot-divider">·</span> <strong>${(dashboardSummary.pipelineValue / 1000).toFixed(1)}k total</strong></p></div><button className="icon-button subtle"><MoreHorizontal size={17} /></button></div><div className="pipeline-content"><div className="pipeline-total"><strong>${(dashboardSummary.pipelineValue / 1000).toFixed(1)}k</strong><span><ArrowUpRight size={14} /> 14.8% <em>vs last month</em></span></div>{["New lead", "Qualified", "Proposal", "Negotiation"].map((name, index) => <div className="stage-row" key={name}><div className="stage-label"><span className="stage-dot" style={{ background: ["#2563eb", "#7c3aed", "#db2777", "#0891b2"][index] }} /><span>{name}</span><small>{[3, 2, 2, 1][index]}</small></div><div className="stage-bar"><span style={{ width: ["82%", "68%", "50%", "35%"][index], background: ["#2563eb", "#7c3aed", "#db2777", "#0891b2"][index] }} /></div><strong>{["$84.2k", "$126.8k", "$91.4k", "$58.6k"][index]}</strong></div>)}</div><button className="panel-link" onClick={() => onNavigate("Pipeline")}>View pipeline <ChevronRight size={15} /></button></section>
      <section className="panel recovery-panel"><div className="section-heading compact"><div><div className="section-title-row"><h2>Recovery Queue</h2><span className="count-badge count-badge-red">{dashboardSummary.recovery}</span></div><p>Intervene before a lead is lost.</p></div><button className="icon-button subtle"><MoreHorizontal size={17} /></button></div><div className="recovery-list"><div className="recovery-item"><span className="recovery-icon recovery-red"><AlertCircle size={16} /></span><div><strong>Unacknowledged</strong><span>Deadline exceeded <b>·</b> Maya Chen</span></div><ChevronRight size={16} /></div><div className="recovery-item"><span className="recovery-icon recovery-amber"><ArrowUpRight size={16} /></span><div><strong>Escalated 2 times</strong><span>Jon Bell <b>·</b> 14 min ago</span></div><ChevronRight size={16} /></div></div><button className="panel-link" onClick={() => onNavigate("Recovery Queue")}>Open Recovery Queue <ChevronRight size={15} /></button></section>
      <section className="panel team-panel"><div className="section-heading compact"><div><h2>Team readiness</h2><p>Who can take the next lead?</p></div><button className="icon-button subtle"><MoreHorizontal size={17} /></button></div><div className="team-list">{team.map((member, index) => <div className="team-item" key={member.name}><Avatar initials={member.initials} tone={index === 1 ? "violet" : index === 2 ? "mint" : "blue"} /><div className="team-details"><strong>{member.name}</strong><span>{member.role}</span></div><div className="team-status"><span className={cn("status-dot", member.tone)} />{member.status}<small>{member.load}</small></div></div>)}</div><button className="panel-link">Manage team <ChevronRight size={15} /></button></section>
      <section className="panel schedule-panel"><div className="section-heading compact"><div><h2>Today, October 18</h2><p>Upcoming appointments</p></div><button className="icon-button subtle"><MoreHorizontal size={17} /></button></div><div className="appointment-list">{["10:30 AM · Discovery call · Northstar Studio", "01:00 PM · Proposal review · Ridgeway Homes", "03:45 PM · Onboarding · Lumen Dental"].map(item => <div className="appointment-item" key={item}><CalendarDays size={15} /><div><strong>{item}</strong><span>Customer meeting</span></div><ChevronRight size={16} /></div>)}</div><button className="panel-link">Open calendar <ChevronRight size={15} /></button></section></div>
    <section className="bottom-note"><div className="note-mark"><Sparkles size={16} /></div><div><strong>Response SLA is holding</strong><span>First response is 8m 42s, within the configured target.</span></div><button className="note-action">See insights <ArrowUpRight size={15} /></button></section>{toast && <div className="live-toast"><ShieldCheck size={16} />{toast}</div>}
  </>;
}

function Pipeline() {
  const [columns, setColumns] = useState(stages);
  const [dragged, setDragged] = useState<{ deal: Deal; stageId: string } | null>(null);
  const [view, setView] = useState<"board" | "list">("board");
  const [search, setSearch] = useState("");
  const [newDealOpen, setNewDealOpen] = useState(false);
  const pipelineSummary = getDashboardCounts();
  const filtered = columns.map(column => ({ ...column, deals: column.deals.filter(deal => `${deal.name} ${deal.company}`.toLowerCase().includes(search.toLowerCase())) }));
  const moveDeal = (targetStageId: string) => { if (!dragged || dragged.stageId === targetStageId) return; setColumns(current => current.map(column => column.id === dragged.stageId ? { ...column, deals: column.deals.filter(deal => deal.id !== dragged.deal.id) } : column.id === targetStageId ? { ...column, deals: [...column.deals, dragged.deal] } : column)); setDragged(null); };
  return <div className="pipeline-page"><section className="page-heading"><div><p className="eyebrow"><span className="eyebrow-dot" /> Operations workspace</p><h1>Pipeline</h1><p className="subheading">Track every opportunity from first touch to close.</p></div><div className="heading-actions"><button className="secondary-button"><Filter size={16} /> Filter</button><button className="primary-button" onClick={() => setNewDealOpen(true)}><Plus size={17} /> Add opportunity</button></div></section>
    <section className="pipeline-toolbar panel"><div className="pipeline-summary"><strong>${(pipelineSummary.pipelineValue / 1000).toFixed(1)}k</strong><span>{pipelineSummary.opportunities} open opportunities</span></div><div className="pipeline-toolbar-actions"><label className="pipeline-search"><Search size={15} /><input aria-label="Search opportunities" placeholder="Search opportunities" value={search} onChange={event => setSearch(event.target.value)} /></label><div className="view-toggle"><button className={view === "board" ? "selected" : ""} onClick={() => setView("board")}>Board</button><button className={view === "list" ? "selected" : ""} onClick={() => setView("list")}>List</button></div></div></section>
    {view === "board" ? <div className="kanban-board">{filtered.map(stage => <section className="kanban-column" key={stage.id} onDragOver={event => event.preventDefault()} onDrop={() => moveDeal(stage.id)}><div className="kanban-column-header"><div><span className="stage-color-dot" style={{ background: stage.color }} /><h2>{stage.name}</h2><span className="column-count">{stage.deals.length}</span></div><button className="icon-button subtle" aria-label={`Add deal to ${stage.name}`}><Plus size={16} /></button></div><div className="kanban-total">{stage.deals.reduce((sum, deal) => sum + Number(deal.value.replace(/[$,]/g, "")), 0).toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 })}</div><div className="deal-stack">{stage.deals.map(deal => <article className="deal-card" draggable onDragStart={() => setDragged({ deal, stageId: stage.id })} key={deal.id}><div className="deal-card-top"><span className="deal-id">{deal.id.toUpperCase()}</span><button className="icon-button subtle" aria-label={`More actions for ${deal.name}`}><MoreHorizontal size={15} /></button></div><h3>{deal.name}</h3><p>{deal.company}</p><div className="deal-value">{deal.value}{deal.priority && <span className={cn("deal-priority", deal.priority === "Hot" && "hot")}>{deal.priority}</span>}</div><div className="deal-card-footer"><span><Avatar initials={deal.initials} tone="blue" small />{deal.age}</span><GripVertical size={14} className="drag-icon" /></div></article>)}</div><button className="add-stage-deal"><Plus size={15} /> Add opportunity</button></section>)}</div> : <section className="panel opportunity-list"><div className="opportunity-list-head"><span>Opportunity</span><span>Stage</span><span>Owner</span><span>Value</span><span>Age</span></div>{filtered.flatMap(stage => stage.deals.map(deal => <div className="opportunity-list-row" key={deal.id}><div><strong>{deal.name}</strong><span>{deal.company}</span></div><span className="stage-list-chip"><i style={{ background: stage.color }} />{stage.name}</span><span>{deal.owner}</span><strong>{deal.value}</strong><span>{deal.age}</span></div>))}</section>}
    <div className="pipeline-footnote"><ShieldCheck size={15} /> Drag cards between stages to update ownership flow. <span className="sandbox-chip">Sandbox / Test data</span></div>
    {newDealOpen && <div className="modal-backdrop" onClick={() => setNewDealOpen(false)}><div className="new-deal-modal" onClick={event => event.stopPropagation()}><div className="modal-heading"><div><h2>Add opportunity</h2><p>Create a local prototype opportunity.</p></div><button className="icon-button" onClick={() => setNewDealOpen(false)}><X size={18} /></button></div><label>Opportunity name<input autoFocus placeholder="e.g. Acme renewal" /></label><label>Company<input placeholder="Search companies" /></label><label>Estimated value<input placeholder="$0.00" /></label><div className="modal-actions"><button className="secondary-button" onClick={() => setNewDealOpen(false)}>Cancel</button><button className="primary-button" onClick={() => setNewDealOpen(false)}>Create opportunity</button></div></div></div>}
  </div>;
}

const moduleContent: Record<string, { eyebrow: string; title: string; description: string; metrics: [string, string, string][]; columns: string[]; rows: string[][] }> = {
  Leads: { eyebrow: "Revenue workspace", title: "Lead intake", description: "Capture, assign, and protect every incoming opportunity.", metrics: [["Open leads", "48", "12 need an owner"], ["Response SLA", "8m 42s", "12.6% faster"], ["At risk", "04", "Needs intervention"]], columns: ["Lead", "Source", "Owner", "Status"], rows: [["Maya Chen · Northstar Studio", "Website form", "Ava Patel", "Critical"], ["Jon Bell · Ridgeway Homes", "WhatsApp Sandbox", "Noah Williams", "Watch"], ["Sofia Ramirez · Lumen Dental", "Referral", "Ethan Kim", "Escalated"]] },
  Contacts: { eyebrow: "Customer records", title: "Contacts", description: "People connected to your companies, conversations, and opportunities.", metrics: [["Total contacts", "1,284", "28 added this month"], ["Active conversations", "36", "Across 4 channels"], ["Unassigned", "09", "Needs routing"]], columns: ["Contact", "Company", "Owner", "Last activity"], rows: [["Maya Chen", "Northstar Studio", "Ava Patel", "2 min ago"], ["Jon Bell", "Ridgeway Homes", "Noah Williams", "8 min ago"], ["Sofia Ramirez", "Lumen Dental", "Ethan Kim", "18 min ago"]] },
  Companies: { eyebrow: "Customer records", title: "Companies", description: "A clear view of accounts, relationships, and account ownership.", metrics: [["Active companies", "286", "18 with open deals"], ["Pipeline coverage", "$361k", "Across 46 deals"], ["Without owner", "03", "Needs assignment"]], columns: ["Company", "Open value", "Primary owner", "Health"], rows: [["Northstar Studio", "$84,200", "Ava Patel", "Healthy"], ["Ridgeway Homes", "$58,600", "Noah Williams", "Watch"], ["Lumen Dental", "$31,500", "Ethan Kim", "At risk"]] },
  Conversations: { eyebrow: "Engagement workspace", title: "Conversations", description: "Keep inbound messages, follow-ups, and ownership in one place.", metrics: [["Open threads", "36", "7 awaiting reply"], ["First response", "8m 42s", "Within SLA"], ["Channels", "04", "Email, SMS, WhatsApp"]], columns: ["Conversation", "Channel", "Owner", "Status"], rows: [["Northstar Studio · New enquiry", "Website form", "Ava Patel", "Open"], ["Ridgeway Homes · Proposal", "WhatsApp Sandbox", "Noah Williams", "Waiting"], ["Lumen Dental · Onboarding", "Email", "Ethan Kim", "Follow-up"]] },
  "Recovery Queue": { eyebrow: "Lead safety", title: "Recovery Queue", description: "Intervene on leads that have missed the configured ownership or activity rules.", metrics: [["Needs recovery", "04", "2 critical"], ["Escalated today", "02", "1 reassigned"], ["Recovered this week", "18", "96% kept active"]], columns: ["Reason", "Lead", "Current owner", "Next action"], rows: [["Unacknowledged — deadline exceeded", "Maya Chen", "Ava Patel", "Reassign"], ["Escalated 2 times", "Jon Bell", "Noah Williams", "Review"], ["No recorded activity", "Lumen Dental", "Ethan Kim", "Contact"]] },
  Appointments: { eyebrow: "Operations workspace", title: "Appointments", description: "Coordinate customer meetings and keep follow-up tied to the record.", metrics: [["Today", "08", "3 require prep"], ["This week", "32", "6 with open deals"], ["Unconfirmed", "02", "Needs follow-up"]], columns: ["Time", "Appointment", "Customer", "Owner"], rows: [["10:30 AM", "Discovery call", "Northstar Studio", "Ava Patel"], ["01:00 PM", "Proposal review", "Ridgeway Homes", "Noah Williams"], ["03:45 PM", "Onboarding", "Lumen Dental", "Ethan Kim"]] },
  Payments: { eyebrow: "Revenue operations", title: "Payments", description: "Track received payments and connect financial activity to customer records.", metrics: [["This month", "$28.4k", "9.2% above last month"], ["Pending", "$12.8k", "6 payment requests"], ["Successful", "94%", "Stripe test mode"]], columns: ["Customer", "Amount", "Method", "Status"], rows: [["Northstar Studio", "$8,400", "Stripe test mode", "Received"], ["Ridgeway Homes", "$4,200", "Payment link", "Pending"], ["Lumen Dental", "$3,600", "Stripe test mode", "Received"]] },
  Team: { eyebrow: "Workspace administration", title: "Team", description: "Manage availability, routing readiness, roles, and accountable ownership.", metrics: [["Members", "12", "8 available now"], ["Available", "08", "Ready for assignment"], ["On a call", "03", "1 escalated owner"]], columns: ["Member", "Role", "Availability", "Active load"], rows: [["Ava Patel", "Sales lead", "Available", "2 active leads"], ["Noah Williams", "Account executive", "On a call", "4 active leads"], ["Ethan Kim", "Account executive", "Available", "1 active lead"]] },
  Integrations: { eyebrow: "Workspace administration", title: "Integrations", description: "Connect the services that power messaging, payments, calendars, and escalation alerts.", metrics: [["Connected", "03", "Sandbox/test connections"], ["Last sync", "12m ago", "No failed jobs"], ["Needs setup", "01", "Escalation provider"]], columns: ["Integration", "Purpose", "Environment", "Status"], rows: [["Stripe", "Payments", "Test mode", "Connected"], ["Google Calendar", "Appointments", "OAuth 2.0", "Connected"], ["Twilio WhatsApp", "Messaging", "Sandbox", "Connected"]] },
  "Audit Log": { eyebrow: "Workspace administration", title: "Audit Log", description: "Trace ownership changes, permission updates, and operational events.", metrics: [["Events today", "124", "Across 12 users"], ["Ownership changes", "08", "3 escalations"], ["Permission updates", "02", "Reviewed"]], columns: ["Event", "Actor", "Record", "Time"], rows: [["Lead reassigned", "Alex Morgan", "Lumen Dental", "18 min ago"], ["Pipeline stage changed", "Ava Patel", "Northstar Studio", "42 min ago"], ["Permission updated", "Alex Morgan", "Noah Williams", "1 hr ago"]] },
  Settings: { eyebrow: "Workspace administration", title: "Settings", description: "Configure workspace rules, permissions, pipelines, and acknowledgement policies.", metrics: [["Workspace role", "Owner", "Full access"], ["Active rules", "14", "3 need review"], ["Pipeline stages", "04", "Fully configurable"]], columns: ["Setting", "Current value", "Last changed", "Owner"], rows: [["Acknowledgement window", "15 minutes", "Today", "Alex Morgan"], ["Escalation destination", "Transactional email", "Yesterday", "Alex Morgan"], ["Default pipeline", "Sales pipeline", "Oct 12", "Alex Morgan"]] },
};

function PaymentsView() {
  const [role] = useDemoRole(); const canSeeValue = role !== "User";
  return <section className="module-page"><ModuleHeader eyebrow="Revenue operations" title="Payments" description="Track collected revenue, pending requests, and payment activity by customer." action="Request payment" /><div className="finance-summary"><div className="finance-card collected"><span>Collected revenue</span><strong>{canSeeValue ? "$28,400" : "••••"}</strong><small>Confirmed paid minus refunds · 9.2% above last month</small></div><div className="finance-card projected"><span>Projected / unpaid</span><strong>{canSeeValue ? "$12,800" : "••••"}</strong><small>6 requests still awaiting completion</small></div><div className="finance-card"><span>Success rate</span><strong>94%</strong><small>Stripe test mode · last 30 days</small></div></div><section className="panel module-table"><div className="module-table-heading"><div><h2>Recent payment activity</h2><p>Sandbox / Test data</p></div><button className="secondary-button"><Filter size={15} /> Filter</button></div><div className="module-table-head payment-grid"><span>Customer</span><span>Amount</span><span>Status</span><span>Stripe reference</span><span>Created</span></div>{[["Northstar Studio", "$8,400", "Paid", "pi_test_••••91a", "2 min ago"],["Ridgeway Homes", "$4,200", "Pending", "plink_test_••••7c", "18 min ago"],["Lumen Dental", "$3,600", "Paid", "pi_test_••••42f", "1 hr ago"],["Peak Fitness", "$2,200", "Refunded", "pi_test_••••b19", "Yesterday"]].map(row => <div className="module-table-row payment-grid" key={row[0]}><strong>{row[0]}</strong><span>{canSeeValue ? row[1] : "••••"}</span><span className={cn("module-status", `payment-${row[2].toLowerCase()}`)}>{row[2]}</span><span>{row[3]}</span><span>{row[4]}</span></div>)}</section></section>;
}

function AppointmentsView() {
  return <section className="module-page"><ModuleHeader eyebrow="Operations workspace" title="Appointments" description="Coordinate meetings with availability, time zones, and customer context." action="Book appointment" /><div className="appointment-layout"><section className="panel week-calendar"><div className="calendar-head"><div><h2>This week</h2><span>Viewer timezone: America/New_York</span></div><div className="calendar-actions"><button>‹</button><button>Today</button><button>›</button></div></div><div className="week-grid">{["Mon 18", "Tue 19", "Wed 20", "Thu 21", "Fri 22"].map((day, index) => <div className={cn("week-day", index === 0 && "today")} key={day}><strong>{day}</strong><div className="day-slots"><span className={index === 0 ? "booked" : ""}>{index === 0 ? "10:30 Discovery" : "09:00"}</span><span>{index === 0 ? "01:00 Proposal" : "11:30"}</span><span>{index === 0 ? "03:45 Onboarding" : "14:00"}</span></div></div>)}</div></section><section className="panel upcoming-panel"><div className="section-heading compact"><div><h2>Upcoming</h2><p>Next 5 appointments</p></div><CalendarDays size={17} /></div>{["10:30 AM · Discovery call · Northstar Studio", "01:00 PM · Proposal review · Ridgeway Homes", "03:45 PM · Onboarding · Lumen Dental"].map(item => <div className="appointment-item" key={item}><CalendarDays size={15} /><div><strong>{item}</strong><span>Today · America/New_York</span></div><ChevronRight size={15} /></div>)}</section></div></section>;
}

function ConversationsView() {
  const [selected, setSelected] = useState("Northstar Studio");
  return <section className="module-page"><ModuleHeader eyebrow="Engagement workspace" title="Conversations" description="Resolve inbound messages with ownership, delivery status, and context." action="New conversation" /><section className="panel inbox-layout"><div className="inbox-list"><div className="inbox-search"><Search size={14} /><input placeholder="Search conversations" /></div>{["Northstar Studio", "Ridgeway Homes", "Lumen Dental", "Peak Fitness"].map((item, index) => <button className={cn("inbox-item", selected === item && "selected")} key={item} onClick={() => setSelected(item)}><span className="inbox-channel">{index % 2 ? "W" : "✦"}</span><span><strong>{item}</strong><small>{index === 0 ? "New enquiry received" : "Follow-up awaiting reply"}</small></span><em>{index + 1}</em></button>)}</div><div className="message-thread"><div className="thread-head"><div><strong>{selected}</strong><span>WhatsApp Sandbox · Ava Patel</span></div><span className="module-status">Open</span></div><div className="messages"><div className="message incoming">Hi, we would like to understand the onboarding timeline.<small>10:28 AM · Delivered</small></div><div className="message outgoing">Thanks Maya — I can walk you through the next steps.<small>10:29 AM · Delivered</small></div><div className="message incoming">That would be helpful. Is Tuesday available?<small>10:30 AM · Delivered</small></div></div><div className="composer"><input aria-label="Message" placeholder="Write a reply…" /><button>Send</button></div></div><aside className="contact-panel"><Avatar initials="MC" tone="coral" /><h3>Maya Chen</h3><p>Northstar Studio</p><div className="contact-facts"><span>Email<strong>maya@northstar.example</strong></span><span>Owner<strong>Ava Patel</strong></span><span>Lead state<strong className="text-safe">SAFE</strong></span></div></aside></section></section>;
}

function TeamView() {
  return <section className="module-page"><ModuleHeader eyebrow="Workspace administration" title="Team" description="See who can take the next lead and how much work each person can safely carry." action="Invite member" /><div className="team-cards">{team.map((member, index) => <article className="panel team-card" key={member.name}><div className="team-card-head"><Avatar initials={member.name.split(" ").map(part => part[0]).join("")} tone={index === 1 ? "violet" : "blue"} /><span className={cn("team-state", member.status.toLowerCase().replace(" ", "-"))}><i />{member.status}</span></div><h2>{member.name}</h2><p>{member.role}</p><div className="load-label"><span>Open-lead load</span><strong>{member.openLeads} / {member.limit}</strong></div><div className="load-bar"><i style={{ width: `${(member.openLeads / member.limit) * 100}%` }} /></div><div className="team-card-foot"><span>Calendar <b>Connected</b></span><span>Alerts <b>Telegram</b></span></div></article>)}</div></section>;
}

function IntegrationsView() {
  return <section className="module-page"><ModuleHeader eyebrow="Workspace administration" title="Integrations" description="Connect messaging, payments, calendars, and escalation alerts." action="Connect integration" /><div className="integration-cards">{[["Twilio WhatsApp", "Messaging", "Connected", "Sandbox only"], ["Stripe", "Payments", "Connected", "Test mode"], ["Google Calendar", "Calendar", "Connected", "OAuth 2.0"], ["Telegram", "Notifications", "Not connected", "Escalation alerts"]].map(item => <article className="panel integration-card" key={item[0]}><div className="integration-icon"><Zap size={18} /></div><div className="integration-copy"><h2>{item[0]}</h2><p>{item[1]} · {item[3]}</p><span className={cn("integration-status", item[2] === "Connected" ? "connected" : "not-connected")}><i />{item[2]}</span></div><button className="secondary-button">{item[2] === "Connected" ? "Manage" : "Connect"}</button></article>)}</div><section className="panel sync-panel"><div className="module-table-heading"><div><h2>Synchronization history</h2><p>Secrets are masked everywhere · Sandbox / Test data</p></div><button className="secondary-button"><Filter size={15} /> Filter</button></div>{[["Inbound webhook", "Stripe", "Success", "evt_test_••••4f2a"], ["Outbound call", "Twilio WhatsApp", "Retrying", "msg_test_••••ab2"], ["Inbound webhook", "Stripe", "Rejected", "Signature verification failed"]].map(row => <div className="sync-row" key={row.join("-")}><span>{row[0]}</span><strong>{row[1]}</strong><span className={row[2] === "Rejected" ? "sync-failed" : "sync-success"}>{row[2]}</span><small>{row[3]}</small></div>)}</section></section>;
}

function SettingsView() {
  const [tab, setTab] = useState("Lead rules");
  return <section className="module-page"><ModuleHeader eyebrow="Workspace administration" title="Settings" description="Configure the rules that keep ownership, routing, and permissions accountable." action="Save changes" /><section className="settings-layout panel"><aside className="settings-tabs">{["Lead rules", "Fields", "Pipelines", "Team & permissions"].map(item => <button className={tab === item ? "selected" : ""} key={item} onClick={() => setTab(item)}>{item}<ChevronRight size={14} /></button>)}</aside><div className="settings-content"><p className="eyebrow"><span className="eyebrow-dot" /> Configuration</p><h2>{tab}</h2>{tab === "Lead rules" ? <div className="settings-form"><label>Maximum open leads per employee<input defaultValue="8" type="number" /></label><label>Acknowledgement window (seconds)<input defaultValue="30" type="number" /></label><label className="toggle-row"><span>Round-robin among available employees</span><input type="checkbox" defaultChecked /></label><div className="escalation-chain"><strong>Escalation chain</strong><span>L1 · Next eligible employee</span><span>L2 · Backup employee</span><span>L3 · Manager</span></div></div> : <div className="settings-empty"><Settings2 size={22} /><strong>{tab} configuration</strong><span>Changes are saved to this workspace and reflected immediately in forms and detail views.</span></div>}</div></section></section>;
}

function ModuleHeader({ eyebrow, title, description, action }: { eyebrow: string; title: string; description: string; action: string }) {
  return <div className="page-heading"><div><p className="eyebrow"><span className="eyebrow-dot" /> {eyebrow}</p><h1>{title}</h1><p className="subheading">{description}</p></div><div className="heading-actions"><button className="secondary-button"><Filter size={16} /> Filter</button><button className="primary-button"><Plus size={17} /> {action}</button></div></div>;
}

function ModuleView({ module }: { module: string }) {
  if (module === "Payments") return <PaymentsView />;
  if (module === "Appointments") return <AppointmentsView />;
  if (module === "Conversations") return <ConversationsView />;
  if (module === "Team") return <TeamView />;
  if (module === "Integrations") return <IntegrationsView />;
  if (module === "Settings") return <SettingsView />;
  const content = moduleContent[module] ?? moduleContent.Leads;
  const isAudit = module === "Audit Log";
  const [role] = useDemoRole();
  const canSeeValue = role !== "User";
  return <section className="module-page"><div className="page-heading"><div><p className="eyebrow"><span className="eyebrow-dot" /> {content.eyebrow}</p><h1>{content.title}</h1><p className="subheading">{content.description}</p></div><div className="heading-actions"><button className="secondary-button"><Filter size={16} /> Filter</button>{!isAudit && <button className="primary-button"><Plus size={17} /> Add {module === "Team" ? "member" : module === "Settings" ? "rule" : "record"}</button>}</div></div><div className="module-metrics">{content.metrics.map(metric => <div className="module-metric panel" key={metric[0]}><span>{metric[0]}</span><strong>{role === "User" && (metric[0].includes("value") || metric[0].includes("month") || metric[0].includes("revenue")) ? "••••" : metric[1]}</strong><small>{metric[2]}</small></div>)}</div><section className="panel module-table"><div className="module-table-heading"><div><h2>{content.title} workspace</h2><p>{isAudit ? "Read-only event history for workspace accountability." : "Sandbox / Test data"}</p></div><button className="icon-button subtle" aria-label="More workspace options"><MoreHorizontal size={17} /></button></div><div className="module-table-head">{content.columns.map(column => <span key={column}>{column}</span>)}</div>{content.rows.map(row => <div className="module-table-row" key={row.join("-")}>{row.map((cell, index) => index === 0 ? <strong key={cell}>{cell}</strong> : <span key={cell} className={index === row.length - 1 ? "module-status" : ""}>{!canSeeValue && (cell.includes("$") || module === "Payments") ? "••••" : cell}</span>)}</div>)}</section><div className="module-footnote"><ShieldCheck size={15} /> {isAudit ? "Audit history cannot be edited." : "Sandbox / Test data"}</div></section>;
}

export default function Home() {
  const [location] = useLocation();
  const { user, setUser, can } = useSession();
  const initialModule = location.startsWith("/pipeline") ? "Pipeline" : location.startsWith("/leads") ? "Leads" : location.startsWith("/contacts") ? "Contacts" : location.startsWith("/companies") ? "Companies" : location.startsWith("/conversations") ? "Conversations" : location.startsWith("/recovery") ? "Recovery Queue" : location.startsWith("/appointments") ? "Appointments" : location.startsWith("/payments") ? "Payments" : location.startsWith("/team") ? "Team" : location.startsWith("/integrations") ? "Integrations" : location.startsWith("/audit") ? "Audit Log" : location.startsWith("/settings") ? "Settings" : "Dashboard";
  const [activeNav, setActiveNav] = useState(initialModule);
  const [params, setParams] = useState<NavParams>(initialModule === "Recovery Queue" ? { tab: "recovery" } : {});
  const [sidebarOpen, setSidebarOpen] = useState(false);
  if (!user) return null;

  // Opening a module (from the sidebar, the quick-find palette or a link inside a page) always starts with a fresh page.
  const go = (target: string, next: NavParams = {}) => { setActiveNav(moduleOfId[target] ?? target); setParams(target === "Recovery Queue" ? { tab: "recovery", ...next } : next); setSidebarOpen(false); window.scrollTo({ top: 0 }); };

  // An alert email links to /dashboard?lead=<id>: once signed in, open that lead and tidy the address bar.
  useEffect(() => { const id = new URLSearchParams(window.location.search).get("lead"); if (!id) return; go("Leads", { open: id }); window.history.replaceState({}, "", window.location.pathname); }, []);

  const changeAvailability = async (next: Availability) => {
    try { await setMyAvailability(next); setUser({ ...user, availability: next }); notify.ok("You are now " + availabilityLabel[next], next === "on_leave" || next === "offline" ? "New leads won’t be assigned to you while you’re away." : undefined); }
    catch (error) { notify.fail("Could not change your status", error); }
  };

  // Hiding an entry is only a convenience: the server still refuses what the role cannot do.
  const allowed = (item: { needs?: Permission; adminOnly?: boolean }) => (!item.needs || can(item.needs)) && (!item.adminOnly || user.baseLevel !== "user");
  const visibleNav = navItems.filter(allowed);
  const counts = useAsync(() => Promise.all([listLeads({ scope: "mine", pageSize: 1 }), listLeads({ scope: "recovery", pageSize: 1 }).catch(() => ({ total: 0 }))]), [activeNav]);
  const badge = (label: string) => label === "Leads" ? counts.data?.[0].total : label === "Recovery Queue" ? counts.data?.[1].total : undefined;

  return <div className="app-shell"><aside className={cn("sidebar", sidebarOpen && "sidebar-open")}><div className="brand-row"><div className="brand-mark"><span /><span /><span /></div><div className="brand-copy"><strong>LeadSafe</strong><small>Operations workspace</small></div><button className="icon-button sidebar-close" aria-label="Close navigation" onClick={() => setSidebarOpen(false)}><X size={18} /></button></div><div className="workspace-switcher"><span className="workspace-avatar">{user.workspaceName.slice(0, 2).toUpperCase()}</span><span className="workspace-text"><strong>{user.workspaceName}</strong><small>Operations workspace</small></span></div><nav className="side-nav" aria-label="Main navigation">{[...new Set(visibleNav.map(item => item.section))].map(section => <div className="nav-section" key={section}><p className="nav-label">{section}</p>{visibleNav.filter(item => item.section === section).map(item => { const Icon = item.icon; const count = badge(item.label); return <button key={item.label} className={cn("nav-item", activeNav === item.label && "nav-item-active", item.urgent && "nav-item-urgent")} onClick={() => go(item.label)}><Icon size={17} /><span>{item.label}</span>{count ? <span className={cn("nav-badge", item.urgent && "nav-badge-urgent")}>{count}</span> : null}</button>; })}</div>)}</nav><div className="sidebar-footer"><div className="user-row"><Avatar initials={user.initials} tone="coral" /><div><strong>{user.name}</strong><small>{levelLabel[user.baseLevel]}</small></div></div></div></aside><main className="main-content"><TopBar activeNav={activeNav} availability={user.availability} setAvailability={changeAvailability} onMenu={() => setSidebarOpen(true)} onGo={go} /><div className="content-wrap"><NavProvider value={{ go, params }}><LivePage key={activeNav + JSON.stringify(params)} module={activeNav} /></NavProvider><footer className="app-footer"><span><span className="footer-pulse" /> {user.workspaceName}</span><span>Signed in as {user.email}</span></footer></div></main>{sidebarOpen && <div className="mobile-overlay" onClick={() => setSidebarOpen(false)} />}</div>;
}
