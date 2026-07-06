import type { ReactNode } from 'react';

export interface ToggleGroupOption<T extends string = string> {
    value: T;
    label: ReactNode;
    count?: number;
}

export interface ToggleGroupProps<T extends string = string> {
    options: ToggleGroupOption<T>[];
    value: T;
    onChange: (value: T) => void;
    className?: string;
    size?: 'sm' | 'md';
}

export function ToggleGroup<T extends string = string>({
    options,
    value,
    onChange,
    className,
    size = 'md',
}: ToggleGroupProps<T>) {
    return (
        <div className={`cr-toggle-group cr-toggle-group--${size}${className ? ` ${className}` : ''}`} role="tablist">
            {options.map(opt => (
                <button
                    key={opt.value}
                    type="button"
                    role="tab"
                    className={`cr-toggle-group__btn${opt.value === value ? ' cr-toggle-group__btn--active' : ''}`}
                    aria-selected={opt.value === value}
                    onClick={() => onChange(opt.value)}
                >
                    {opt.label}
                    {opt.count !== undefined && (
                        <span className="cr-toggle-group__count">{opt.count}</span>
                    )}
                </button>
            ))}
        </div>
    );
}
