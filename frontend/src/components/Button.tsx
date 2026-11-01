import type { ButtonHTMLAttributes } from 'react';
import { Spinner } from './Spinner';

type Variant = 'primary' | 'secondary' | 'danger';

const VARIANTS: Record<Variant, string> = {
  primary: 'bg-emerald-700 text-white hover:bg-emerald-800 disabled:bg-emerald-700/60',
  secondary: 'border border-slate-300 bg-white text-slate-800 hover:bg-slate-100 disabled:text-slate-500',
  danger: 'bg-red-700 text-white hover:bg-red-800 disabled:bg-red-700/60',
};

/** The look of a button, for whatever element acts as one. */
export const buttonClass = (variant: Variant) =>
  `inline-flex min-h-10 items-center justify-center gap-2 rounded-lg px-4 py-2 text-sm font-semibold transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-700 disabled:cursor-not-allowed ${VARIANTS[variant]}`;

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  /** Disables the button and shows a spinner while a request is in flight. */
  pending?: boolean;
}

export function Button({ variant = 'primary', pending = false, disabled, className = '', children, ...props }: ButtonProps) {
  return (
    <button
      type="button"
      {...props}
      disabled={disabled === true || pending}
      aria-busy={pending || undefined}
      className={`${buttonClass(variant)} ${className}`}
    >
      {pending && <Spinner className="size-4" />}
      {children}
    </button>
  );
}
