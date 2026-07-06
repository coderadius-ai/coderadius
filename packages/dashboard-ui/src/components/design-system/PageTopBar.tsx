import type { ReactNode } from 'react';

interface PageTopBarBadge {
    type: string;
    label: string;
}

export interface PageTopBarProps {
    title: string;
    sectionLabel?: ReactNode;
    badge?: PageTopBarBadge;
    /** Optional control rendered before the title as a breadcrumb prefix (e.g. the org switcher). */
    leading?: ReactNode;
    children?: ReactNode;
}

export function PageTopBar({ title, sectionLabel, badge, leading, children }: PageTopBarProps) {
    return (
        <header className="cr-topbar">
            <div className="cr-topbar__inner">
                <div className="cr-topbar__heading">
                    {leading}
                    <h1 className="cr-topbar__title">
                        {title}
                        {sectionLabel && (
                            <span className="cr-topbar__section">{sectionLabel}</span>
                        )}
                        {badge && (
                            <span className={`badge ${badge.type}`}>{badge.label}</span>
                        )}
                    </h1>
                </div>
                {children && (
                    <div className="cr-topbar__actions">{children}</div>
                )}
            </div>
        </header>
    );
}
