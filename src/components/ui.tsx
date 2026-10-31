import {
  useId,
  type ButtonHTMLAttributes,
  type HTMLAttributes,
  type InputHTMLAttributes,
  type ReactNode,
} from 'react';

// ---------------------------------------------------------------------------
// Button
// ---------------------------------------------------------------------------

type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'link';

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  small?: boolean;
  block?: boolean;
  busy?: boolean;
}

export function Button({ variant = 'primary', small, block, busy, className, children, disabled, type, ...rest }: ButtonProps) {
  const cls = ['btn', `btn-${variant}`, small && 'btn-small', block && 'btn-block', busy && 'is-busy', className]
    .filter(Boolean)
    .join(' ');
  return (
    <button type={type ?? 'button'} className={cls} disabled={disabled || busy} aria-busy={busy || undefined} {...rest}>
      {busy && <span className="spinner" aria-hidden="true" />}
      <span>{children}</span>
    </button>
  );
}

// ---------------------------------------------------------------------------
// Card
// ---------------------------------------------------------------------------

interface CardProps extends HTMLAttributes<HTMLElement> {
  as?: 'section' | 'div' | 'article';
}

export function Card({ as: Tag = 'section', className, children, ...rest }: CardProps) {
  return (
    <Tag className={['card', className].filter(Boolean).join(' ')} {...rest}>
      {children}
    </Tag>
  );
}

// ---------------------------------------------------------------------------
// Chip
// ---------------------------------------------------------------------------

export function Chip({ tone = 'cream', children }: { tone?: 'red' | 'cream' | 'gold' | 'green'; children: ReactNode }) {
  return <span className={`chip chip-${tone}`}>{children}</span>;
}

// ---------------------------------------------------------------------------
// Field (label + control + hint/error)
// ---------------------------------------------------------------------------

interface FieldProps {
  label: ReactNode;
  hint?: ReactNode;
  error?: ReactNode;
  /** Render-prop receives the id and aria-describedby to wire up the control. */
  children: (ids: { id: string; describedBy: string | undefined }) => ReactNode;
  className?: string;
}

export function Field({ label, hint, error, children, className }: FieldProps) {
  const id = useId();
  const hintId = hint ? `${id}-hint` : undefined;
  const errId = error ? `${id}-err` : undefined;
  const describedBy = [hintId, errId].filter(Boolean).join(' ') || undefined;
  return (
    <div className={['field', className].filter(Boolean).join(' ')}>
      <label htmlFor={id} className="field-label">
        {label}
      </label>
      {children({ id, describedBy })}
      {hint && (
        <div id={hintId} className="field-hint">
          {hint}
        </div>
      )}
      {error && (
        <div id={errId} className="field-error" role="alert">
          {error}
        </div>
      )}
    </div>
  );
}

interface TextFieldProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'id'> {
  label: ReactNode;
  hint?: ReactNode;
  error?: ReactNode;
}

export function TextField({ label, hint, error, className, ...input }: TextFieldProps) {
  return (
    <Field label={label} hint={hint} error={error} className={className}>
      {({ id, describedBy }) => (
        <input id={id} className="input" aria-describedby={describedBy} aria-invalid={error ? true : undefined} {...input} />
      )}
    </Field>
  );
}

interface CheckboxProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'type' | 'id'> {
  label: ReactNode;
  hint?: ReactNode;
}

export function Checkbox({ label, hint, ...input }: CheckboxProps) {
  const id = useId();
  return (
    <div className="checkbox">
      <input type="checkbox" id={id} aria-describedby={hint ? `${id}-hint` : undefined} {...input} />
      <label htmlFor={id}>
        <span>{label}</span>
        {hint && (
          <span id={`${id}-hint`} className="field-hint">
            {hint}
          </span>
        )}
      </label>
    </div>
  );
}

/** Centered cozy loading state. */
export function Loading({ label = 'Warming up…' }: { label?: string }) {
  return (
    <div className="loading" role="status" aria-live="polite">
      <span className="loading-flame" aria-hidden="true" />
      <span>{label}</span>
    </div>
  );
}
