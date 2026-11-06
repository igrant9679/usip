/**
 * The public forms' bot trap (audit 2026-10-20, G41): a text field placed off
 * screen, out of the tab order and hidden from assistive technology, so a
 * person never fills it and a form-filling bot usually does. The server
 * answers a submission that has it filled as a success and keeps nothing
 * (server/services/publicSubmission.ts).
 */
import { HONEYPOT_FIELD } from "@shared/publicForm";

export function HoneypotField({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <div aria-hidden="true" style={{ position: "absolute", left: "-10000px", top: "auto", width: 1, height: 1, overflow: "hidden" }}>
      <label htmlFor={`f-${HONEYPOT_FIELD}`}>Leave this field empty</label>
      <input
        id={`f-${HONEYPOT_FIELD}`}
        name={HONEYPOT_FIELD}
        type="text"
        tabIndex={-1}
        autoComplete="off"
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
    </div>
  );
}
