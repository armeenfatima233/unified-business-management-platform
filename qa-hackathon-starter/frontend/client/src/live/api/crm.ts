import { apiFetch, json, qs } from './client'
import type {
  CompanyRow, CompanyView, ContactRow, ContactView, Criteria, CustomFieldDef, EntityType, OpportunityRow, OpportunityView, Page, Pipeline, SavedFilter,
} from './types'

type Paging = { page?: number; pageSize?: number }
const criteriaQuery = (c: Criteria) => ({
  q: c.q, pipelineId: c.pipelineId, stageId: c.stageId, ownerId: c.ownerId, companyId: c.companyId, tag: c.tag, createdFrom: c.createdFrom, createdTo: c.createdTo,
  cf: Object.entries(c.customFields ?? {}).map(([id, value]) => `${id}:${value}`),
})

// ----- Contacts -----
export const listContacts = (c: Criteria & Paging) => apiFetch<Page<ContactRow>>(`/contacts${qs({ ...criteriaQuery(c), page: c.page, pageSize: c.pageSize })}`)
export const getContact = (id: string) => apiFetch<ContactView>(`/contacts/${id}`)
export type ContactInput = { name: string; email?: string | null; phone?: string | null; companyId?: string | null; ownerId?: string | null; tags?: string[]; optOut?: boolean; customFields?: Record<string, unknown> }
export const createContact = (body: ContactInput) => apiFetch<ContactView>('/contacts', { method: 'POST', ...json(body) })
export const updateContact = (id: string, version: number, body: Partial<ContactInput>) => apiFetch<ContactView>(`/contacts/${id}`, { method: 'PATCH', ...json({ version, ...body }) })
export const deleteContact = (id: string) => apiFetch<void>(`/contacts/${id}`, { method: 'DELETE' })
export const addNote = (contactId: string, text: string) => apiFetch<{ contactId: string; text: string; createdAt: string }>(`/contacts/${contactId}/notes`, { method: 'POST', ...json({ text }) })

// ----- Companies -----
export const listCompanies = (p: Paging & { search?: string }) => apiFetch<Page<CompanyRow>>(`/companies${qs({ ...p })}`)
export const getCompany = (id: string) => apiFetch<CompanyView>(`/companies/${id}`)
export const createCompany = (name: string) => apiFetch<CompanyView>('/companies', { method: 'POST', ...json({ name }) })
export const renameCompany = (id: string, version: number, name: string) => apiFetch<CompanyView>(`/companies/${id}`, { method: 'PATCH', ...json({ version, name }) })
export const deleteCompany = (id: string) => apiFetch<void>(`/companies/${id}`, { method: 'DELETE' })

// ----- Opportunities -----
export const listOpportunities = (c: Criteria & Paging) => apiFetch<Page<OpportunityRow>>(`/opportunities${qs({ ...criteriaQuery(c), page: c.page, pageSize: c.pageSize })}`)
export const getOpportunity = (id: string) => apiFetch<OpportunityView>(`/opportunities/${id}`)
export type OpportunityInput = { contactId: string; pipelineId: string; stageId?: string; name: string; value?: number | null; currency?: string; ownerId?: string | null; customFields?: Record<string, unknown> }
export const createOpportunity = (body: OpportunityInput) => apiFetch<OpportunityView>('/opportunities', { method: 'POST', ...json(body) })
export const updateOpportunity = (id: string, version: number, body: { name?: string; value?: number | null; currency?: string; ownerId?: string | null; customFields?: Record<string, unknown> }) =>
  apiFetch<OpportunityView>(`/opportunities/${id}`, { method: 'PATCH', ...json({ version, ...body }) })
export const moveOpportunity = (id: string, stageId: string, customFields?: Record<string, unknown>) => apiFetch<OpportunityView>(`/opportunities/${id}/move`, { method: 'POST', ...json({ stageId, customFields }) })
export const deleteOpportunity = (id: string) => apiFetch<void>(`/opportunities/${id}`, { method: 'DELETE' })

// CSV downloads go through the browser so the session cookie is sent.
export const exportUrl = (entity: 'contacts' | 'opportunities', c: Criteria = {}) => `${import.meta.env.VITE_API_BASE_URL ?? 'http://localhost:8080'}/api/v1/${entity}/export.csv${qs(criteriaQuery(c))}`

// ----- Pipelines, stages, custom fields (Owner/Admin to change) -----
export const listPipelines = () => apiFetch<{ items: Pipeline[] }>('/pipelines').then(r => r.items)
export const createPipeline = (name: string) => apiFetch<Pipeline>('/pipelines', { method: 'POST', ...json({ name }) })
export const renamePipeline = (id: string, name: string) => apiFetch<Pipeline>(`/pipelines/${id}`, { method: 'PATCH', ...json({ name }) })
export const deletePipeline = (id: string) => apiFetch<void>(`/pipelines/${id}`, { method: 'DELETE' })
export const addStage = (pipelineId: string, name: string, kind: 'open' | 'won' | 'lost') => apiFetch<{ stages: Pipeline['stages'] }>(`/pipelines/${pipelineId}/stages`, { method: 'POST', ...json({ name, kind }) })
export const reorderStages = (pipelineId: string, stageIds: string[]) => apiFetch<{ stages: Pipeline['stages'] }>(`/pipelines/${pipelineId}/stages/order`, { method: 'PUT', ...json({ stageIds }) })
export const updateStage = (id: string, body: { name?: string; kind?: 'open' | 'won' | 'lost' }) => apiFetch<{ stages: Pipeline['stages'] }>(`/stages/${id}`, { method: 'PATCH', ...json(body) })
export const deleteStage = (id: string, moveTo?: string) => apiFetch<{ stages: Pipeline['stages'] }>(`/stages/${id}${qs({ moveTo })}`, { method: 'DELETE' })
export const setRequiredFields = (stageId: string, fieldIds: string[]) => apiFetch<{ stages: Pipeline['stages'] }>(`/stages/${stageId}/required-fields`, { method: 'PUT', ...json({ fieldIds }) })

export const listCustomFields = (entity?: EntityType, pipelineId?: string) => apiFetch<{ items: CustomFieldDef[] }>(`/custom-fields${qs({ entity, pipelineId })}`).then(r => r.items)
export const createCustomField = (body: { entityType: EntityType; pipelineId?: string | null; name: string; fieldType: CustomFieldDef['fieldType']; options?: string[] }) => apiFetch<CustomFieldDef>('/custom-fields', { method: 'POST', ...json(body) })
export const updateCustomField = (id: string, body: { name?: string; options?: string[] }) => apiFetch<CustomFieldDef>(`/custom-fields/${id}`, { method: 'PATCH', ...json(body) })
export const deleteCustomField = (id: string) => apiFetch<void>(`/custom-fields/${id}`, { method: 'DELETE' })

// ----- Saved lists -----
export const listSavedFilters = (entity?: 'contact' | 'opportunity') => apiFetch<{ items: SavedFilter[] }>(`/saved-filters${qs({ entity })}`).then(r => r.items)
export const createSavedFilter = (body: { entity: 'contact' | 'opportunity'; name: string; criteria: Criteria }) => apiFetch<SavedFilter>('/saved-filters', { method: 'POST', ...json(body) })
export const deleteSavedFilter = (id: string) => apiFetch<void>(`/saved-filters/${id}`, { method: 'DELETE' })
export const savedFilterResults = (id: string, p: Paging) => apiFetch<Page<ContactRow | OpportunityRow> & { entity: 'contact' | 'opportunity' }>(`/saved-filters/${id}/results${qs({ ...p })}`)
