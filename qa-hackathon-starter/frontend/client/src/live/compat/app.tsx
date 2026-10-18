import { notify, useNav, useSession } from '../session'

// The page components were written against one "app" object; this builds it from the session and navigation of the shell.
export type ViewParams = Record<string, string | undefined>
type ToastInput = { title: string; detail?: string; tone: 'success' | 'error' | 'info' | 'warning' }

export function useApp() {
  const session = useSession()
  const nav = useNav()
  const pushToast = ({ title, detail, tone }: ToastInput) => {
    if (tone === 'error') notify.fail(title, detail ? new Error(detail) : undefined)
    else if (tone === 'success') notify.ok(title, detail)
    else notify.info(title, detail)
  }
  return { ...session, user: session.user!, params: nav.params, go: nav.go, pushToast }
}
