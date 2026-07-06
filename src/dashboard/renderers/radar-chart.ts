import { RadarChartSection } from "../types";

export function renderRadarChart(section: RadarChartSection): string {
    const size = 260;
    const center = size / 2;
    const radius = size * 0.38; 

    const data = section.data; 
    const numPoints = data.length;
    if (numPoints === 0) return '';

    const angleStep = (Math.PI * 2) / numPoints;
    const offset = -Math.PI / 2; 

    let gridHtml = '';
    const ticks = 4;
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
        gridHtml += `<polygon points="${points.join(' ')}" class="radar-grid" stroke-opacity="${opacity}" />`;
    }

    let axesHtml = '';
    let labelsHtml = '';
    for (let j = 0; j < numPoints; j++) {
        const angle = offset + j * angleStep;
        const x = center + Math.cos(angle) * radius;
        const y = center + Math.sin(angle) * radius;
        axesHtml += `<line x1="${center}" y1="${center}" x2="${x}" y2="${y}" class="radar-axis" />`;

        const labelX = center + Math.cos(angle) * (radius * 1.35);
        const labelY = center + Math.sin(angle) * (radius * 1.25);
        
        let align = 'middle';
        if (Math.cos(angle) > 0.1) align = 'start';
        else if (Math.cos(angle) < -0.1) align = 'end';

        labelsHtml += `<text x="${labelX}" y="${labelY}" class="radar-label" text-anchor="${align}" dominant-baseline="middle">${data[j].label}</text>`;
    }

    let dataPoints = [];
    let dotHtml = '';
    for (let j = 0; j < numPoints; j++) {
        const angle = offset + j * angleStep;
        const val = Math.max(0, Math.min(100, data[j].percentage));
        const r = (val / 100) * radius;
        const x = center + Math.cos(angle) * r;
        const y = center + Math.sin(angle) * r;
        dataPoints.push(`${x},${y}`);
        
        const colorClass = data[j].colorClass || 'color-bg-cyan';
        dotHtml += `
            <circle cx="${x}" cy="${y}" r="3.5" class="radar-data-dot ${colorClass}" />
            <circle cx="${x}" cy="${y}" r="14" fill="transparent" class="has-tooltip" data-tooltip="${data[j].label}: ${data[j].value}" />
        `;
    }
    
    const polygonHtml = `<polygon points="${dataPoints.join(' ')}" class="radar-data-poly" />`;

    return `
        <div class="dashboard-half-width stagger-1">
            <div class="chart-header">
                <h3>${section.title}</h3>
                ${section.subtitle ? `<p class="chart-subtitle">${section.subtitle}</p>` : ''}
            </div>
            <div class="chart-wrapper radar-wrapper spotlight-card">
                <div class="svg-container-mini">
                    <svg viewBox="0 0 ${size} ${size}" class="radar-svg">
                        <g class="radar-background">${gridHtml}${axesHtml}</g>
                        <g class="radar-data">${polygonHtml}${dotHtml}</g>
                        <g class="radar-labels">${labelsHtml}</g>
                    </svg>
                </div>
            </div>
        </div>
    `;
}
