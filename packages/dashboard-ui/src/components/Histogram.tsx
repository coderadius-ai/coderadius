import type { HistogramSection } from '@coderadius/types';
import { SimpleTooltip } from './Tooltip';

export function Histogram({ section }: { section: HistogramSection }) {
    return (
        <section className="stagger-2">
            <h2>{section.title}</h2>
            {section.subtitle && <p className="hist-subtitle">{section.subtitle}</p>}
            <div>
                {section.data.map((d, i) => (
                    <div key={i} className="histogram-row">
                        <SimpleTooltip content={d.tooltip}>
                            <div className="hist-label">
                                {d.label}
                            </div>
                        </SimpleTooltip>
                        <div className="hist-bar-container">
                            <div 
                                className={`hist-fill ${d.colorClass || 'color-bg-teal'}`} 
                                style={{ width: `${Math.max(d.percentage, 1)}%` }} 
                            />
                        </div>
                        <div className="hist-value">
                            <span className="hv-count">{d.value}</span>
                            <span className="hv-pct">{d.percentage}%</span>
                        </div>
                    </div>
                ))}
            </div>
        </section>
    );
}
