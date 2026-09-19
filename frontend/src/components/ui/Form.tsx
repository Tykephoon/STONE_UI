/**
 * Form primitives.
 *
 * Each control wires its own label, description, and error message together
 * with `aria-describedby` / `aria-invalid`, so accessibility is a property of
 * using the component rather than something each form has to remember.
 *
 * Client-side validation here is for speed of feedback only. The backend
 * validates authoritatively and its field errors are rendered through the same
 * `error` prop.
 */
import {
  type InputHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
  forwardRef,
  useId,
} from 'react';
import styles from './Form.module.css';

interface FieldShellProps {
  label: string;
  htmlFor: string;
  error?: string | undefined;
  hint?: ReactNode;
  required?: boolean;
  children: ReactNode;
  /** Renders the label and control side by side. */
  inline?: boolean;
}

function FieldShell({
  label,
  htmlFor,
  error,
  hint,
  required,
  children,
  inline,
}: FieldShellProps): JSX.Element {
  return (
    <div className={[styles.field, inline ? styles.inline : ''].filter(Boolean).join(' ')}>
      <label className={styles.label} htmlFor={htmlFor}>
        {label}
        {required && (
          <span className={styles.required} aria-hidden="true">
            *
          </span>
        )}
      </label>
      <div className={styles.control}>
        {children}
        {hint && !error && <p className={styles.hint}>{hint}</p>}
        {error && (
          <p className={styles.error} role="alert">
            {error}
          </p>
        )}
      </div>
    </div>
  );
}

export interface TextFieldProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'id'> {
  label: string;
  error?: string | undefined;
  hint?: ReactNode;
}

export const TextField = forwardRef<HTMLInputElement, TextFieldProps>(function TextField(
  { label, error, hint, required, className, ...rest },
  ref,
) {
  const id = useId();
  const describedBy = error ? `${id}-error` : hint ? `${id}-hint` : undefined;

  return (
    <FieldShell label={label} htmlFor={id} error={error} hint={hint} required={required}>
      <input
        ref={ref}
        id={id}
        className={[styles.input, error ? styles.invalid : '', className ?? '']
          .filter(Boolean)
          .join(' ')}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy}
        required={required}
        {...rest}
      />
    </FieldShell>
  );
});

export interface SelectFieldProps extends Omit<SelectHTMLAttributes<HTMLSelectElement>, 'id'> {
  label: string;
  error?: string | undefined;
  hint?: ReactNode;
  options: { value: string; label: string }[];
  inline?: boolean;
}

export const SelectField = forwardRef<HTMLSelectElement, SelectFieldProps>(function SelectField(
  { label, error, hint, options, inline, className, ...rest },
  ref,
) {
  const id = useId();

  return (
    <FieldShell label={label} htmlFor={id} error={error} hint={hint} inline={inline}>
      <div className={styles.selectWrap}>
        <select
          ref={ref}
          id={id}
          className={[styles.input, styles.select, className ?? ''].filter(Boolean).join(' ')}
          aria-invalid={error ? true : undefined}
          {...rest}
        >
          {options.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
        <svg className={styles.chevron} viewBox="0 0 16 16" aria-hidden="true">
          <path
            d="M4 6l4 4 4-4"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.6"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </div>
    </FieldShell>
  );
});

export interface TextAreaFieldProps
  extends Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, 'id'> {
  label: string;
  error?: string | undefined;
  hint?: ReactNode;
}

export const TextAreaField = forwardRef<HTMLTextAreaElement, TextAreaFieldProps>(
  function TextAreaField({ label, error, hint, className, ...rest }, ref) {
    const id = useId();

    return (
      <FieldShell label={label} htmlFor={id} error={error} hint={hint}>
        <textarea
          ref={ref}
          id={id}
          className={[styles.input, styles.textarea, error ? styles.invalid : '', className ?? '']
            .filter(Boolean)
            .join(' ')}
          aria-invalid={error ? true : undefined}
          {...rest}
        />
      </FieldShell>
    );
  },
);

export interface SliderProps {
  label: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  /** Rendered beside the label — usually the value with its unit. */
  display?: string;
  onChange: (value: number) => void;
  disabled?: boolean;
}

export function Slider({
  label,
  value,
  min,
  max,
  step = 0.01,
  display,
  onChange,
  disabled,
}: SliderProps): JSX.Element {
  const id = useId();
  // Drives the filled portion of the track via a CSS custom property.
  const progress = max === min ? 0 : ((value - min) / (max - min)) * 100;

  return (
    <div className={styles.slider}>
      <div className={styles.sliderHead}>
        <label className={styles.sliderLabel} htmlFor={id}>
          {label}
        </label>
        <span className={styles.sliderValue}>{display ?? value}</span>
      </div>
      <input
        id={id}
        type="range"
        className={styles.range}
        style={{ ['--progress' as string]: `${progress}%` }}
        value={value}
        min={min}
        max={max}
        step={step}
        disabled={disabled}
        onChange={(event) => onChange(Number(event.target.value))}
      />
    </div>
  );
}

export interface ToggleProps {
  label: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
  description?: string;
  disabled?: boolean;
}

export function Toggle({
  label,
  checked,
  onChange,
  description,
  disabled,
}: ToggleProps): JSX.Element {
  const id = useId();

  return (
    <div className={styles.toggleRow}>
      <div className={styles.toggleText}>
        <label className={styles.toggleLabel} htmlFor={id}>
          {label}
        </label>
        {description && <p className={styles.hint}>{description}</p>}
      </div>
      <button
        id={id}
        type="button"
        role="switch"
        aria-checked={checked}
        aria-label={label}
        disabled={disabled}
        className={[styles.toggle, checked ? styles.toggleOn : ''].filter(Boolean).join(' ')}
        onClick={() => onChange(!checked)}
      >
        <span className={styles.toggleKnob} />
      </button>
    </div>
  );
}

export interface ColorFieldProps {
  label: string;
  value: string;
  onChange: (value: string) => void;
}

export function ColorField({ label, value, onChange }: ColorFieldProps): JSX.Element {
  const id = useId();

  return (
    <div className={styles.colorRow}>
      <label className={styles.sliderLabel} htmlFor={id}>
        {label}
      </label>
      <div className={styles.colorControl}>
        <span className={styles.colorSwatch} style={{ background: value }} aria-hidden="true" />
        <input
          id={id}
          type="color"
          className={styles.colorInput}
          value={value}
          onChange={(event) => onChange(event.target.value)}
        />
        <code className={styles.colorValue}>{value.toUpperCase()}</code>
      </div>
    </div>
  );
}

/** Groups related controls under a small heading inside a panel. */
export function FieldGroup({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}): JSX.Element {
  return (
    <fieldset className={styles.group}>
      <legend className={styles.groupTitle}>{title}</legend>
      <div className={styles.groupBody}>{children}</div>
    </fieldset>
  );
}
