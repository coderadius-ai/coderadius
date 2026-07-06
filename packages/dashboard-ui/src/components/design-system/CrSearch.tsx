import { Search } from 'lucide-react';
import type { InputHTMLAttributes } from 'react';

export interface CrSearchProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'type' | 'className'> {
    maxWidth?: number | string;
    variant?: 'outlined' | 'flat';
}

export function CrSearch({ maxWidth, variant = 'flat', style, ...rest }: CrSearchProps) {
    const cls = variant === 'flat' ? 'cr-search cr-search--flat' : 'cr-search';
    return (
        <label className={cls} style={maxWidth ? { ...style, maxWidth } : style}>
            <Search size={13} aria-hidden />
            <input type="search" {...rest} />
        </label>
    );
}
