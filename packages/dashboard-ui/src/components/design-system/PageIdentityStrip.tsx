import type { ReactNode } from 'react';

export interface PageIdentityKpi {
    value: string | number;
    label: string;
    tone?: string;
    tooltip?: string;
}

export interface PageIdentityStripProps {
    icon?: ReactNode;
    title: string;
    subtitle?: string;
    kpis?: PageIdentityKpi[];
    separator?: number;
    children?: ReactNode;
}

export function PageIdentityStrip({ icon, title, subtitle, kpis, separator, children }: PageIdentityStripProps) {
    return (
        <div className="cr-id-strip" role="region" aria-label={title}>
            <div className="cr-id-strip__copy">
                {(title || icon) && (
                    <h2 className="cr-id-strip__title">
                        {icon && <span className="cr-id-strip__icon" aria-hidden="true">{icon}</span>}
                        {title}
                    </h2>
                )}
                {subtitle && <p className="cr-id-strip__subtitle">{subtitle}</p>}
            </div>
            {(kpis && kpis.length > 0 || children) && (
                <div className="cr-id-strip__right">
                    {kpis && kpis.length > 0 && (
                        <div className="cr-id-strip__kpis">
                            {kpis.map((kpi, i) => (
                                <span key={kpi.label}>
                                    {separator !== undefined && i === separator && (
                                        <span className="cr-id-strip__sep" aria-hidden="true" />
                                    )}
                                    <span className={`cr-id-strip__kpi${kpi.tone ? ` cr-id-strip__kpi--${kpi.tone}` : ''}`}>
                                        <span className="cr-id-strip__num">{kpi.value}</span>
                                        <span className="cr-id-strip__label">{kpi.label}</span>
                                    </span>
                                </span>
                            ))}
                        </div>
                    )}
                    {children}
                </div>
            )}
        </div>
    );
}
