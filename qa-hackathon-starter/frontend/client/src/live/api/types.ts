// Shapes returned by the core backend (see docs/API_CONTRACT.md in the repository). The UI works with
// these directly: there is no second "UI model" to keep in sync, so a contract change shows up as a type error.
export type ApiErrorBody = { error: { code: string; message: string; details?: Record<string, unknown> } }

export type BaseLevel = 'owner' | 'admin' | 'user'
export type Availability = 'available' | 'busy' | 'on_leave' | 'offline'
export type Permission = 'crmView' | 'crmCreate' | 'crmEdit' | 'crmDelete' | 'crmExport' | 'manageAssignmentRules' | 'manageIntegrations' | 'viewAuditLog' | 'viewOpportunityValue'

export type User = { id: string; name: string; email: string; initials: string; workspaceName: string; baseLevel: BaseLevel; availability: Availability; permissions: Permission[] }
export type Member = { id: string; name: string; email: string; baseLevel: BaseLevel; availability: Availability; permissions?: Permission[] }
export type Invitation = { id: string; email: string; baseLevel: BaseLevel; expiresAt: string; token: string }

export type Page<T> = { items: T[]; page: number; pageSize: number; total: number }

export type LeadSource = 'web_form' | 'message' | 'manual'
export type LeadStatus = 'needs_acknowledgement' | 'escalated' | 'acknowledged' | 'closed'
export type Lead = {
  id: string; contactId: string; contact: string; company: string | null; source: LeadSource; message: string | null
  ownerId: string; owner: string; assignedAt: string; firstAssignedAt: string; deadlineAt: string | null; secondsRemaining: number | null
  acknowledgedAt: string | null; firstResponseAt: string | null; closedAt: string | null; escalationCount: number; level: number
  status: LeadStatus; handoverRequired: boolean; attentionReason: string | null; recoveryReasons: string[]; lastActionAt: string; version: number; createdAt: string
}
export type LeadDetail = Lead & { history: { fromUserId: string | null; from: string | null; toUserId: string; to: string; reason: string; at: string }[] }
export type RoutingRules = { ackWindowSeconds: number; maxOpenLeads: number; escalationLevels: number; idleSeconds: number; levelWindowSeconds: number[]; backupUserId: string | null; managerUserId: string | null; strategy: string }

export type CustomFieldType = 'text' | 'number' | 'date' | 'dropdown' | 'checkbox'
export type EntityType = 'contact' | 'company' | 'opportunity'
export type CustomFieldDef = { id: string; entityType: EntityType; pipelineId: string | null; name: string; fieldType: CustomFieldType; options: string[]; position: number }
export type CustomFieldValue = { id: string; name: string; type: CustomFieldType; options?: string[]; value: string | number | boolean | null }

export type ContactRow = { id: string; name: string; email: string | null; phone: string | null; optedOut: boolean; tags: string[]; companyId: string | null; company: string | null; ownerId: string | null; owner: string | null; lastActivity: string | null; version: number; createdAt: string; updatedAt: string }
export type Activity = { id: string; type: string; text: string; opportunityId?: string | null; actor: string; at: string }
export type ContactView = {
  contact: { id: string; name: string; email: string | null; phone: string | null; optedOut: boolean; tags: string[]; company: { id: string; name: string } | null; ownerId: string | null; owner: string | null; version: number; createdAt: string; updatedAt: string; customFields: CustomFieldValue[] }
  opportunities: { id: string; name: string; value: number | null; valueHidden: boolean; currency: string; stage: string; stageKind: string; pipeline: string; version: number; updatedAt: string }[]
  conversations: { id: string; channel: string; lastMessageAt: string; unread: number; messages: { id: string; direction: 'inbound' | 'outbound'; body: string; status: string; failureReason: string | null; at: string }[] }[]
  payments: { id: string; opportunityId: string; amount: number; currency: string; status: string; refunded: number; providerReference: string | null; requestedBy: string | null; createdAt: string }[]
  appointments: { id: string; title: string; startsAt: string; endsAt: string; timezone: string; status: string; userId: string }[]
  activities: Activity[]
  leads: { id: string; source: LeadSource; ownerId: string; acknowledgedAt: string | null; closedAt: string | null; escalationCount: number }[]
}
export type CompanyRow = { id: string; name: string; contacts: number; version: number; createdAt: string }
export type CompanyView = { id: string; name: string; version: number; createdAt: string; customFields: CustomFieldValue[]; contacts: { id: string; name: string; email: string | null; phone: string | null }[] }

