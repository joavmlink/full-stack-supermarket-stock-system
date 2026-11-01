import { useId, type ComponentProps, type ReactNode } from 'react';

const inputClass =
  'mt-1 block w-full rounded-lg border bg-white px-3 py-2 text-base focus-visible:border-emerald-700 focus-visible:outline-2 focus-visible:outline-emerald-700 disabled:bg-slate-100 disabled:text-slate-500';

interface FieldFrameProps {
  label: string;
  error?: string | undefined;
  hint?: ReactNode;
  className?: string;
  /** Receives the props of the control, whatever element it is. */
  children: (control: {
    id: string;
    'aria-describedby': string | undefined;
    'aria-invalid': true | undefined;
    className: string;
  }) => ReactNode;
}

/** Label, control, hint and error, connected for screen readers (aria-describedby, aria-invalid). */
export function FieldFrame({ label, error, hint, className = '', children }: FieldFrameProps) {
  const id = useId();
  const inputId = `${id}-input`;
  const hintId = hint === undefined ? undefined : `${id}-hint`;
  const errorId = error === undefined ? undefined : `${id}-error`;
  return (
    <div className={className}>
      <label htmlFor={inputId} className="block text-sm font-medium">
        {label}
      </label>
      {children({
        id: inputId,
        'aria-describedby': [hintId, errorId].filter(Boolean).join(' ') || undefined,
        'aria-invalid': error === undefined ? undefined : true,
        className: `${inputClass} ${error === undefined ? 'border-slate-300' : 'border-red-600'}`,
      })}
      {hint !== undefined && (
        <p id={hintId} className="mt-1 text-sm text-slate-600">
          {hint}
        </p>
      )}
      {error !== undefined && (
        <p id={errorId} className="mt-1 text-sm font-medium text-red-700">
          {error}
        </p>
      )}
    </div>
  );
}

type CommonProps = Omit<FieldFrameProps, 'children'> & { testId?: string };

export function TextField({ label, error, hint, className, testId, ...props }: CommonProps & ComponentProps<'input'>) {
  return (
    <FieldFrame label={label} error={error} hint={hint} className={className}>
      {(control) => <input {...control} data-testid={testId} {...props} />}
    </FieldFrame>
  );
}

export function TextAreaField({ label, error, hint, className, testId, ...props }: CommonProps & ComponentProps<'textarea'>) {
  return (
    <FieldFrame label={label} error={error} hint={hint} className={className}>
      {(control) => <textarea {...control} className={`${control.className} min-h-24`} data-testid={testId} {...props} />}
    </FieldFrame>
  );
}

export function SelectField({ label, error, hint, className, testId, children, ...props }: CommonProps & ComponentProps<'select'>) {
  return (
    <FieldFrame label={label} error={error} hint={hint} className={className}>
      {(control) => (
        <select {...control} data-testid={testId} {...props}>
          {children}
        </select>
      )}
    </FieldFrame>
  );
}
