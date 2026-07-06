import { DonutChartSection } from "../types";

export function renderDonutChart(section: DonutChartSection): string {
    const size = 180;
    const center = size / 2;
    const strokeWidth = 20;
    const radius = (size - strokeWidth * 2) / 2;
    const circumference = 2 * Math.PI * radius;

    let slicesHtml = '';
    let currentOffset = 0;

    const colors = [
        'color-stroke-teal', 'color-stroke-blue', 'color-stroke-magenta', 
        'color-stroke-yellow', 'color-stroke-green', 'color-stroke-red', 
        'color-stroke-cyan'
    ];

    for (let i = 0; i < section.data.length; i++) {
        const d = section.data[i];
        const sliceLength = (d.percentage / 100) * circumference;
        const colorClass = d.colorClass || colors[i % colors.length];
        
        slicesHtml += `
            <circle 
                class="donut-slice slice-${i} ${colorClass} has-tooltip" 
                data-tooltip="${d.label}: ${d.value} (${d.percentage}%)"
                cx="${center}" cy="${center}" 
                r="${radius}" 
                fill="transparent" 
                stroke-width="${strokeWidth}" 
                stroke-dasharray="${sliceLength} ${circumference}" 
                stroke-dashoffset="${-currentOffset}"
            />`;
        
        currentOffset += sliceLength;
    }

    const centerHtml = section.centerText 
        ? `
            <text x="${center}" y="${center}" class="donut-center-text" text-anchor="middle" dominant-baseline="middle">${section.centerText}</text>
            <text x="${center}" y="${center + 20}" class="donut-center-subtext" text-anchor="middle" dominant-baseline="middle">${section.centerSubText || ''}</text>
          `
        : '';
        
    const legendHtml = section.data.slice(0, 6).map((d: any, i:number) => `
        <div class="donut-legend-item slice-${i}">
            <span class="donut-legend-color ${(d.colorClass || colors[i % colors.length]).replace('color-stroke-', 'color-bg-')}"></span>
            <div class="donut-legend-text-row">
                <span class="donut-legend-label text-truncate">${d.label}</span>
                <span class="donut-legend-val">${d.percentage}%</span>
            </div>
        </div>
    `).join('');

    return `
        <div class="dashboard-half-width stagger-1">
            <div class="chart-header">
                <h3>${section.title}</h3>
                ${section.subtitle ? `<p class="chart-subtitle">${section.subtitle}</p>` : ''}
            </div>
            <div class="chart-wrapper donut-wrapper spotlight-card">
                <div class="donut-layout-row">
                    <div class="svg-container-mini">
                        <svg viewBox="0 0 ${size} ${size}" class="donut-svg">
                            <circle cx="${center}" cy="${center}" r="${radius}" fill="transparent" stroke-width="${strokeWidth}" class="donut-bg" />
                            <g transform="rotate(-90 ${center} ${center})">
                                ${slicesHtml}
                            </g>
                            <g class="donut-center-group">
                                ${centerHtml}
                            </g>
                        </svg>
                    </div>
                    <div class="donut-legend-col">
                        ${legendHtml}
                    </div>
                </div>
            </div>
        </div>
    `;
}
