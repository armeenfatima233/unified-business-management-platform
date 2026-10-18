import { API_BASE_URL } from './client'

export type RealtimeEvent = { type: 'newLead' | 'escalation' | 'incomingMessage' | 'leadUpdated' | 'paymentUpdated'; title: string; detail: string; tone?: 'info' | 'warning' | 'success' | 'error'; leadId?: string }

// Server-Sent Events (Q11): new leads, escalations and messages arrive without a page refresh. The
// browser reconnects by itself if the connection drops. Returns a function that closes the stream.
export function connectRealtime(onEvent: (event: RealtimeEvent) => void): () => void {
  const source = new EventSource(`${API_BASE_URL}/api/v1/events`, { withCredentials: true })
  source.onmessage = message => {
    try { onEvent(JSON.parse(message.data) as RealtimeEvent) } catch { /* ignore a malformed frame */ }
  }
  return () => source.close()
}
