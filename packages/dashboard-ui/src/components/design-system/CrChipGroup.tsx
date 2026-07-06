import type { ReactNode } from 'react';

export type CrChipTone = 'signal' | 'warn' | 'danger' | 'ok' | 'muted';

export interface CrChipOption<T extends string = string> {
    value: T;
    label: ReactNode;
    count?: number;
    tone?: CrChipTone;
    dot?: boolean;
    icon?: ReactNode;
}

export interface CrChipGroupProps<T extends string = string> {
    options: CrChipOption<T>[];
    value: Set<T>;
    onChange: (value: T) => void;
    className?: string;
}

export function CrChipGroup<T extends string = string>({
    options,
    value,
    onChange,
    className,
}: CrChipGroupProps<T>) {
    return (
        <div className={`cr-chip-group${className ? ` ${className}` : ''}`} role="group">
            {options.map(opt => {
                const active = value.has(opt.value);
                return (
                    <button
                        key={opt.value}
                        type="button"
                        className={`cr-chip${active ? ' cr-chip--active' : ''}${opt.tone ? ` cr-chip--${opt.tone}` : ''}`}
                        aria-pressed={active}
                        onClick={() => onChange(opt.value)}
                    >
                        {opt.dot && <span className="cr-chip__dot" aria-hidden />}
                        {opt.icon}
                        <span>{opt.label}</span>
                        {opt.count !== undefined && (
                            <span className="cr-chip__count">{opt.count}</span>
                        )}
                    </button>
                );
            })}
        </div>
    );
}
