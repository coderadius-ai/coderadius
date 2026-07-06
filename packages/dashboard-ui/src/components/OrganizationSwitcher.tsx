import { useMemo, useRef, useState, useEffect } from 'react';
import { Building2, ChevronDown, Check } from 'lucide-react';
import { useOrganizations, useTenant } from '../data/DataSourceProvider';
import { useOrgFilter } from '../data/OrgFilterContext';

/**
 * Global workspace breadcrumb. The root is the Tenant (always shown once
 * configured). When the deployment has organizations, the root becomes an
 * interactive switcher that scopes the System Registry to an org; with no
 * organizations it is a static label (nothing to filter, so no hollow
 * dropdown — and never a synthetic "default" org). Renders nothing only when
 * there is neither a tenant nor any organization.
 *
 * Organizations are single-level by design (GitLab base group, GitHub org,
 * IDP unit), so the list is flat.
 */
export function OrganizationSwitcher() {
    const organizations = useOrganizations();
    const tenant = useTenant();
    const { selectedOrgPaths, toggleOrgPath, clear } = useOrgFilter();
    const [open, setOpen] = useState(false);
    const wrapRef = useRef<HTMLDivElement>(null);

    const rows = useMemo(
        () => [...organizations].sort((a, b) => a.fullPath.localeCompare(b.fullPath)),
        [organizations],
    );

    useEffect(() => {
        if (!open) return;
        const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
        const onDown = (e: MouseEvent) => {
            const el = wrapRef.current;
            if (el && e.target instanceof Node && !el.contains(e.target)) setOpen(false);
        };
        window.addEventListener('keydown', onKey);
        window.addEventListener('mousedown', onDown, true);
        return () => {
            window.removeEventListener('keydown', onKey);
            window.removeEventListener('mousedown', onDown, true);
        };
    }, [open]);

    const hasOrgs = organizations.length > 0;
    if (!tenant && !hasOrgs) return null;

    const selectedCount = selectedOrgPaths.length;
    const root = tenant?.name ?? 'All organizations';
    let label: string;
    if (selectedCount === 0) label = root;
    else if (selectedCount === 1) label = tenant ? `${tenant.name} / ${selectedOrgPaths[0]}` : selectedOrgPaths[0];
    else label = tenant ? `${tenant.name} / ${selectedCount} orgs` : `${selectedCount} organizations`;

    return (
        <div ref={wrapRef} style={{ position: 'relative', display: 'inline-flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
            <style>{`
                .cr-orgswitch__crumb { display: inline-flex; align-items: center; gap: 6px; max-width: 280px; height: 28px; padding: 0 10px; margin: 0; background: var(--cr-bg-2); border: none; border-radius: 5px; color: var(--cr-ink-0); font-family: var(--font-sans); font-size: 13px; font-weight: var(--cr-weight-semibold); cursor: pointer; transition: background 120ms, color 120ms; }
                .cr-orgswitch__crumb:hover { background: var(--cr-bg-3); }
                .cr-orgswitch__crumb[data-active="true"] { color: var(--cr-signal); }
                .cr-orgswitch__static { display: inline-flex; align-items: center; gap: 6px; max-width: 280px; color: var(--cr-ink-0); font-family: var(--font-sans); font-size: 13px; font-weight: var(--cr-weight-semibold); }
                .cr-orgswitch__label { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
                .cr-orgswitch__crumb-sep { color: var(--cr-ink-3); font-size: 15px; line-height: 1; flex-shrink: 0; }
                .cr-orgswitch__panel { position: absolute; top: calc(100% + 6px); left: 0; width: 280px; max-height: 380px; display: flex; flex-direction: column; overflow: hidden; background: var(--cr-bg-1); border: 1px solid var(--cr-line-1); border-radius: 8px; box-shadow: 0 8px 24px rgba(0,0,0,0.5); z-index: 9990; animation: cr-orgswitch-in 160ms cubic-bezier(0.16,1,0.3,1) both; }
                @keyframes cr-orgswitch-in { from { opacity: 0; transform: translateY(-4px); } to { opacity: 1; transform: translateY(0); } }
                .cr-orgswitch__head { display: flex; align-items: center; gap: 8px; padding: 11px 14px 9px; }
                .cr-orgswitch__head-title { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: var(--cr-type-caption); font-weight: 600; color: var(--cr-ink-0); }
                .cr-orgswitch__clear { background: transparent; border: none; color: var(--cr-ink-2); font-size: var(--cr-type-micro); cursor: pointer; padding: 2px 4px; }
                .cr-orgswitch__clear:hover { color: var(--cr-signal); }
                .cr-orgswitch__divider { height: 1px; background: var(--cr-line-0); }
                .cr-orgswitch__list { flex: 1; overflow-y: auto; padding: 4px 0; }
                .cr-orgswitch__row { display: flex; align-items: center; gap: 8px; width: 100%; padding: 6px 12px; background: transparent; border: none; text-align: left; font-size: var(--cr-type-caption); font-family: var(--font-sans); color: var(--cr-ink-1); cursor: pointer; transition: background 120ms; }
                .cr-orgswitch__row:hover { background: var(--cr-bg-3); color: var(--cr-ink-0); }
                .cr-orgswitch__row.is-selected { color: var(--cr-ink-0); }
                .cr-orgswitch__check { display: inline-flex; align-items: center; justify-content: center; width: 14px; flex-shrink: 0; color: var(--cr-signal); }
                .cr-orgswitch__name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
                .cr-orgswitch__count { font-family: var(--font-mono); font-size: var(--cr-type-micro); color: var(--cr-ink-2); }
            `}</style>

            {hasOrgs ? (
                <button
                    type="button"
                    onClick={() => setOpen(o => !o)}
                    aria-haspopup="listbox"
                    aria-expanded={open}
                    data-active={selectedCount > 0}
                    className="cr-orgswitch__crumb"
                >
                    <Building2 size={13} style={{ opacity: 0.6, flexShrink: 0 }} />
                    <span className="cr-orgswitch__label">{label}</span>
                    <ChevronDown size={12} style={{ opacity: 0.55, flexShrink: 0 }} />
                </button>
            ) : (
                <span className="cr-orgswitch__static">
                    <Building2 size={13} style={{ opacity: 0.6, flexShrink: 0 }} />
                    <span className="cr-orgswitch__label">{label}</span>
                </span>
            )}
            <span className="cr-orgswitch__crumb-sep" aria-hidden="true">›</span>

            {open && hasOrgs && (
                <div className="cr-orgswitch__panel" role="listbox" aria-multiselectable="true" aria-label="Filter by organization">
                    <div className="cr-orgswitch__head">
                        <span className="cr-orgswitch__head-title">{tenant ? tenant.name : 'Organizations'}</span>
                        {selectedCount > 0 && (
                            <button type="button" className="cr-orgswitch__clear" onClick={() => clear()}>Clear</button>
                        )}
                    </div>
                    <div className="cr-orgswitch__divider" />
                    <div className="cr-orgswitch__list">
                        <button
                            type="button"
                            className={`cr-orgswitch__row${selectedCount === 0 ? ' is-selected' : ''}`}
                            onClick={() => { clear(); setOpen(false); }}
                            role="option"
                            aria-selected={selectedCount === 0}
                        >
                            <span className="cr-orgswitch__check">{selectedCount === 0 && <Check size={12} />}</span>
                            <span className="cr-orgswitch__name">All organizations</span>
                        </button>
                        {rows.map(row => {
                            const isSelected = selectedOrgPaths.includes(row.fullPath);
                            return (
                                <button
                                    key={row.fullPath}
                                    type="button"
                                    className={`cr-orgswitch__row${isSelected ? ' is-selected' : ''}`}
                                    onClick={() => { toggleOrgPath(row.fullPath); setOpen(false); }}
                                    role="option"
                                    aria-selected={isSelected}
                                    title={row.fullPath}
                                >
                                    <span className="cr-orgswitch__check">{isSelected && <Check size={12} />}</span>
                                    <span className="cr-orgswitch__name">{row.name}</span>
                                    <span className="cr-orgswitch__count">{row.repoCount}</span>
                                </button>
                            );
                        })}
                    </div>
                </div>
            )}
        </div>
    );
}
