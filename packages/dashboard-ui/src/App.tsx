import { useEffect, useMemo, useState, useCallback } from 'react';
import type { DashboardPayload, RadiusDashboardPayload } from '@coderadius/shared-types';
import { isBlastDashboard, isLineageDashboard, isRadiusDashboard } from '@coderadius/shared-types';
import type { DashboardConfig, NavigationConfig } from '@coderadius/types';
import { transformRadar, transformDeps, transformGravity, transformLineage, transformInventory, transformGovernance } from './transformers';
import * as LucideIcons from 'lucide-react';
import { SectionRenderer } from './components/SectionRenderer';
import { Sidebar } from './components/Sidebar';
import { BlastRadiusExplorer } from './components/blast-radius/BlastRadiusExplorer';
import { SystemRegistryView } from './components/system-registry/SystemRegistryView';
import { PackageRegistryView } from './components/package-registry/PackageRegistryView';
import { SimpleTooltip } from './components/Tooltip';
import { RegistryDrawer } from './components/RegistryDrawer';
import type { RegistryDrawerData } from './components/RegistryDrawer';
import { RegistryDrawerContext } from './components/RegistryDrawerContext';
import { GovernanceDrawer } from './components/GovernanceDrawer';
import type { GovernanceDrawerData } from './components/GovernanceDrawer';
import type { FlatEvaluationRow } from './transformers/governance.transformer';
import { GovernanceView } from './components/governance/GovernanceView';
import { GlobalSearchProvider, GlobalSearchPalette, SearchTriggerButton, useGlobalSearch } from './components/global-search';
import { PageTopBar } from './components/design-system';

import { StatusBar, StatusBarSep, StatusBarDot, StatusBarOk, PageIdentityStrip, ToggleGroup } from './components/design-system';
import { GravityView } from './components/GravityView';
import { AgentHarnessView } from './components/agent-harness/AgentHarnessView';
import { isGraphViewEnabled } from './lib/flags';
import { useResponsiveSidebar } from './lib/use-responsive-sidebar';
import { OrgFilterProvider } from './data/OrgFilterContext';
import { DataSourceProvider, useInventory } from './data/DataSourceProvider';
import { StaticPayloadDataSource } from './data/StaticPayloadDataSource';
import { OrganizationSwitcher } from './components/OrganizationSwitcher';

