import type { CSSProperties, ReactNode } from 'react';

export function AccentCard({
    color = 'var(--text-tertiary)',
    children,
    style,
    className,
}: {
    color?: string;
    children: ReactNode;
    style?: CSSProperties;
    className?: string;
}) {
    return (
        <div
            className={className}
            style={{
                borderRadius: '6px',
                borderLeft: `2px solid ${color}`,
                background: 'rgba(255,255,255,0.025)',
                padding: '10px 14px',
                display: 'flex',
                flexDirection: 'column',
                gap: '4px',
                ...style,
            }}
        >
            {children}
        </div>
    );
}

export function DetailCard({
    color,
    badge,
    title,
    trailing,
    style,
    children,
}: {
    color?: string;
    badge?: string;
    title: string;
    trailing?: ReactNode;
    style?: CSSProperties;
    children?: ReactNode;
}) {
    return (
        <AccentCard color={color} style={style}>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: '8px', flexWrap: 'wrap' }}>
                {badge && (
                    <span style={{
                        fontSize: '10.5px',
                        fontFamily: "'JetBrains Mono', monospace",
                        color: 'var(--text-tertiary)',
                        opacity: 0.55,
                        flexShrink: 0,
                    }}>
                        {badge}
                    </span>
                )}
                <span style={{
                    fontSize: 'var(--cr-type-caption)',
                    fontWeight: 500,
                    color: 'var(--text-primary)',
                    letterSpacing: 0,
                }}>
                    {title}
                </span>
                {trailing && (
                    <span style={{ marginLeft: 'auto', flexShrink: 0 }}>
                        {trailing}
                    </span>
                )}
            </div>
            {children}
        </AccentCard>
    );
}

export function BadgeWithLabel({
    label,
    value,
    color,
    icon,
    title,
}: {
    label: string;
    value: ReactNode;
    color: string;
    icon?: ReactNode;
    title?: string;
}) {
    return (
        <span title={title} style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: '6px',
            padding: '3px 8px',
            borderRadius: '5px',
            background: 'rgba(255,255,255,0.03)',
            border: '1px solid rgba(255,255,255,0.06)',
            fontSize: 'var(--cr-type-micro)',
            fontFamily: 'var(--font-sans)',
            whiteSpace: 'nowrap',
        }}>
            <span style={{ color: 'var(--text-tertiary)', fontWeight: 400 }}>{label}</span>
            <span style={{ color, fontWeight: 500, display: 'inline-flex', alignItems: 'center', gap: '4px' }}>
                {icon}
                {value}
            </span>
        </span>
    );
}
