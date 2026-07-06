import type { ExecutiveBriefingSection } from '@coderadius/types';

export function ExecutiveBriefing({ section }: { section: ExecutiveBriefingSection }) {
    const renderIcon = (label: string) => {
        switch (label) {
            case "Risk Posture":
                return (
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="color-text-red">
                        <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"></path>
                        <line x1="12" y1="9" x2="12" y2="13"></line>
                        <line x1="12" y1="17" x2="12.01" y2="17"></line>
                    </svg>
                );
            case "Ecosystem Telemetry":
                return (
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="color-text-yellow">
                        <polyline points="22 12 18 12 15 21 9 3 6 12 2 12"></polyline>
                    </svg>
                );
            case "Strategic Directive":
                return (
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="color-text-cyan">
                        <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"></path>
                        <polyline points="22 4 12 14.01 9 11.01"></polyline>
                    </svg>
                );
            default:
                return null;
        }
    };

    const renderContent = (brief: ExecutiveBriefingSection['briefs'][number]) => {
        // Prefer structured segments over raw text
        if (brief.segments && brief.segments.length > 0) {
            return (
                <>
                    {brief.segments.map((seg, i) =>
                        seg.highlight
                            ? <span key={i} className="text-glow">{seg.text}</span>
                            : <span key={i}>{seg.text}</span>
                    )}
                </>
            );
        }
        // Fallback for legacy text (plain text only, no HTML)
        return <>{brief.text}</>;
    };

    return (
        <section className="stagger-1 executive-briefing-wrapper">
            {section.title && (
                <div className="chart-header">
                    <h3>{section.title}</h3>
                </div>
            )}
            <div className="eb-grid-3">
                {section.briefs.map((b, i) => (
                    <div key={i} className="eb-brief spotlight-card stagger-card">
                        <div className="eb-header">
                            <div className="eb-icon">{renderIcon(b.label)}</div>
                            <div className="eb-label">{b.label}</div>
                        </div>
                        <div className="eb-content">
                            {renderContent(b)}
                        </div>
                    </div>
                ))}
            </div>
        </section>
    );
}
