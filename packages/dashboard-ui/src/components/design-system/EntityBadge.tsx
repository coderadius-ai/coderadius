export type BadgeSize = 'sm' | 'md' | 'lg';

export function EntityBadge({
    label,
    color,
    bgColor,
    borderColor,
    size = 'sm',
}: {
    label: string;
    color: string;
    bgColor: string;
    borderColor: string;
    size?: BadgeSize;
}) {
    return (
        <span
            className={`entity-badge entity-badge--${size}`}
            style={{ color, background: bgColor, borderColor }}
            aria-label={label}
        >
            {label}
        </span>
    );
}
