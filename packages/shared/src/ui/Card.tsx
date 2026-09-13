import type { HTMLAttributes, ReactNode } from 'react';

export interface CardProps extends Omit<HTMLAttributes<HTMLDivElement>, 'title'> {
  title?: ReactNode;
  // Optional small caption rendered next to the title in mono — the
  // hacker-flavoured scope label (e.g. `[admin] · audit`).
  eyebrow?: ReactNode;
  children: ReactNode;
}

// Surface card. Soft 14px corner radius (minor-app standard,
// decision 2026-07-02), lighter border, generous
// padding, and a hairline divider under the title to give the
// content room to breathe without a heavy box around it.
export function Card({ title, eyebrow, children, className = '', ...rest }: CardProps) {
  return (
    <div
      className={`rounded-card border border-hairline-strong bg-surface p-7 shadow-soft-lift ${className}`.trim()}
      {...rest}
    >
      {title || eyebrow ? (
        <div className="mb-5 flex items-baseline justify-between border-b border-hairline pb-3">
          {title ? (
            <h2 className="text-base font-semibold tracking-tight text-body">{title}</h2>
          ) : null}
          {eyebrow ? (
            <span className="font-mono text-[11px] uppercase tracking-widest text-muted">
              {eyebrow}
            </span>
          ) : null}
        </div>
      ) : null}
      {children}
    </div>
  );
}
