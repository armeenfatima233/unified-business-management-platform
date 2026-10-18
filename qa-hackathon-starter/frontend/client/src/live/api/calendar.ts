import { apiFetch, json, qs } from './client'
import type { Appointment, CalendarStatus, Page } from './types'

export type AppointmentQuery = { from?: string; to?: string; userId?: string; contactId?: string; status?: string; timezone?: string; page?: number; pageSize?: number }
export type BookingInput = { contactId: string; opportunityId?: string | null; userId?: string; title: string; description?: string; startsAt: string; durationMinutes: number; timezone: string }

export const listAppointments = (q: AppointmentQuery) => apiFetch<Page<Appointment>>(`/appointments${qs({ ...q })}`)
export const bookAppointment = (body: BookingInput) => apiFetch<Appointment>('/appointments', { method: 'POST', ...json(body) })
export const rescheduleAppointment = (id: string, body: { startsAt?: string; durationMinutes?: number; timezone?: string }) => apiFetch<Appointment>(`/appointments/${id}`, { method: 'PATCH', ...json(body) })
export const cancelAppointment = (id: string) => apiFetch<Appointment>(`/appointments/${id}`, { method: 'DELETE' })

export const getCalendarStatus = () => apiFetch<CalendarStatus>('/integrations/google/calendar/status')
export const startCalendarConnect = () => apiFetch<{ authorizationUrl: string }>('/integrations/google/calendar/oauth/start')
export const disconnectCalendar = () => apiFetch<void>('/integrations/google/calendar', { method: 'DELETE' })
export const getBusy = (p: { userId?: string; from: string; to: string; timeZone: string }) => apiFetch<{ userId: string; timeZone: string; busy: { start: string; end: string }[] }>(`/integrations/google/calendar/busy${qs({ ...p })}`)
