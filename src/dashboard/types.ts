export interface NavigationConfig {
    items: {
        id: string;          // matches section's navId
        label: string;
        icon?: string;       // lucide icon name
        disabled?: boolean;
        hint?: string;       // tooltip for disabled items
        pageTitle?: string;
        pageSubtitle?: string;
        headerStats?: { label: string; value: string | number; color?: string; tooltip?: string }[];
    }[];
}

export interface DashboardConfig {
    title: string;
    subtitle?: string;
    headerStats?: { label: string; value: string | number; color?: string; tooltip?: string }[];
    generatedAt: string;
    sections: NavigableSection[];
    navigation?: NavigationConfig;
    /**
     * Flat governance evaluations available for the section-level toolbar
     * export. Populated only when `payload.governance` is present.
     */
    governanceEvaluations?: unknown[];
    /**
     * Map ruleId → GovernanceRuleDrawerData. Used by the Compliance drawer
     * to open a secondary rule-detail drawer when a violation/passing-rule
     * card is clicked.
     */
    governanceRuleDrawerById?: Record<string, unknown>;
}

export type NavigableSection = DashboardSection & { navId?: string; navLabel?: string };

export type DashboardSection =
    | SummaryCardsSection
    | HistogramSection
    | TableSection
    | LeaderboardSection
    | TreeSection
    | AlertsSection
    | TabsSection
    | BarChartSection
    | ScatterSection
    | ExecutiveBriefingSection
    | RadarChartSection
    | DonutChartSection
    | GridSection
    | TeaserSection
    | SkillConstellationSection
    | SkillClusterCardsSection;

/**
 * Empty-state page for an architectural domain that was deliberately excluded
 * from the current dashboard build (e.g. when `cr ui --focus` is set). Renders
 * a confident, marketing-grade placeholder explaining what the domain
 * surfaces in a full assessment.
 */
export interface TeaserSection {
    type: 'teaser';
    /** Page-level title (e.g. "Blast Radius Explorer"). */
    title: string;
    /** Short one-line headline rendered under the title in accent color. */
    tagline: string;
    /** Body paragraph explaining the domain's value. */
    body: string;
    /** Optional bullets for the "what you'd see" section. */
    bullets?: string[];
    /** Footer line, typically a call-to-action. */
    footer?: string;
}

export interface GridSection {
    type: 'grid';
    columns?: number;
    sections: DashboardSection[];
}

export interface SummaryCardsSection {
    type: 'summary-cards';
    cards: {
        label: string;
        value: string | number;
        color?: 'teal' | 'red' | 'yellow' | 'green' | 'blue';
    }[];
}

export interface HistogramSection {
    type: 'histogram';
    title: string;
    subtitle?: string;
    data: {
        label: string;
        value: number;
        percentage: number;
        colorClass?: string; // e.g. 'color-red', mapped to CSS vars in template
        tooltip?: string;
    }[];
}

export interface BarChartSection {
    type: 'bar-chart';
    title: string;
    subtitle?: string;
    data: {
        label: string;
        value: number;
        percentage: number;
        colorClass?: string;
        tooltip?: string;
    }[];
}

export interface ScatterSection {
    type: 'scatter';
    title: string;
    subtitle?: string;
    data: {
        label: string;
        x: number;
        y: number;
        r?: number;
        colorClass?: string;
        tooltip?: string;
    }[];
    xAxisLabel?: string;
    yAxisLabel?: string;
    xMax?: number;
    yMax?: number;
}

export interface BriefingSegment {
    text: string;
    highlight?: boolean;
}

export interface ExecutiveBriefingSection {
    type: 'executive-briefing';
    title: string;
    briefs: {
        icon: string;
        label: string;
        text?: string;
        segments?: BriefingSegment[];
    }[];
}

export interface RadarChartSection {
    type: 'radar-chart';
    title: string;
    subtitle?: string;
    data: {
        label: string;
        value: number;
        percentage: number;
        colorClass?: string;
    }[];
}

export interface DonutChartSection {
    type: 'donut-chart';
    title: string;
    subtitle?: string;
    centerText?: string;
    centerSubText?: string;
    data: {
        label: string;
        value: number;
        percentage: number;
        colorClass?: string;
    }[];
}

export interface TableColumnDef {
    label: string;
    meta?: {
        overflowAction?: 'collapse' | 'scroll' | 'truncate';
        maxHeightRem?: number;
        width?: string;
        maxWidth?: string;
        filter?: boolean;
        /** Filter input mode: 'text' (checkbox facets, default) or 'semver' (range query input) */
        filterMode?: 'text' | 'semver';
        /** Prevent text wrapping; renders cell in monospace (for IDs, slugs, etc.) */
        nowrap?: boolean;
        /** Long-form description shown on header hover. Use to explain what's being counted. */
        tooltip?: string;
    };
}

export interface TableSection {
    type: 'table';
    title: string;
    subtitle?: string;
    headerStats?: { label: string; value: string | number; color?: string; tooltip?: string }[];
    headers: (string | TableColumnDef)[];
    rows: (TableCell[] | TableRow)[];
    initialSorting?: { id: string; desc: boolean }[];
    /**
     * Per-table overrides. Currently supports hiding the inline Export CSV
     * button on tables that delegate export to a section-level toolbar (e.g.
     * the governance tab, which exposes a single flat-CSV download).
     */
    tableOptions?: { hideExport?: boolean };
}

