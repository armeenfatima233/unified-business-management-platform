import type { CustomFieldType } from './api/types'
import { Field } from './compat/Common'

export type FieldLike = { id: string; name: string; type: CustomFieldType; options?: string[] }
export type FieldValues = Record<string, string | boolean>

// Typed input for one custom field. The server validates again; this only makes the right input appear.
export function FieldInput({ field, value, onChange, required = false }: { field: FieldLike; value: string | boolean | undefined; onChange: (value: string | boolean) => void; required?: boolean }) {
  if (field.type === 'checkbox') return <label className="check-label"><input type="checkbox" checked={value === true} onChange={e => onChange(e.target.checked)} />{field.name}</label>
  return <Field label={`${field.name}${required ? ' (required)' : ''}`}>
    {field.type === 'dropdown'
      ? <select value={String(value ?? '')} onChange={e => onChange(e.target.value)} required={required}><option value="">Choose…</option>{(field.options ?? []).map(o => <option key={o} value={o}>{o}</option>)}</select>
      : <input required={required} type={field.type === 'number' ? 'number' : field.type === 'date' ? 'date' : 'text'} step={field.type === 'number' ? 'any' : undefined} value={String(value ?? '')} onChange={e => onChange(e.target.value)} />}
  </Field>
}

export function CustomFieldsForm({ fields, values, onChange, requiredIds = [] }: { fields: FieldLike[]; values: FieldValues; onChange: (values: FieldValues) => void; requiredIds?: string[] }) {
  if (fields.length === 0) return null
  return <div className="form-grid">{fields.map(f => <FieldInput key={f.id} field={f} required={requiredIds.includes(f.id)} value={values[f.id]} onChange={v => onChange({ ...values, [f.id]: v })} />)}</div>
}

// Converts the editor state to the API payload: empty text clears the value, numbers are numbers.
export function toPayload(fields: FieldLike[], values: FieldValues): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const f of fields) {
    const v = values[f.id]
    if (v === undefined) continue
    out[f.id] = f.type === 'checkbox' ? v === true : v === '' ? null : f.type === 'number' ? Number(v) : v
  }
  return out
}

export function initialValues(fields: { id: string; value?: string | number | boolean | null }[]): FieldValues {
  const out: FieldValues = {}
  for (const f of fields) if (f.value !== null && f.value !== undefined) out[f.id] = typeof f.value === 'boolean' ? f.value : String(f.value)
  return out
}

export function displayValue(f: { type: CustomFieldType; value: string | number | boolean | null }): string {
  if (f.value === null || f.value === undefined || f.value === '') return '—'
  return f.type === 'checkbox' ? (f.value ? 'Yes' : 'No') : String(f.value)
}