// ─── Teaser catalog ─────────────────────────────────────────────────────────
//
// Rendered for standard domains intentionally excluded from a `cr ui
// --focus a,b` build. Each entry is a (navItem, TeaserSection) pair: the nav
// item keeps the tab visible in the sidebar; the section is the page-level
// empty-state copy that explains the domain's value in a full ingestion.
//
// Copy convention: present tense, no exclamation marks, no marketing
// adjectives ("powerful", "intelligent", etc.). Confident, restrained,
// product-page voice. Each bullet describes a concrete deliverable, not a
// promise.
const TEASER_CATALOG: ReadonlyArray<{
    navItem: NavigationConfig['items'][number];
    section: {
        type: 'teaser';
        title: string;
        tagline: string;
        body: string;
        bullets?: string[];
        footer?: string;
    };
}> = [
    {
        navItem: {
            id: '__blast-radius__',
            label: 'Blast Radius Explorer',
            icon: 'Target',
            pageTitle: 'Blast Radius Explorer',
            pageSubtitle: 'Cross-service impact analysis, pre-merge.',
            headerStats: [],
        },
        section: {
            type: 'teaser',
            title: 'Blast Radius Explorer',
            tagline: 'Cross-service dependency map with pre-merge impact analysis.',
            body: 'Every cross-service dependency mapped: API contracts, databases, message channels. Trace any code change to downstream consumers. Ships as MCP server for AI coding agents.',
            bullets: [
                'Cross-service dependency graph',
                'Pre-merge impact preview: affected services and teams',
                'MCP server for Claude, Cursor, Cline',
            ],
            footer: 'Not in this build. Free to try on your repos, just ask.',
        },
    },
    {
        navItem: {
            id: 'agent-harness',
            label: 'Agent Harness',
            icon: 'Sparkles',
            pageTitle: 'Agent Harness',
            pageSubtitle: 'AI tooling inventory and maturity scoring.',
            headerStats: [],
        },
        section: {
            type: 'teaser',
            title: 'Agent Harness',
            tagline: 'AI tooling inventory, classified and scored.',
            body: 'Every AI artifact cataloged: AGENTS.md, Cursor rules, MCP servers, Claude skills. Repository maturity from L0 Dark to L4 Augmented. Cross-team drift surfaced.',
            bullets: [
                'AI artifact catalog per repository',
                'Maturity scoring (L0 Dark to L4 Augmented)',
                'Cross-team drift detection',
            ],
            footer: 'Not in this build. Free to try on your repos, just ask.',
        },
    },
    {
        navItem: {
            id: 'gravity',
            label: 'SPOFs',
            icon: 'Flame',
            pageTitle: 'Architectural Gravity',
            pageSubtitle: 'Services ranked by failure cascade potential.',
            headerStats: [],
        },
        section: {
            type: 'teaser',
            title: 'Architectural Gravity',
            tagline: 'Services ranked by failure cascade potential.',
            body: 'Dependency-weighted service ranking. Bottleneck detection across the call graph. Concentration quantified for reliability investment.',
            bullets: [
                'Services ranked by reverse-dependency count',
                'Bottleneck detection across the call graph',
                'Concentration metrics for deload planning',
            ],
            footer: 'Not in this build. Free to try on your repos, just ask.',
        },
    },
    {
        navItem: {
            id: 'deps',
            label: 'Package Intelligence',
            icon: 'Package',
            pageTitle: 'Package Intelligence',
            pageSubtitle: 'Cross-org package inventory and version governance.',
            headerStats: [],
        },
        section: {
            type: 'teaser',
            title: 'Package Intelligence',
            tagline: 'Cross-org package intelligence, in context.',
            body: 'npm, Composer, Go modules, PyPI: unified inventory. Version drift per package, abandoned forks flagged. Dependencies clustered for coordinated upgrades.',
            bullets: [
                'Unified inventory across package ecosystems',
                'Version drift heatmap per team and package',
                'Upgrade plans grouped by dependency cluster',
                'CVE cross-reference per dependency version',
            ],
            footer: 'Not in this build. Free to try on your repos, just ask.',
        },
    },
];

// ─── Payload → Display Model ────────────────────────────────────────────────

