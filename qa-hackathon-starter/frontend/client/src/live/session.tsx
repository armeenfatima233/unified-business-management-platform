import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { toast } from 'sonner'
import { UNAUTHENTICATED_EVENT } from './api/client'
import { getCurrentUser, logout } from './api/auth'
import { connectRealtime, type RealtimeEvent } from './api/realtime'
import type { Permission, User } from './api/types'

// One place that knows who is signed in, which permissions they have, and when something changed on the server.
type SessionValue = {
  user: User | null
  loading: boolean
  setUser: (user: User | null) => void
  signOut: () => Promise<void>
  can: (permission: Permission) => boolean
  liveTick: number // increases whenever the server pushes an event; screens refetch when it changes
  liveEvents: RealtimeEvent[]
}
const SessionContext = createContext<SessionValue | null>(null)

export function SessionProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null)
  const [loading, setLoading] = useState(true)
  const [liveTick, setLiveTick] = useState(0)
  const [liveEvents, setLiveEvents] = useState<RealtimeEvent[]>([])
  const userRef = useRef<User | null>(null)
  userRef.current = user

  // Restore the session after a page refresh (F1.1).
  useEffect(() => { getCurrentUser().then(setUser).catch(() => setUser(null)).finally(() => setLoading(false)) }, [])

  // A session that ends while the app is open sends the person back to sign in, with an explanation.
  useEffect(() => {
    const onExpired = () => { if (userRef.current) { setUser(null); toast.warning('You were signed out', { description: 'Your session ended. Sign in again to continue.' }) } }
    window.addEventListener(UNAUTHENTICATED_EVENT, onExpired)
    return () => window.removeEventListener(UNAUTHENTICATED_EVENT, onExpired)
  }, [])

  // Live updates (Q11): new leads, escalations and messages appear without a refresh.
  useEffect(() => {
    if (!user) return
    return connectRealtime(event => {
      setLiveEvents(current => [event, ...current].slice(0, 8))
      setLiveTick(tick => tick + 1)
      const show = event.tone === 'warning' ? toast.warning : event.tone === 'success' ? toast.success : toast.info
      show(event.title, { description: event.detail })
    })
  }, [user?.id])

  const signOut = useCallback(async () => { try { await logout() } catch { /* the server clears the cookie */ } setUser(null) }, [])
  const can = useCallback((permission: Permission) => Boolean(userRef.current?.permissions.includes(permission)), [])
  const value = useMemo(() => ({ user, loading, setUser, signOut, can, liveTick, liveEvents }), [user, loading, signOut, can, liveTick, liveEvents])
  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>
}

export function useSession() {
  const ctx = useContext(SessionContext)
  if (!ctx) throw new Error('useSession must be used inside SessionProvider')
  return ctx
}

// Navigation between the workspace modules. Home owns which module is open; pages ask it to switch and can pass
// drill-down filters (for example "leads created today") that the target page reads.
export type NavParams = Record<string, string | undefined>
type NavValue = { go: (module: string, params?: NavParams) => void; params: NavParams }
const NavContext = createContext<NavValue>({ go: () => undefined, params: {} })
export const NavProvider = NavContext.Provider
export const useNav = () => useContext(NavContext)

export const notify = {
  ok: (title: string, description?: string) => toast.success(title, { description }),
  info: (title: string, description?: string) => toast.info(title, { description }),
  fail: (title: string, error?: unknown) => toast.error(title, { description: error instanceof Error ? error.message : undefined }),
}