export type OpportunityRow = {
  id: string; name: string; value: number | null; valueHidden: boolean; currency: string; stageId: string; stage: string; stageKind: 'open' | 'won' | 'lost'
  pipelineId: string; pipeline: string; contactId: string; contact: string; company: string | null; ownerId: string | null; owner: string | null; version: number; createdAt: string; updatedAt: string
}
export type OpportunityView = {
  opportunity: { id: string; name: string; value: number | null; valueHidden: boolean; currency: string; ownerId: string | null; stageId: string; version: number; createdAt: string; updatedAt: string; contact: { id: string; name: string; company: string | null }; pipeline: { id: string; name: string }; customFields: CustomFieldValue[] }
  stages: { id: string; name: string; kind: string; position: number; requiredFieldIds: string[] }[]
  payments: ContactView['payments']; appointments: ContactView['appointments']; activities: Activity[]
}

export type Stage = { id: string; name: string; position: number; kind: 'open' | 'won' | 'lost'; opportunities: number; requiredFieldIds: string[] }
export type Pipeline = { id: string; name: string; stages: Stage[] }
export type Criteria = { q?: string; pipelineId?: string; stageId?: string; ownerId?: string; companyId?: string; tag?: string; createdFrom?: string; createdTo?: string; customFields?: Record<string, string> }
export type SavedFilter = { id: string; entity: 'contact' | 'opportunity'; name: string; criteria: Criteria; createdBy: string; createdAt: string }

export type AuditEvent = { id: string; time: string; actorId: string | null; actor: string; type: string; targetType: string; targetId: string | null; before: unknown; after: unknown }

export type DashboardSummary = {
  scope: 'company' | 'personal'; scopeLabel: string; timezone: string; generatedAt: string; hidden: string[]
  metrics: {
    newLeads: { value: number; since: string; drilldown: string }
    openPipeline: { byStage: { stageId: string; stage: string; pipeline: string; count: number; amount: number | null }[]; total: number | null; valueHidden: boolean }
    responseTime: { averageSeconds: number | null; sampleSize: number }
    recovery: { value: number; drilldown: string }
    escalations: { value: number; since: string; drilldown: string }
    availability: { available: number; busy: number; on_leave: number; offline: number; total: number }
    appointments: { count: number; items: { id: string; title: string; contact: string; startsAt: string; endsAt: string; timezone: string }[] }
    payments: { collected: { currency: string; amount: number }[]; since: string }
  }
  definitions: Record<string, string>
}

export type WidgetId = 'newLeads' | 'openPipeline' | 'responseTime' | 'recovery' | 'escalations' | 'availability' | 'appointments' | 'payments'

// ----- Calendar, appointments, integrations (the integration branch routes) -----
export type CalendarState = 'connected' | 'needs_reconnection' | 'not_connected'
export type CalendarStatus = { state: CalendarState; lastError: string | null; lastSuccessAt: string | null; account: string | null; serverConfigured: boolean; employees?: { userId: string; name: string; state: CalendarState; lastError: string | null }[] }
export type Appointment = {
  id: string; title: string; contactId: string; contact: string; opportunityId: string | null; userId: string; employee: string
  startsAt: string; endsAt: string; timezone: string; displayTimezone: string; startsAtLocal: string; endsAtLocal: string
  status: 'confirmed' | 'cancelled'; synced: boolean; createdAt: string
}
export type IntegrationItem = {
  id: string; name: string; purpose: string; status: 'connected' | 'error' | 'not_connected' | 'needs_reconnection'
  lastSuccessAt: string | null; lastError: string | null; recentErrors: { at: string; type: string; result: string; detail: string | null }[]
  details: Record<string, unknown>; limits: string
}
export type SyncEvent = { id: string; provider: string; direction: 'inbound' | 'outbound'; type: string; reference: string | null; result: 'ok' | 'error' | 'rejected' | 'duplicate'; detail: string | null; at: string }
export type ResendSetup = { status: string; webhookUrl: string | null; signingSecret: string | null; apiKey: string | null; fromEmail: string | null; inboundAddress: string | null; lastSuccessAt: string | null; lastError: string | null }
