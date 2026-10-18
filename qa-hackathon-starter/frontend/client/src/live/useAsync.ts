import { useCallback, useEffect, useRef, useState } from 'react'
import { ApiError } from './api/client'

// Loads data and exposes loading / error / reload. A slow earlier request can never overwrite a newer one.
export function useAsync<T>(load: () => Promise<T>, deps: unknown[]) {
  const [data, setData] = useState<T>()
  const [error, setError] = useState<ApiError>()
  const [loading, setLoading] = useState(true)
  const run = useRef(0)
  const loadRef = useRef(load)
  loadRef.current = load

  const reload = useCallback(() => {
    const id = ++run.current
    setLoading(true)
    loadRef.current()
      .then(result => { if (id === run.current) { setData(result); setError(undefined) } })
      .catch((err: unknown) => { if (id === run.current) setError(err instanceof ApiError ? err : new ApiError(0, 'UNKNOWN_ERROR', err instanceof Error ? err.message : 'Something went wrong.')) })
      .finally(() => { if (id === run.current) setLoading(false) })
  }, [])

  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { reload() }, deps)
  return { data, error, loading, reload, setData }
}

// Runs an action with a busy flag; the caller shows success/failure toasts (Q10).
export function useAction() {
  const [busy, setBusy] = useState(false)
  const run = useCallback(async <R,>(fn: () => Promise<R>): Promise<R | undefined> => {
    setBusy(true)
    try { return await fn() } finally { setBusy(false) }
  }, [])
  return { busy, run }
}
