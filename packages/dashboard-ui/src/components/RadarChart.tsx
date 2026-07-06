import type { RadarChartSection } from '@coderadius/types';
import { SimpleTooltip } from './Tooltip';

export function RadarChart({ section }: { section: RadarChartSection }) {
    const size = 260;
    const center = size / 2;
    const radius = size * 0.38; 

    const data = section.data; 
    const numPoints = data.length;
    if (numPoints === 0) return null;

    const angleStep = (Math.PI * 2) / numPoints;
    const offset = -Math.PI / 2; 

    const ticks = 4;
    const Grids = () => {
        const elements = [];
        for (let i = 1; i <= ticks; i++) {
            const tickRadius = (radius / ticks) * i;
            let points = [];
            for (let j = 0; j < numPoints; j++) {
                const angle = offset + j * angleStep;
                const x = center + Math.cos(angle) * tickRadius;
                const y = center + Math.sin(angle) * tickRadius;
                points.push(`${x},${y}`);
            }
            const opacity = i === ticks ? 0.4 : 0.15;
            elements.push(
                <polygon key={i} points={points.join(' ')} className="radar-grid" strokeOpacity={opacity} />
            );
        }
        return <>{elements}</>;
    };

    const AxesAndLabels = () => {
        const axes = [];
        const labels = [];
        for (let j = 0; j < numPoints; j++) {
            const angle = offset + j * angleStep;
            const x = center + Math.cos(angle) * radius;
            const y = center + Math.sin(angle) * radius;
            axes.push(<line key={`axis-${j}`} x1={center} y1={center} x2={x} y2={y} className="radar-axis" />);

            const labelX = center + Math.cos(angle) * (radius * 1.35);
            const labelY = center + Math.sin(angle) * (radius * 1.25);
            
            let align: 'start' | 'middle' | 'end' = 'middle';
            if (Math.cos(angle) > 0.1) align = 'start';
            else if (Math.cos(angle) < -0.1) align = 'end';

            labels.push(
                <text key={`label-${j}`} x={labelX} y={labelY} className="radar-label" textAnchor={align} dominantBaseline="middle">
                    {data[j].label}
                </text>
            );
        }
        return { axes, labels };
    };

    const { axes, labels } = AxesAndLabels();

    const dataPoints = [];
    const dots = [];
    for (let j = 0; j < numPoints; j++) {
        const angle = offset + j * angleStep;
        const val = Math.max(0, Math.min(100, data[j].percentage));
        const r = (val / 100) * radius;
        const x = center + Math.cos(angle) * r;
        const y = center + Math.sin(angle) * r;
        dataPoints.push(`${x},${y}`);
        
        const colorClass = data[j].colorClass || 'color-bg-cyan';
        dots.push(
            <SimpleTooltip key={`dot-${j}`} content={`${data[j].label}: ${data[j].value}`}>
                <g>
                    <circle cx={x} cy={y} r="3.5" className={`radar-data-dot ${colorClass}`} />
                    <circle cx={x} cy={y} r="14" fill="transparent" style={{ cursor: 'default' }} />
                </g>
            </SimpleTooltip>
        );
    }

    return (
        <div className="dashboard-chart-container stagger-1">
            <div className="chart-header">
                <h3>{section.title}</h3>
                {section.subtitle && <p className="chart-subtitle">{section.subtitle}</p>}
            </div>
            <div className="chart-wrapper radar-wrapper spotlight-card">
                <div className="svg-container-mini">
                    <svg viewBox={`0 0 ${size} ${size}`} className="radar-svg">
                        <g className="radar-background">
                            <Grids />
                            {axes}
                        </g>
                        <g className="radar-data">
                            <polygon points={dataPoints.join(' ')} className="radar-data-poly" />
                            {dots}
                        </g>
                        <g className="radar-labels">{labels}</g>
                    </svg>
                </div>
            </div>
        </div>
    );
}
