import type { BarChartSection } from '@coderadius/types';
import { SimpleTooltip } from './Tooltip';

export function BarChart({ section }: { section: BarChartSection }) {
    return (
        <section className="stagger-2">
            <h2>{section.title}</h2>
            {section.subtitle && <p className="hist-subtitle">{section.subtitle}</p>}
            <div className="spotlight-card bc-container">
                {section.data.map((d, i) => (
                    <div key={i} className="bc-row">
                        <SimpleTooltip content={d.tooltip}>
                            <div className="bc-label">
                                {d.label}
                            </div>
                        </SimpleTooltip>
                        <div className="bc-track-container">
                            <div className="bc-track">
                                <div 
                                    className={`bc-fill ${d.colorClass || 'color-bg-teal'}`} 
                                    style={{ width: `${Math.max(d.percentage, 1.5)}%` }}
                                >
                                    <div className="bc-gradient"></div>
                                </div>
                            </div>
                            <div className="bc-value">{d.value}</div>
                        </div>
                    </div>
                ))}
            </div>
        </section>
    );
}
