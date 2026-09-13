import { forwardRef, type ReactNode, type SelectHTMLAttributes } from 'react';

export interface SelectProps extends SelectHTMLAttributes<HTMLSelectElement> {
  label?: ReactNode;
  hint?: ReactNode;
  // The <option> elements. Passed through untouched so a caller can render
  // them from its own list or write them by hand.
  children: ReactNode;
}

// Same field treatment as Input: mono, hairline border that hardens to the
// focus colour, letterspaced uppercase mono label. A native <select> — the
// three places this is used pick from at most five options, and the platform
// control is the most accessible one there is for that.
const field =
  'block w-full rounded border border-hairline-strong bg-surface px-3 py-2 font-mono text-[13px] text-body transition-colors focus:border-focus focus:outline-none focus:ring-1 focus:ring-focus';

export const Select = forwardRef<HTMLSelectElement, SelectProps>(function Select(
  { label, hint, className = '', id, children, ...rest },
  ref,
) {
  const selectId = id ?? rest.name;
  return (
    <label className="flex flex-col gap-1.5" htmlFor={selectId}>
      {label ? (
        <span className="font-mono text-[10px] font-medium uppercase tracking-widest text-muted">
          {label}
        </span>
      ) : null}
      <select ref={ref} id={selectId} className={`${field} ${className}`.trim()} {...rest}>
        {children}
      </select>
      {hint ? <span className="font-mono text-[11px] text-muted">{hint}</span> : null}
    </label>
  );
});
