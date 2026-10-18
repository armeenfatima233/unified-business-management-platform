import type { ComponentType } from 'react'
import '../live.css'
import { AuditView } from './Audit'
import { ContactsView } from './Contacts'
import { DashboardView } from './Dashboard'
import { LeadsView } from './Leads'
import { CalendarView, InboxView, IntegrationsView, PaymentsView } from './Placeholders'
import { PipelineView } from './Pipeline'
import { SettingsView } from './Settings'
import { TeamView } from './Team'

// Sidebar label (the original design's names) -> the page that shows real data for it.
const pages: Record<string, ComponentType> = {
  Dashboard: DashboardView, Leads: LeadsView, 'Recovery Queue': LeadsView, Pipeline: PipelineView, Contacts: ContactsView, Companies: ContactsView,
  Conversations: InboxView, Payments: PaymentsView, Appointments: CalendarView, Team: TeamView, Integrations: IntegrationsView, 'Audit Log': AuditView, Settings: SettingsView,
}
// The page components use short ids when they navigate (go('leads')); the shell uses the sidebar labels.
export const moduleOfId: Record<string, string> = {
  dashboard: 'Dashboard', leads: 'Leads', contacts: 'Contacts', pipeline: 'Pipeline', inbox: 'Conversations', payments: 'Payments',
  calendar: 'Appointments', team: 'Team', integrations: 'Integrations', audit: 'Audit Log', settings: 'Settings',
}

export function LivePage({ module }: { module: string }) {
  const Page = pages[module] ?? DashboardView
  return <div className="lvx"><Page /></div>
}
