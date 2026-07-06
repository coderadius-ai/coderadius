import type { ButtonHTMLAttributes, ReactNode } from 'react';

export interface CrButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'className'> {
    variant?: 'secondary' | 'primary' | 'ghost';
    icon?: ReactNode;
}

export function CrButton({ variant = 'secondary', icon, children, ...rest }: CrButtonProps) {
    return (
        <button type="button" className={`cr-btn cr-btn--${variant}`} {...rest}>
            {icon}
            {children}
        </button>
    );
}