export interface TableRow {
    id?: string;
    cells: TableCell[];
    subRows?: TableRow[];
    /** Opaque payload surfaced when a row is clicked (e.g. for side-drawer detail panels). */
    drawerData?: Record<string, unknown>;
    /**
     * Canonical URN to deep-link into the Blast Radius Explorer. When set,
     * the table renders a Blast Radius action button on row hover next to
     * the "Open details" affordance.
     */
    blastRadiusUrn?: string;
}

export interface TableCellLink {
    url: string;
    external?: boolean;
}

export interface TableCellItem {
    text: string;
    url?: string;
    /** Optional inline badge (e.g. version number) displayed after the item text */
    badge?: { text: string; color: 'red' | 'yellow' | 'green' | 'cyan' | 'dim' | 'blue' | 'magenta' };
    /** Optional small colored dot rendered before the item text (liveness/status indicator) */
    pulseDot?: { color: 'green' | 'cyan' | 'yellow' | 'dim'; tooltip?: string };
    /** Optional contextual text rendered below the item (e.g. ↳ repository_name) */
    subtitle?: string;
    /** Optional repo context prefix for generic names — renders as "context / name" inline tokenization */
    qualifiedContext?: string;
}

export interface TableCell {
    text: string;
    subtitle?: string;
    /** Renders subtitle as a clickable link */
    subtitleLink?: TableCellLink;
    title?: string;
    tooltip?: string;
    color?: 'red' | 'yellow' | 'green' | 'cyan' | 'dim' | 'blue' | 'magenta' | 'teal';
    sortValue?: number | string;
    badges?: { text: string; color: 'red' | 'yellow' | 'green' | 'cyan' | 'dim' | 'blue' | 'magenta'; pulse?: boolean; tooltip?: string }[];
    /** Renders text as a clickable link */
    link?: TableCellLink;
    /** Applies text truncation (true = 1 line, 2 = 2 lines) */
    truncate?: boolean | number;
    /** List of items rendered as inline chips (consumers, repos, etc.) */
    items?: TableCellItem[];
    /** Support for multiple colored segments in a single cell */
    segments?: { text: string; color?: 'red' | 'yellow' | 'green' | 'cyan' | 'dim' | 'blue' | 'magenta' | 'teal'; tooltip?: string }[];
    /** Segmented horizontal bar for adoption/drift visualization (Internal Registry) */
    bar?: { color: 'green' | 'yellow' | 'red' | 'dim'; pct: number; label?: string }[];
    /** A vertical elegant checklist for structured validations */
    checklist?: { label: string; status: 'pass' | 'fail' | 'warn'; hint?: string }[];
    /** Explicit values to include in the filter dropdown. Overrides default extraction if set. */
    filterValues?: string[];
    /** Additional hidden text to include in full text global search. */
    searchValue?: string;
    /**
     * Click-anchored detail popover. When present and `items.length > 0`, the
     * cell text renders as a clickable button that opens a side-anchored list
     * popover. Use for count cells where the names don't fit inline (e.g.
     * Rules / Skills / Wflows / Agents in the Maturity Matrix).
     */
    popover?: {
        title: string;
        items: { text: string; subtitle?: string; url?: string }[];
    };
}

export interface LeaderboardSection {
    type: 'leaderboard';
    title: string;
    items: {
        title: string;
        subtitle?: string;
        nodeType?: string;
        urn?: string;
        score: number; // 0-100
        metrics: { label: string; value: string | number; highlight?: boolean }[];
        teams?: string[];
        repository?: { name: string; url?: string | null };
        writeServices?: string[];
        readServices?: string[];
        dependentServices?: string[];
    }[];
}

export interface TreeSection {
    type: 'tree';
    title: string;
    nodes: TreeNode[];
}

export interface TreeNode {
    label: string;
    badges?: { text: string; color: 'dim' | 'green' | 'blue' | 'magenta' | 'yellow' }[];
    meta?: string[];
    children?: TreeNode[];
    isFunction?: boolean;
}

export interface AlertsSection {
    type: 'alerts';
    title: string;
    alerts: {
        type: 'warning' | 'error' | 'info';
        title: string;
        message: string;
        category?: string;
        items?: (string | { text: string; url?: string; external?: boolean })[];
    }[];
}

export interface TabsSection {
    type: 'tabs';
    tabs: {
        id: string;      // Unique identifier
        label: string;
        sections: Exclude<DashboardSection, TabsSection>[]; // Prevents infinite recursion of tabs-in-tabs
    }[];
}

/**
 * 2D constellation of skill embeddings projected via UMAP. Each point is one
 * AgenticConfig of configType='skill'; clustered points share a clusterId so
 * the UI can colour them with a single accent shade.
 */
export interface SkillConstellationSection {
    type: 'skill-constellation';
    title?: string;
    subtitle?: string;
    threshold: number;
    points: {
        configId: string;
        name: string;       // skill name for tooltip
        service: string;    // repo/service for tooltip
        x: number;
        y: number;
        clusterId: string | null;
    }[];
    clusterMeta: {
        id: string;
        label: string;
        size: number;
        similarityAvg: number;
    }[];
}

/**
 * Cards listing groups of semantically near-identical skills across repos.
 * Each card shows the cluster's dominant theme, similarity stats, and a
 * side-by-side view of every member (skill name, description, service).
 */
export interface SkillClusterCardsSection {
    type: 'skill-cluster-cards';
    title?: string;
    clusters: {
        id: string;
        label: string;
        size: number;
        similarity: { min: number; max: number; avg: number };
        services: string[];
        topics: string[];
        technologies: string[];
        members: {
            configId: string;
            name: string;
            description: string;
            semanticIntent?: string;
            filePath: string;
            service: string;
            topics: string[];
            technologies: string[];
        }[];
    }[];
}