function buildDashboardConfig(payload: DashboardPayload): DashboardConfig {
    // Note: isBlastDashboard is handled separately in the App component directly
    // to render the premium BlastExplorer instead of the generic Tree transformer.

    if (isLineageDashboard(payload)) {
        return transformLineage(payload.lineage);
    }

    const p = payload as RadiusDashboardPayload;
    const sections: any[] = [];
    const headerStats: { label: string; value: string | number; color?: string }[] = [];
    const navItems: NavigationConfig['items'] = [];
    let governanceEvaluations: unknown[] | undefined;
    let governanceRuleDrawerById: Record<string, unknown> | undefined;

    // System Registry: auto-generated service catalog (1st, default tab)
    if (p.inventory) {
        const inv = transformInventory(p.inventory);
        navItems.push(inv.navItem);
        headerStats.push(...inv.headerStats);
    }

    // Governance: policy compliance (2nd tab)
    if (p.governance) {
        const gov = transformGovernance(p.governance);
        sections.push(...gov.sections);
        navItems.push(gov.navItem);
        headerStats.push(...gov.headerStats);
        governanceEvaluations = gov.evaluations;
        governanceRuleDrawerById = gov.ruleDrawerById;
    }

    // Blast Radius Explorer: interactive topology tab (3rd)
    if (p.topology) {
        navItems.push({
            id: '__blast-radius__',
            label: 'Blast Radius Explorer',
            icon: 'Target',
            pageTitle: 'Blast Radius Explorer',
            pageSubtitle: 'Navigate architectural risk: who depends on what, and where the blast goes',
            headerStats: [] // Override global fallback to hide irrelevant metrics
        });
    }

    // Agentic Radar (3rd)
    if (p.radar) {
        const r = transformRadar(p.radar);
        sections.push(...r.sections);
        navItems.push(r.navItem);
        headerStats.push(...r.headerStats);
    }

    // SPOFs: Architecture Gravity (4th)
    if (p.gravity) {
        const g = transformGravity(p.gravity);
        sections.push(...g.sections);
        navItems.push(g.navItem);
        headerStats.push(...g.headerStats);
    }

    // Package Intelligence (5th)
    if (p.deps) {
        const d = transformDeps();
        navItems.push(d.navItem);
        headerStats.push(...d.headerStats);
    }

    // ── Multi-focus mode: inject teaser placeholders for excluded domains ──
    //
    // When `cr ui --focus a,b` narrows the assessment to two or more domains,
    // the remaining standard domains still appear in the sidebar so the
    // demo audience sees the full product surface. Each missing tab renders
    // a Teaser page describing what the full ingestion would unlock.
    const focusList = (p.focus ?? '')
        .split(',')
        .map(s => s.trim())
        .filter(Boolean);
    const isMultiFocus = focusList.length >= 2;
    if (isMultiFocus) {
        const presentIds = new Set(navItems.map(n => n.id));
        for (const teaser of TEASER_CATALOG) {
            if (presentIds.has(teaser.navItem.id)) continue;
            navItems.push(teaser.navItem);
            sections.push({ ...teaser.section, navId: teaser.navItem.id } as any);
        }
    }

    // Focus mode: suppress sidebar when only one domain is present
    if (p.focus && navItems.length === 1) {
        const focusNav = navItems[0];
        return {
            title: focusNav.pageTitle || `Architecture (${p.focus})`,
            subtitle: focusNav.pageSubtitle,
            headerStats: focusNav.headerStats || headerStats,
            generatedAt: p.generatedAt,
            sections,
            governanceEvaluations,
            governanceRuleDrawerById,
        };
    }

    return {
        title: 'Architecture Dashboard',
        headerStats,
        generatedAt: p.generatedAt,
        navigation: { items: navItems },
        sections,
        governanceEvaluations,
        governanceRuleDrawerById,
    };
}

// ─── Blast Shell ── standalone page wrapper for blast payloads ─────────────

import type { BlastDashboardPayload } from '@coderadius/shared-types';

