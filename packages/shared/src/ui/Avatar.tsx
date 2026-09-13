import type { ImgHTMLAttributes } from 'react';

export interface AvatarProps extends Omit<ImgHTMLAttributes<HTMLImageElement>, 'src'> {
  src?: string | null;
  name: string;
  size?: 'sm' | 'md' | 'lg';
}

// Radius follows the soft minor-app scale (decision 2026-07-02):
// 6px for the 28px header avatar, 9px for the larger content sizes.
const sizes: Record<NonNullable<AvatarProps['size']>, string> = {
  sm: 'h-7 w-7 rounded-badge text-[10px]',
  md: 'h-9 w-9 rounded-[9px] text-xs',
  lg: 'h-14 w-14 rounded-[9px] text-base',
};

function initials(name: string): string {
  const parts = name.trim().split(/\s+/);
  if (parts.length === 0 || parts[0] === '') return '?';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

// Photo if a caller has one to give; otherwise monogram initials in a
// brand-tinted chip. Nothing in Aeolus stores profile photos, so the monogram
// is what people actually see — `src` stays for anyone who wires one up.
export function Avatar({ src, name, size = 'md', className = '', ...rest }: AvatarProps) {
  const sizeCls = sizes[size];
  const baseCls =
    'inline-flex items-center justify-center overflow-hidden bg-accent-bg font-mono font-medium uppercase tracking-wider text-accent-text';
  if (src) {
    return (
      <img
        src={src}
        alt={name}
        className={`${baseCls} ${sizeCls} ${className} object-cover`.trim()}
        {...rest}
      />
    );
  }
  return (
    <span role="img" aria-label={name} className={`${baseCls} ${sizeCls} ${className}`.trim()}>
      {initials(name)}
    </span>
  );
}
