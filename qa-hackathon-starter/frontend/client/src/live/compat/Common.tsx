import { useEffect, useRef, type ReactNode } from 'react'
import { AlertTriangle, Lock, PlugZap, X } from 'lucide-react'
import { ApiError } from '../api/client'
import { Button, Card, EmptyState } from './UI'

// Plain-language failure state with a retry. A 403 gets its own "no permission" wording (F1.5).
export function ErrorState({ error, retry }: { error: ApiError; retry?: () => void }) {
  if (error.status === 403) return <Card><EmptyState title="You don't have access to this" description="Your role doesn't include the permission this page needs. Ask an Owner or Admin if you think that's a mistake." action={<Lock size={18} />} /></Card>
  return <Card><EmptyState title="We couldn't load this" description={error.message} action={retry ? <Button variant="secondary" onClick={retry}>Try again</Button> : <AlertTriangle size={18} />} /></Card>
}

// Honest placeholder for areas served by the integrations module (messaging, payments, calendar).
export function NotConnected({ title, description }: { title: string; description: string }) {
  return <Card><EmptyState title={title} description={description} action={<PlugZap size={18} />} /></Card>
}

export function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return <label className="field"><span className="field-label">{label}</span>{children}{hint && <small className="field-hint">{hint}</small>}</label>
}

export function Pager({ page, pageSize, total, onPage, noun = 'results' }: { page: number; pageSize: number; total: number; onPage: (page: number) => void; noun?: string }) {
  const pages = Math.max(1, Math.ceil(total / pageSize))
  const from = total === 0 ? 0 : (page - 1) * pageSize + 1
  return <div className="pagination"><span>{total === 0 ? `No ${noun}` : `Showing ${from}–${Math.min(page * pageSize, total)} of ${total} ${noun}`}</span><div><Button size="sm" variant="secondary" disabled={page <= 1} onClick={() => onPage(page - 1)}>Previous</Button><Button size="sm" variant="secondary" disabled={page >= pages} onClick={() => onPage(page + 1)}>Next</Button></div></div>
}

// Accessible dialog: labelled, closes on Escape or backdrop click, returns focus to what opened it.
export function Modal({ title, onClose, children, wide = false }: { title: string; onClose: () => void; children: ReactNode; wide?: boolean }) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null
    ref.current?.querySelector<HTMLElement>('input, select, textarea, button')?.focus()
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose() }
    document.addEventListener('keydown', onKey)
    return () => { document.removeEventListener('keydown', onKey); previous?.focus() }
  }, [onClose])
  return <div className="modal-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) onClose() }}><div ref={ref} className={`modal ${wide ? 'modal-wide' : ''}`} role="dialog" aria-modal="true" aria-label={title}><div className="modal-head"><h3>{title}</h3><button className="more-button" aria-label="Close dialog" onClick={onClose}><X size={18} /></button></div>{children}</div></div>
}

export function ConfirmDialog({ title, message, confirmLabel = 'Confirm', danger = false, busy = false, onConfirm, onCancel }: { title: string; message: ReactNode; confirmLabel?: string; danger?: boolean; busy?: boolean; onConfirm: () => void; onCancel: () => void }) {
  return <Modal title={title} onClose={onCancel}><div className="modal-body"><p>{message}</p></div><div className="form-actions"><Button variant="secondary" onClick={onCancel}>Cancel</Button><Button variant={danger ? 'danger' : 'primary'} disabled={busy} onClick={onConfirm}>{busy ? 'Working…' : confirmLabel}</Button></div></Modal>
}

export function InlineError({ message }: { message?: string | null }) {
  return message ? <div className="inline-error" role="alert"><AlertTriangle size={14} />{message}</div> : null
}

export function Tabs<T extends string>({ value, onChange, items }: { value: T; onChange: (value: T) => void; items: { id: T; label: string; count?: number; alert?: boolean }[] }) {
  return <div className="tabs" role="tablist">{items.map(item => <button key={item.id} role="tab" aria-selected={value === item.id} className={value === item.id ? 'tab-active' : ''} onClick={() => onChange(item.id)}>{item.label}{item.count !== undefined && <span className={item.alert ? 'tab-alert' : ''}>{item.count}</span>}</button>)}</div>
}

// Select with separate value and label (UI.Select uses the text as the value).
export function OptionSelect({ label, value, onChange, options, placeholder }: { label?: string; value: string; onChange: (value: string) => void; options: { value: string; label: string }[]; placeholder?: string }) {
  return <label className="select-wrap">{label && <span>{label}</span>}<select value={value} onChange={e => onChange(e.target.value)} aria-label={label ?? placeholder}>{placeholder !== undefined && <option value="">{placeholder}</option>}{options.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}</select></label>
}