function BlastShellInner({ payload }: { payload: BlastDashboardPayload }) {
    payload.blast;
    const [isSidebarCollapsed, setIsSidebarCollapsed] = useResponsiveSidebar();



    // Dummy navigation for standalone reports
    const dummyNav: NavigationConfig = {
        items: [{
            id: 'blast',
            label: 'Blast Report',
            icon: 'Target',
            pageTitle: 'Blast Radius Explorer'
        }]
    };

    return (
        <div className="cr-app-layout">
            <Sidebar
                navigation={dummyNav}
                activeNavId="blast"
                onNavChange={() => { }}
                isCollapsed={isSidebarCollapsed}
                onToggleCollapse={() => setIsSidebarCollapsed(!isSidebarCollapsed)}
                cliVersion={payload.cliVersion}
                generatedAt={payload.generatedAt}
            />
            <div className="cr-main-pane">
                <PageTopBar title="Blast Radius Explorer">
                    <SearchTriggerButton />
                </PageTopBar>
                <main className="container" style={{ paddingBottom: '48px', flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
                    <p style={{ color: 'var(--muted)', padding: '48px 0', textAlign: 'center', fontSize: '13px' }}>
                        This report was generated with an older CLI version that pre-computed a single-target blast radius.<br />
                        Run <code>cr dashboard</code> to get the interactive topology explorer.
                    </p>
                </main>
            </div>
        </div>
    );
}

function BlastShell({ payload }: { payload: BlastDashboardPayload }) {
    return (
        <GlobalSearchProvider>
            <GlobalSearchPalette />
            <BlastShellInner payload={payload} />
        </GlobalSearchProvider>
    );
}

// ─── View Toggle ────────────────────────────────────────────────────────────

const VIEW_TOGGLE_OPTIONS: import('./components/design-system').ToggleGroupOption<'graph' | 'list'>[] = [
    {
        value: 'graph',
        label: <><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="5" cy="5" r="2"/><circle cx="19" cy="5" r="2"/><circle cx="5" cy="19" r="2"/><circle cx="19" cy="19" r="2"/><path d="M5 7v10"/><path d="M7 5h10"/><path d="M7 19h10"/><path d="M19 7v10"/></svg> Graph</>,
    },
    {
        value: 'list',
        label: <><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect width="7" height="7" x="3" y="3" rx="1"/><rect width="7" height="7" x="14" y="3" rx="1"/><rect width="7" height="7" x="14" y="14" rx="1"/><rect width="7" height="7" x="3" y="14" rx="1"/></svg> List</>,
    },
];

function ViewToggle({ viewMode, onSwitch }: { viewMode: 'graph' | 'list'; onSwitch: (m: 'graph' | 'list') => void }) {
    return <ToggleGroup options={VIEW_TOGGLE_OPTIONS} value={viewMode} onChange={onSwitch} size="sm" />;
}

// ─── App Component ──────────────────────────────────────────────────────────

function AppInner({ data: payload }: { data: DashboardPayload }) {
    // Memoize the transformation so it only runs once
    const data = useMemo(() => buildDashboardConfig(payload), [payload]);

    const [activeNavId, setActiveNavId] = useState<string>(() => {
        const hash = window.location.hash;
        if (hash.startsWith('#blast:')) return '__blast-radius__';
        if (hash.startsWith('#nav:')) return hash.replace('#nav:', '');
        return data.navigation?.items[0]?.id || '';
    });
    const [viewMode, setViewMode] = useState<'graph' | 'list'>('graph');
    const [hasBlastTarget, setHasBlastTarget] = useState(() => window.location.hash.startsWith('#blast:'));
    const [isSidebarCollapsed, setIsSidebarCollapsed] = useResponsiveSidebar();
    const [registryDrawer, setRegistryDrawer] = useState<RegistryDrawerData | null>(null);
    const [registryDrawerRowId, setRegistryDrawerRowId] = useState<string | undefined>(undefined);
    const [governanceDrawer, setGovernanceDrawer] = useState<GovernanceDrawerData | null>(null);
    const [governanceDrawerRowId, setGovernanceDrawerRowId] = useState<string | undefined>(undefined);

    // Org-scoped inventory (filtered by the global OrganizationSwitcher). With no
    // org selected this is the identity filter, so behaviour is unchanged.
    const inventory = useInventory();

    // ── Global search: register topology + navigation handler ──────────────────
    // Topology is read from the payload so it's available from ANY tab, not just
    // when BlastRadiusExplorer is mounted. The select handler updates the hash +
    // switches to the blast tab; BlastRadiusExplorer's own hashchange listener
    // picks up the target URN without needing a separate callback registration.
    const { registerSelectHandler, setTopology } = useGlobalSearch();
    useEffect(() => {
        setTopology(isRadiusDashboard(payload) && payload.topology ? payload.topology : null);
        const unregister = registerSelectHandler((urn) => {
            window.location.hash = `blast:${urn}`;
            setActiveNavId('__blast-radius__');
            setHasBlastTarget(true);
        });
        return () => { setTopology(null); unregister(); };
    // payload is stable (static config loaded once — setters are stable too)
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [payload]);

    const handleRegistryRowClick = useCallback((rawData: RegistryDrawerData | Record<string, unknown>) => {
        const data = rawData as unknown as RegistryDrawerData;
        const rowId = rawData['_rowId'] as string | undefined;
        // Toggle: clicking the same row again closes the drawer
        setRegistryDrawerRowId(prev => {
            const next = prev === rowId ? undefined : rowId;
            setRegistryDrawer(next ? data : null);
            return next;
        });
    }, []);

    const handleRegistryDrawerClose = useCallback(() => {
        setRegistryDrawer(null);
        setRegistryDrawerRowId(undefined);
    }, []);

    const handleGovernanceRowClick = useCallback((rawData: Record<string, unknown>) => {
        const data = rawData as unknown as GovernanceDrawerData;
        const rowId = rawData['_rowId'] as string | undefined;
        // Toggle: clicking the same row again closes the drawer
        setGovernanceDrawerRowId(prev => {
            const next = prev === rowId ? undefined : rowId;
            setGovernanceDrawer(next ? data : null);
            return next;
        });
    }, []);

    const handleGovernanceDrawerClose = useCallback(() => {
        setGovernanceDrawer(null);
        setGovernanceDrawerRowId(undefined);
    }, []);

    // Close drawers when navigating away
    useEffect(() => {
        if (activeNavId !== 'inventory') {
            setRegistryDrawer(null);
            setRegistryDrawerRowId(undefined);
        }
        if (activeNavId !== 'governance') {
            setGovernanceDrawer(null);
            setGovernanceDrawerRowId(undefined);
        }
    }, [activeNavId]);

    useEffect(() => {
        const handleHashChange = () => {
            const hash = window.location.hash;
            if (hash.startsWith('#blast:')) {
                setActiveNavId('__blast-radius__');
                setHasBlastTarget(true);
            } else if (hash.startsWith('#nav:')) {
                const navPart = hash.replace('#nav:', '');
                const [navId] = navPart.split('?');
                setActiveNavId(navId);
                setHasBlastTarget(false);
            } else if (!hash) {
                setHasBlastTarget(false);
                if (data.navigation?.items[0]?.id) {
                    setActiveNavId(data.navigation.items[0].id);
                }
            }
        };
        window.addEventListener('hashchange', handleHashChange);
        return () => window.removeEventListener('hashchange', handleHashChange);
    }, [data.navigation]);

    const handleNavChange = (id: string) => {
        window.location.hash = `nav:${id}`;
        setActiveNavId(id);
    };

    useEffect(() => {
        const handleMouseMove = (e: MouseEvent) => {
            const target = (e.target as HTMLElement).closest('.spotlight-card') as HTMLElement | null;
            if (!target) return;
            const rect = target.getBoundingClientRect();
            target.style.setProperty('--mouse-x', `${e.clientX - rect.left}px`);
            target.style.setProperty('--mouse-y', `${e.clientY - rect.top}px`);
        };

        window.addEventListener('mousemove', handleMouseMove);
        return () => window.removeEventListener('mousemove', handleMouseMove);
    }, []);

    useEffect(() => {
        const activeItem = data.navigation?.items.find(i => i.id === activeNavId);
        const pageTitle = activeItem?.pageTitle || data.title;
        document.title = `${pageTitle} · CodeRadius`;
    }, [activeNavId, data.navigation, data.title]);



    const visibleSections = data.navigation
        ? data.sections.filter((sec: any) => sec.navId === activeNavId)
        : data.sections;

    const activeNavItem = data.navigation?.items.find(i => i.id === activeNavId);

    const reposCount = isRadiusDashboard(payload) && payload.inventory?.summary.totalRepos
        ? payload.inventory.summary.totalRepos
        : undefined;

    if (data.navigation) {
        const displayTitle = activeNavItem?.pageTitle || data.title;
        const displaySubtitle = activeNavItem?.pageSubtitle || data.subtitle;
        const displayStats = activeNavItem?.headerStats || data.headerStats;
        const isBlastPage = activeNavId === '__blast-radius__';
        const isGravityPage = activeNavId === 'gravity' && isRadiusDashboard(payload) && !!payload.gravity;
        const isRegistryPage = activeNavId === 'inventory' && isRadiusDashboard(payload) && !!payload.inventory;
        const isPackageRegistryPage = activeNavId === 'deps' && isRadiusDashboard(payload) && !!payload.deps;
        const isAgentHarnessPage = activeNavId === 'agent-harness' && isRadiusDashboard(payload) && !!payload.radar;
        const isGovernancePage = activeNavId === 'governance' && isRadiusDashboard(payload) && !!payload.governance;
        const isOperatorSurface = isRegistryPage || isPackageRegistryPage || isGovernancePage;

        let badge: { type: 'experimental', label: string } | null = null;
        if (displayTitle === 'SPOFs') {
            badge = { type: 'experimental', label: 'Experimental' };
        }

        return (
            <div className="cr-app-layout">
                <Sidebar
                    navigation={data.navigation}
                    activeNavId={activeNavId}
                    onNavChange={handleNavChange}
                    isCollapsed={isSidebarCollapsed}
                    onToggleCollapse={() => setIsSidebarCollapsed(!isSidebarCollapsed)}
                    cliVersion={payload.cliVersion}
                    generatedAt={payload.generatedAt}
                    reposCount={reposCount}
                />
                <div className="cr-main-pane">
                    <PageTopBar title={displayTitle} badge={badge ?? undefined} leading={<OrganizationSwitcher />}>
                        {isBlastPage && hasBlastTarget && isGraphViewEnabled() && (
                            <ViewToggle viewMode={viewMode} onSwitch={setViewMode} />
                        )}
                        <SearchTriggerButton />
                    </PageTopBar>

                    <main
                        className={`container${isBlastPage ? ' cr-main-blast' : (isOperatorSurface || isGravityPage || isAgentHarnessPage) ? ' cr-main-registry' : ''}${isPackageRegistryPage ? ' cr-main-package-registry' : ''}`}
                        style={{ paddingBottom: 0, flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0 }}
                    >
                        {activeNavId === '__blast-radius__' && isRadiusDashboard(payload) && payload.topology ? (
                            <BlastRadiusExplorer
                                topology={payload.topology}
                                viewMode={viewMode}
                                onSwitchView={setViewMode}
                                meta={{ cliVersion: payload.cliVersion, generatedAt: payload.generatedAt }}
                            />
                        ) : isRegistryPage && isRadiusDashboard(payload) && payload.inventory ? (
                            <RegistryDrawerContext.Provider value={{
                                onRowClick: handleRegistryRowClick,
                                selectedRowId: registryDrawerRowId,
                            }}>
                                <SystemRegistryView
                                    report={inventory.data ?? payload.inventory}
                                    topology={payload.topology}
                                    meta={{ cliVersion: payload.cliVersion, generatedAt: payload.generatedAt }}
                                    selectedRowId={registryDrawerRowId}
                                    onRowClick={handleRegistryRowClick}
                                />
                                {registryDrawer && (
                                    <RegistryDrawer
                                        data={registryDrawer}
                                        onClose={handleRegistryDrawerClose}
                                    />
                                )}
                            </RegistryDrawerContext.Provider>
                        ) : isPackageRegistryPage && isRadiusDashboard(payload) && payload.deps ? (
                            <PackageRegistryView
                                report={payload.deps}
                                meta={{ cliVersion: payload.cliVersion, generatedAt: payload.generatedAt }}
                            />
                        ) : isGovernancePage ? (
                            <RegistryDrawerContext.Provider value={{
                                onRowClick: handleGovernanceRowClick,
                                selectedRowId: governanceDrawerRowId,
                            }}>
                                <GovernanceView
                                    report={(payload as RadiusDashboardPayload).governance!}
                                    evaluations={(data.governanceEvaluations ?? []) as FlatEvaluationRow[]}
                                    meta={{ cliVersion: payload.cliVersion, generatedAt: payload.generatedAt }}
                                    selectedRowId={governanceDrawerRowId}
                                    onRowClick={handleGovernanceRowClick}
                                    deepLinkPolicyId={(() => {
                                        const m = window.location.hash.match(/[?&]policy=([^&]+)/);
                                        return m?.[1] ?? undefined;
                                    })()}
                                />
                                {governanceDrawer && (
                                    <GovernanceDrawer
                                        data={governanceDrawer}
                                        ruleDrawerById={data.governanceRuleDrawerById}
                                        onClose={handleGovernanceDrawerClose}
                                    />
                                )}
                            </RegistryDrawerContext.Provider>
                        ) : isGravityPage ? (
                            <GravityView
                                data={(payload as RadiusDashboardPayload).gravity!}
                                meta={{ cliVersion: payload.cliVersion, generatedAt: payload.generatedAt }}
                            />
                        ) : activeNavId === 'agent-harness' && isRadiusDashboard(payload) && payload.radar ? (
                            <AgentHarnessView
                                radar={payload.radar}
                                governance={payload.governance ?? null}
                                meta={{ cliVersion: payload.cliVersion, generatedAt: payload.generatedAt }}
                            />
                        ) : (
                            <section className="cr-section-shell">
                                <PageIdentityStrip
                                    title=""
                                    subtitle={displaySubtitle}
                                    kpis={displayStats?.map(s => ({
                                        value: s.value,
                                        label: s.label,
                                        tone: s.color === 'red' ? 'danger' : s.color === 'yellow' ? 'warn' : s.color === 'green' ? 'ok' : s.color === 'blue' ? 'signal' : s.color === 'teal' ? 'ok' : undefined,
                                    }))}
                                />
                                <div className="cr-section-shell__body">
                                    {visibleSections.map((sec: any, idx: number) => (
                                        <SectionRenderer key={`${activeNavId}-${idx}`} section={sec} idx={idx} />
                                    ))}
                                </div>
                                <StatusBar
                                    left={<>
                                        {payload.cliVersion && <span>v{payload.cliVersion}</span>}
                                        {payload.cliVersion && <StatusBarSep />}
                                        <span>{formatStatusTs(payload.generatedAt)}</span>
                                        <StatusBarSep />
                                        <StatusBarOk><StatusBarDot /> LOCAL</StatusBarOk>
                                    </>}
                                    right={<span>{activeNavId}</span>}
                                />
                            </section>
                        )}
                    </main>
                </div>
            </div>
        );
    }

    const isBlastFocus = isRadiusDashboard(payload) && payload.focus === 'blast';
    const isRegistryFocus = isRadiusDashboard(payload) && payload.focus === 'inventory' && !!payload.inventory;
    const isPackageRegistryFocus = isRadiusDashboard(payload) && payload.focus === 'deps' && !!payload.deps;
    const isGovernanceFocus = isRadiusDashboard(payload) && payload.focus === 'governance' && !!payload.governance;
    const isOperatorFocus = isRegistryFocus || isPackageRegistryFocus || isGovernanceFocus;

    return (
        <div className="cr-app-layout">
            <div className="cr-main-pane">
                <PageTopBar title={data.title} leading={<OrganizationSwitcher />}>
                    {isBlastFocus && isGraphViewEnabled() && (
                        <ViewToggle viewMode={viewMode} onSwitch={setViewMode} />
                    )}
                    <SearchTriggerButton />
                </PageTopBar>

                <main
                    className={`container${isBlastFocus ? ' cr-main-blast' : isOperatorFocus ? ' cr-main-registry' : ''}${isPackageRegistryFocus ? ' cr-main-package-registry' : ''}`}
                    style={{ paddingBottom: isOperatorFocus ? 0 : '48px', flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0 }}
                >
                    {!isBlastFocus && !isOperatorFocus && data.headerStats && data.headerStats.length > 0 && (
                        <div className="cr-subheader" id="r-stats">
                            <p className="cr-subheader-subtitle">{data.subtitle}</p>
                            <div className="cr-subheader-stats">
                                {data.headerStats.map((s, i) => (
                                    <SimpleTooltip key={i} content={s.tooltip}>
                                        <div className="h-stat">
                                            <div className={`h-stat-val ${s.color ? 'color-text-' + s.color : ''}`}>{s.value}</div>
                                            <div className="h-stat-lbl">{s.label}</div>
                                        </div>
                                    </SimpleTooltip>
                                ))}
                            </div>
                        </div>
                    )}
                    {isRadiusDashboard(payload) && payload.focus === 'blast' && payload.topology ? (
                        <BlastRadiusExplorer
                            topology={payload.topology}
                            viewMode={viewMode}
                            onSwitchView={setViewMode}
                            meta={{ cliVersion: payload.cliVersion, generatedAt: payload.generatedAt }}
                        />
                    ) : isRegistryFocus && isRadiusDashboard(payload) && payload.inventory ? (
                        <RegistryDrawerContext.Provider value={{
                            onRowClick: handleRegistryRowClick,
                            selectedRowId: registryDrawerRowId,
                        }}>
                            <SystemRegistryView
                                report={inventory.data ?? payload.inventory}
                                topology={payload.topology}
                                meta={{ cliVersion: payload.cliVersion, generatedAt: payload.generatedAt }}
                                selectedRowId={registryDrawerRowId}
                                onRowClick={handleRegistryRowClick}
                            />
                            {registryDrawer && (
                                <RegistryDrawer
                                    data={registryDrawer}
                                    onClose={handleRegistryDrawerClose}
                                />
                            )}
                        </RegistryDrawerContext.Provider>
                    ) : isPackageRegistryFocus && isRadiusDashboard(payload) && payload.deps ? (
                        <PackageRegistryView
                            report={payload.deps}
                            meta={{ cliVersion: payload.cliVersion, generatedAt: payload.generatedAt }}
                        />
                    ) : isGovernanceFocus && isRadiusDashboard(payload) && payload.governance ? (
                        <RegistryDrawerContext.Provider value={{
                            onRowClick: handleGovernanceRowClick,
                            selectedRowId: governanceDrawerRowId,
                        }}>
                            <GovernanceView
                                report={payload.governance}
                                evaluations={(data.governanceEvaluations ?? []) as FlatEvaluationRow[]}
                                meta={{ cliVersion: payload.cliVersion, generatedAt: payload.generatedAt }}
                                selectedRowId={governanceDrawerRowId}
                                onRowClick={handleGovernanceRowClick}
                            />
                            {governanceDrawer && (
                                <GovernanceDrawer
                                    data={governanceDrawer}
                                    ruleDrawerById={data.governanceRuleDrawerById}
                                    onClose={handleGovernanceDrawerClose}
                                />
                            )}
                        </RegistryDrawerContext.Provider>
                    ) : (
                        data.sections.map((sec, idx) => (
                            <SectionRenderer key={idx} section={sec} idx={idx} />
                        ))
                    )}
                </main>
            </div>
        </div>
    );
}

// ─── App Export ───────────────────────────────────────────────────────────────
// BlastDashboard payloads get their own GlobalSearchProvider via BlastShell.
// RadiusDashboard (and others) go through AppInner which registers the topology.

export function App({ data: payload }: { data: DashboardPayload }) {
    const dataSource = useMemo(() => new StaticPayloadDataSource(payload as RadiusDashboardPayload), [payload]);
    if (isBlastDashboard(payload)) {
        return <BlastShell payload={payload} />;
    }
    return (
        <GlobalSearchProvider>
            <GlobalSearchPalette />
            <OrgFilterProvider>
                <DataSourceProvider source={dataSource}>
                    <AppInner data={payload} />
                </DataSourceProvider>
            </OrgFilterProvider>
        </GlobalSearchProvider>
    );
}

function formatStatusTs(value?: string) {
    if (!value) return new Date().toLocaleString(undefined, { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });
    const d = new Date(value);
    if (Number.isNaN(d.getTime())) return value;
    return d.toLocaleString(undefined, { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });
}
