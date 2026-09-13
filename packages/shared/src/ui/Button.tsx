import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from 'react';

export type ButtonVariant = 'primary' | 'ghost' | 'danger' | 'mono';
export type ButtonSize = 'md' | 'sm' | 'xs';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  children: ReactNode;
}

// Buttons read like a terminal would: tight kerning, slight letter-
// spacing on the chrome variants, monospace for the "mono" variant
// used by editor toolbar and admin tables. Corners follow the soft
// minor-app radius scale (decision 2026-07-02): buttons sit at the
// 8px default stop (`rounded`).
//
// Padding and type size live in the size table, not here, so a caller never
// has to fight the base with `!px-2 !py-1 !text-xs` overrides (which is what
// every panel did before the size prop existed).
const base =
  'inline-flex items-center justify-center gap-2 rounded font-medium transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-offset-2 focus-visible:ring-offset-page disabled:cursor-not-allowed disabled:opacity-60';

// md is the default chrome button; sm is the panel / table-row size; xs is
// the smallest legible stop, for dense rows such as the history list.
const sizes: Record<ButtonSize, string> = {
  md: 'px-3.5 py-1.5 text-sm',
  sm: 'px-2 py-1 text-xs',
  xs: 'px-1.5 py-0.5 text-[10px]',
};

// Mono sets its own type sizes: the CLI look wants a fixed pixel size at each
// stop rather than the rem-based text-sm / text-xs ramp, and putting both a
// `text-xs` and a `text-[12px]` on one element would leave the winner to
// stylesheet order.
const monoSizes: Record<ButtonSize, string> = {
  md: 'px-3.5 py-1.5 text-[12px]',
  sm: 'px-2 py-1 text-[11px]',
  xs: 'px-1.5 py-0.5 text-[10px]',
};

const variants: Record<ButtonVariant, string> = {
  // Primary actions. "The highest-contrast surface on the page" is the rule,
  // which is deep ink on a light ground and near-white on a dark one — so the
  // whole ladder inverts, and it comes from the btn-primary tokens rather than
  // being spelled as a lightness.
  primary:
    'bg-btn-primary text-btn-primary-fg hover:bg-btn-primary-hover active:bg-btn-primary-active',
  // Ghost: outlined neutral, becomes the workhorse on toolbars.
  ghost:
    'bg-transparent text-body-2 hover:bg-fill-hover hover:text-body border border-hairline-strong active:bg-fill-warm',
  // Danger reads loud — it is the button a destructive action ends on (the
  // confirm step of a delete, revoke or remove), never the button that opens
  // the confirm. NOT brand-700: a light label on #d9651f measures 3.30:1,
  // short of AA at this size. --btn-danger-*
  // is brand-900 on light for that reason, and carries a border because on
  // dark a fill dark enough for a light label cannot also clear 3:1 against
  // the card.
  danger:
    'border border-btn-danger-border bg-btn-danger text-btn-danger-fg hover:bg-btn-danger-hover',
  // Mono: a hacker-flavored alt for chrome buttons (editor toolbar,
  // admin filters). Same visual weight as ghost but in the mono face
  // with widened tracking so it reads like a CLI affordance.
  mono: 'bg-transparent text-body-2 hover:bg-fill-hover hover:text-body border border-hairline-strong font-mono tracking-wider uppercase',
};

// The full class string a <Button> renders with, for the two or three places
// that must be an <a> (a download link, a link that opens a new tab) but
// should look exactly like the button beside them. Keeping one source for the
// class list is what stops those anchors drifting from the real button.
export function buttonClass(
  variant: ButtonVariant = 'primary',
  size: ButtonSize = 'md',
  className = '',
): string {
  const sizeCls = variant === 'mono' ? monoSizes[size] : sizes[size];
  return `${base} ${sizeCls} ${variants[variant]} ${className}`.trim();
}

// forwardRef so callers that need to manage focus (ConfirmInline puts focus on
// Cancel when it appears) can reach the underlying <button>.
export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'primary', size = 'md', className = '', type = 'button', children, ...rest },
  ref,
) {
  return (
    <button ref={ref} type={type} className={buttonClass(variant, size, className)} {...rest}>
      {children}
    </button>
  );
});
