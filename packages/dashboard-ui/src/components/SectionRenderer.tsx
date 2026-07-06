import type { DashboardSection } from '@coderadius/types';
import { DataTable } from './DataTable';
import { Histogram } from './Histogram';
import { BarChart } from './BarChart';
import { ExecutiveBriefing } from './ExecutiveBriefing';
import { RadarChart } from './RadarChart';
import { DonutChart } from './DonutChart';
import { ScatterPlot } from './ScatterPlot';
import { SummaryCards } from './SummaryCards';
import { Alerts } from './Alerts';
import { Tree } from './Tree';
import { Leaderboard } from './Leaderboard';
import { Tabs } from './Tabs';
import { Teaser } from './Teaser';
import { SkillConstellation } from './skill-twins/SkillConstellation';
import { SkillClusterCards } from './skill-twins/SkillClusterCards';

/**
 * Default width tier per section type. Reading-tier (960px) for narrative
 * surfaces (briefings, alerts, summary cards); data-tier (1600px) for
 * dashboards (tables, charts, leaderboards). `null` = fluid (no cap), used
 * for `tabs` since each tab body renders its own inner sections that pick
 * their own tier.
 *
 * To override per-instance, wrap the section in the desired tier class at
 * the call site (e.g. inline `<div className="cr-cap-reading">…</div>`).
 */
const TIER_BY_TYPE: Record<string, 'reading' | 'data' | null> = {
    'executive-briefing':      'reading',
    'summary-cards':           'reading',
    'alerts':                  'reading',
    'table':                   'data',
    'tree':                    'data',
    'leaderboard':             'data',
    'histogram':               'data',
    'bar-chart':               'data',
    'donut-chart':             'data',
    'radar-chart':             'data',
    'scatter':                 'data',
    'grid':                    'data',
    'tabs':                    null,   // tabs paint their own inner sections
    'teaser':                  'reading',
    'skill-constellation':     'data',
    'skill-cluster-cards':     'data',
};

function renderInner(section: DashboardSection, idx: number | string) {
    switch (section.type) {
        case 'table':              return <DataTable section={section} secIdx={idx} />;
        case 'histogram':          return <Histogram section={section} />;
        case 'bar-chart':          return <BarChart section={section} />;
        case 'executive-briefing': return <ExecutiveBriefing section={section} />;
        case 'radar-chart':        return <RadarChart section={section} />;
        case 'donut-chart':        return <DonutChart section={section} />;
        case 'scatter':            return <ScatterPlot section={section} />;
        case 'summary-cards':      return <SummaryCards section={section} />;
        case 'alerts':             return <Alerts section={section} />;
        case 'tree':               return <Tree section={section} />;
        case 'leaderboard':        return <Leaderboard section={section} />;
        case 'tabs':               return <Tabs section={section} idx={idx} />;
        case 'teaser':             return <Teaser section={section} />;
        case 'grid':               return <div className={`cr-dashboard-grid cols-${(section as any).columns || 2}`}>{(section as any).sections.map((s: any, i: number) => <SectionRenderer key={i} section={s} idx={`${idx}-g${i}`} />)}</div>;
        case 'skill-constellation': return <SkillConstellation section={section} />;
        case 'skill-cluster-cards': return <SkillClusterCards section={section} />;
        default:                   return <p>Unsupported section type</p>;
    }
}

export const SectionRenderer = ({ section, idx }: { section: DashboardSection; idx: number | string }) => {
    const tier = TIER_BY_TYPE[section.type] ?? null;
    const inner = renderInner(section, idx);
    if (!tier) return inner;
    return <div className={`cr-cap-${tier}`}>{inner}</div>;
};
