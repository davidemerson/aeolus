import type { InputHTMLAttributes, ReactNode } from 'react';

export interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  label?: ReactNode;
  hint?: ReactNode;
  error?: ReactNode;
}

// Field treatment: monospace input matches the hacker-flavored
// chrome elsewhere — emails, paths, ids all read better in mono. The
// border hardens to the focus colour and a 1px ring doubles it, so the
// focused field is visible even where the border alone would be a
// one-shade change. Letterspaced uppercase mono labels give
// the form a CLI / dossier feel without being shouty.
const field =
  'block w-full rounded border border-hairline-strong bg-surface px-3 py-2 font-mono text-[13px] text-body placeholder-placeholder transition-colors focus:border-focus focus:outline-none focus:ring-1 focus:ring-focus';

export function Input({ label, hint, error, className = '', id, ...rest }: InputProps) {
  const inputId = id ?? rest.name;
  return (
    <label className="flex flex-col gap-1.5" htmlFor={inputId}>
      {label ? (
        <span className="font-mono text-[10px] font-medium uppercase tracking-widest text-muted">
          {label}
        </span>
      ) : null}
      <input id={inputId} className={`${field} ${className}`.trim()} {...rest} />
      {hint && !error ? <span className="font-mono text-[11px] text-muted">{hint}</span> : null}
      {error ? <span className="font-mono text-[11px] text-accent-text">{error}</span> : null}
    </label>
  );
}
