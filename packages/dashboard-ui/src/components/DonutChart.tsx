import type { DonutChartSection } from '@coderadius/types';
import { SimpleTooltip } from './Tooltip';

export function DonutChart({ section }: { section: DonutChartSection }) {
    const size = 180;
    const center = size / 2;
    const strokeWidth = 20;
    const radius = (size - strokeWidth * 2) / 2;
    const circumference = 2 * Math.PI * radius;

    let currentOffset = 0;

    const colors = [
        'color-stroke-teal', 'color-stroke-blue', 'color-stroke-magenta', 
        'color-stroke-yellow', 'color-stroke-green', 'color-stroke-red', 
        'color-stroke-cyan'
    ];

    return (
        <div className="dashboard-chart-container stagger-1">
            <div className="chart-header">
                <h3>{section.title}</h3>
                {section.subtitle && <p className="chart-subtitle">{section.subtitle}</p>}
            </div>
            <div className="chart-wrapper donut-wrapper spotlight-card">
                <div className="donut-layout-row">
                    <div className="svg-container-mini">
                        <svg viewBox={`0 0 ${size} ${size}`} className="donut-svg">
                            <circle cx={center} cy={center} r={radius} fill="transparent" strokeWidth={strokeWidth} className="donut-bg" />
                            <g transform={`rotate(-90 ${center} ${center})`}>
                                {section.data.map((d, i) => {
                                    const sliceLength = (d.percentage / 100) * circumference;
                                    const colorClass = d.colorClass || colors[i % colors.length];
                                    const sliceOffset = -currentOffset;
                                    currentOffset += sliceLength;
                                    return (
                                        <SimpleTooltip key={i} content={`${d.label}: ${d.value} (${d.percentage}%)`}>
                                            <circle 
                                                className={`donut-slice slice-${i} ${colorClass}`} 
                                                cx={center} cy={center} 
                                                r={radius} 
                                                fill="transparent" 
                                                strokeWidth={strokeWidth} 
                                                strokeDasharray={`${sliceLength} ${circumference}`} 
                                                strokeDashoffset={sliceOffset}
                                            />
                                        </SimpleTooltip>
                                    );
                                })}
                            </g>
                            <g className="donut-center-group">
                                {section.centerText && (
                                    <>
                                        <text x={center} y={center} className="donut-center-text" textAnchor="middle" dominantBaseline="middle">
                                            {section.centerText}
                                        </text>
                                        <text x={center} y={center + 20} className="donut-center-subtext" textAnchor="middle" dominantBaseline="middle">
                                            {section.centerSubText || ''}
                                        </text>
                                    </>
                                )}
                            </g>
                        </svg>
                    </div>
                    <div className="donut-legend-col">
                        {section.data.slice(0, 6).map((d, i) => (
                            <div key={i} className={`donut-legend-item slice-${i}`}>
                                <span className={`donut-legend-color ${(d.colorClass || colors[i % colors.length]).replace('color-stroke-', 'color-bg-')}`}></span>
                                <div className="donut-legend-text-row">
                                    <span className="donut-legend-label text-truncate">{d.label}</span>
                                    <span className="donut-legend-val">{d.percentage}%</span>
                                </div>
                            </div>
                        ))}
                    </div>
                </div>
            </div>
        </div>
    );
}
