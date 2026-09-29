import React, { forwardRef } from 'react';
import { cn } from './cn';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'subtle';
export type ButtonSize = 'xs' | 'sm' | 'md';

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  icon?: React.ReactNode;
  /** Pressed / selected look (toggle buttons). */
  active?: boolean;
}

const VARIANT: Record<ButtonVariant, string> = {
  primary: 'bg-accent text-white hover:bg-accent-hover shadow-sm shadow-black/30',
  secondary: 'bg-surface-3 text-ink-1 hover:bg-surface-4 ring-1 ring-inset ring-line',
  ghost: 'text-ink-2 hover:text-ink-1 hover:bg-surface-3',
  danger: 'bg-critical/15 text-red-300 hover:bg-critical/25 ring-1 ring-inset ring-critical/30',
  subtle: 'bg-accent-muted text-accent-hover hover:bg-accent/25',
};

const SIZE: Record<ButtonSize, string> = {
  xs: 'h-6 px-2 text-xs gap-1 rounded-md',
  sm: 'h-7 px-2.5 text-xs gap-1.5 rounded-md',
  md: 'h-8 px-3 text-sm gap-2 rounded-lg',
};

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'secondary', size = 'md', icon, active, className, children, type = 'button', ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      className={cn(
        'inline-flex shrink-0 select-none items-center justify-center whitespace-nowrap font-medium transition-colors',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-ring disabled:pointer-events-none disabled:opacity-40',
        VARIANT[variant],
        SIZE[size],
        active && 'bg-accent-muted text-accent-hover ring-1 ring-inset ring-accent/40',
        className,
      )}
      {...rest}
    >
      {icon}
      {children}
    </button>
  );
});

export interface IconButtonProps extends Omit<ButtonProps, 'children' | 'icon'> {
  /** Accessible label, also shown as tooltip. */
  label: string;
  icon: React.ReactNode;
}

export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  { label, icon, size = 'md', variant = 'ghost', className, ...rest },
  ref,
) {
  const box = size === 'xs' ? 'w-6 px-0' : size === 'sm' ? 'w-7 px-0' : 'w-8 px-0';
  return (
    <Button ref={ref} aria-label={label} title={label} size={size} variant={variant} className={cn(box, className)} {...rest}>
      {icon}
    </Button>
  );
});
