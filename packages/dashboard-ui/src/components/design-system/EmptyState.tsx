import type { ReactNode } from 'react';

export type EmptyStateTone = 'accent' | 'positive' | 'muted';
export type EmptyStateSize = 'page' | 'inline';

export interface EmptyStateProps {
    /** Primary line. Every empty state names what is absent. */
    title: string;
    /** Optional leading icon, shown in a rounded tile above the title. */
    icon?: ReactNode;
    /** Optional supporting sentence under the title. */
    detail?: string;
    /** Optional action (e.g. a copy-command button or a clear-filters control). */
    action?: ReactNode;
    /** 'page' fills and centres an empty tab or panel (default); 'inline' is compact, for a table filtered to nothing. */
    size?: EmptyStateSize;
    /** Icon-tile accent. Defaults to the section accent; 'positive' for healthy states, 'muted' for transient filter results. */
    tone?: EmptyStateTone;
    className?: string;
}

export function EmptyState({
    title,
    icon,
    detail,
    action,
    size = 'page',
    tone = 'accent',
    className,
}: EmptyStateProps) {
    const classes = [
        'cr-empty-state',
        `cr-empty-state--${size}`,
        tone !== 'accent' && `cr-empty-state--${tone}`,
        className,
    ].filter(Boolean).join(' ');

    return (
        <div className={classes}>
            {icon && <div className="cr-empty-state__icon" aria-hidden="true">{icon}</div>}
            <div className="cr-empty-state__text">
                <p className="cr-empty-state__title">{title}</p>
                {detail && <p className="cr-empty-state__detail">{detail}</p>}
            </div>
            {action && <div className="cr-empty-state__action">{action}</div>}
        </div>
    );
}
