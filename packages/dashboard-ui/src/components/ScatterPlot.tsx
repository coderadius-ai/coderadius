import type { ScatterSection } from '@coderadius/types';
import { SimpleTooltip } from './Tooltip';

export function ScatterPlot({ section }: { section: ScatterSection }) {
    const xMax = section.xMax || Math.max(...section.data.map(d => d.x), 10);
    const yMax = section.yMax || Math.max(...section.data.map(d => d.y), 4);

    return (
        <section className="stagger-2">
            <div className="chart-header">
                <h3>{section.title}</h3>
                {section.subtitle && <p className="chart-subtitle">{section.subtitle}</p>}
            </div>
            <div className="scatter-container">
                <div className="scatter-y-label">{section.yAxisLabel || 'Maturity'}</div>
                <div className="scatter-x-label">{section.xAxisLabel || 'Commits'}</div>
                <div className="scatter-plot">
                    <div className="scatter-quadrant q-tl q-over-bg">Over-Engineered</div>
                    <div className="scatter-quadrant q-tr q-golden-bg">Golden Path</div>
                    <div className="scatter-quadrant q-bl q-grave-bg">Stable Core</div>
                    <div className="scatter-quadrant q-br q-ww-bg">The Wild West</div>
                    {section.data.map((d, i) => {
                        const pad = 2; 
                        let px = pad + (d.x / xMax) * (100 - pad * 2);
                        let py = pad + (1 - (d.y / yMax)) * (100 - pad * 2);
                        
                        px = Math.max(pad, Math.min(100 - pad, px));
                        py = Math.max(pad, Math.min(100 - pad, py));
                        const colorClass = d.colorClass ? `color-bg-${d.colorClass.replace('color-bg-', '')}` : 'color-bg-teal';

                        const radixR = d.r && d.r > 0 ? d.r : 6;
                        const style = {
                            left: `${px}%`, 
                            top: `${py}%`, 
                            width: `${radixR}px`, 
                            height: `${radixR}px`, 
                            marginTop: `-${radixR/2}px`, 
                            marginLeft: `-${radixR/2}px`
                        };

                        return (
                            <SimpleTooltip key={i} content={d.tooltip || d.label}>
                                <div 
                                    className={`scatter-point ${colorClass}`}
                                    style={style}
                                />
                            </SimpleTooltip>
                        );
                    })}
                </div>
            </div>
        </section>
    );
}
