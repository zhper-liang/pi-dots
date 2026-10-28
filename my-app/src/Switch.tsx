/**
 * A real on/off switch: a native checkbox with role="switch", drawn as a track and knob in shell.css.
 * The visible state text repeats the state for sighted users; the accessible name is `label`.
 */
export default function Switch({ label, checked, onChange, disabled, onText = '开', offText = '关' }: {
  label: string; checked: boolean; onChange: () => void; disabled?: boolean; onText?: string; offText?: string
}) {
  return <label className={`pd-switch${disabled ? ' is-disabled' : ''}`}>
    <span className="pd-switch-state" aria-hidden="true">{checked ? onText : offText}</span>
    <input type="checkbox" role="switch" aria-label={label} checked={checked} disabled={disabled} onChange={onChange} />
  </label>
}
