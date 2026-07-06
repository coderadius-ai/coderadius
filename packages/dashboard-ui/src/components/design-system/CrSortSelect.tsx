export interface CrSortOption<T extends string = string> {
    value: T;
    label: string;
}

export interface CrSortSelectProps<T extends string = string> {
    options: CrSortOption<T>[];
    value: T;
    onChange: (value: T) => void;
    label?: string;
}

export function CrSortSelect<T extends string = string>({
    options,
    value,
    onChange,
    label = 'sort by',
}: CrSortSelectProps<T>) {
    return (
        <div className="cr-sort">
            {label && <span className="cr-sort__label">{label}</span>}
            <select
                value={value}
                onChange={e => onChange(e.target.value as T)}
            >
                {options.map(opt => (
                    <option key={opt.value} value={opt.value}>{opt.label}</option>
                ))}
            </select>
        </div>
    );
}
