import type { FormStep } from './schema.ts';
import { type State, setPath } from './state.ts';

export type FormOutcome =
  | { ok: true; state: State }
  | { ok: false; errors: Record<string, string>; values: Record<string, string> };

/**
 * Validates submitted form input and writes it into state. Number fields are
 * stored as numbers so later math blocks get numbers, not strings.
 */
export function applyFormInput(
  step: FormStep,
  state: State,
  input: Readonly<Record<string, string>>,
): FormOutcome {
  const errors: Record<string, string> = {};
  let next = state;
  for (const field of step.fields) {
    const raw = input[field.name] ?? '';
    if (raw.trim() === '') {
      if (field.required) errors[field.name] = `${field.label} is required`;
      continue;
    }
    if (field.type === 'number') {
      const parsed = Number(raw);
      if (!Number.isFinite(parsed)) {
        errors[field.name] = `${field.label} must be a number`;
        continue;
      }
      next = setPath(next, field.name, parsed);
    } else {
      // Browsers submit textarea line breaks as CRLF; store them as \n so the
      // same text means the same value however it arrived.
      next = setPath(
        next,
        field.name,
        field.type === 'textarea' ? raw.replace(/\r\n?/g, '\n') : raw,
      );
    }
  }
  if (Object.keys(errors).length > 0) return { ok: false, errors, values: { ...input } };
  return { ok: true, state: next };
}
