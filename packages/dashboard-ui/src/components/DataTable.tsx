import React, { useState, useEffect, useRef, useMemo, useLayoutEffect, useCallback } from 'react';
import { flushSync, createPortal } from 'react-dom';
import {
  useReactTable,
  getCoreRowModel,
  getSortedRowModel,
  getFilteredRowModel,
  getPaginationRowModel,
  flexRender,
  getExpandedRowModel,
  ColumnDef,
  SortingState,
} from '@tanstack/react-table';
import { Search, ChevronLeft, ChevronRight, ChevronsLeft, ChevronsRight, ArrowUp, ArrowDown, Filter, Check, X, Download, ExternalLink } from 'lucide-react';
import semver from 'semver';
import type { TableSection, TableCell as ITableCell, TableRow } from '@coderadius/types';
import { Badges } from './Badges';
import { SimpleTooltip } from './Tooltip';
import { ListPopover, type ListPopoverAnchor } from './ListPopover';

import { BlastRadiusButton } from './BlastRadiusButton';
import { useRegistryDrawerContext } from './RegistryDrawerContext';
import { downloadCsv, rowsToCsv } from '../lib/csv';

interface PopoverState {
    rowId: string;
    colIdx: number;
    anchor: ListPopoverAnchor;
    title: string;
    items: { text: string; subtitle?: string; url?: string }[];
}

interface TableCellContentProps {
    cell: ITableCell;
    meta?: {
        overflowAction?: 'collapse' | 'scroll' | 'truncate';
        maxHeightRem?: number;
    };
    /** When the cell carries a `popover` payload, called with the anchor rect of the trigger button. */
    onPopoverOpen?: (anchor: ListPopoverAnchor) => void;
    /** Whether this cell's popover is currently open (so we can style the button as active). */
    popoverOpen?: boolean;
}

const CellTextRenderer = ({ cell }: { cell: ITableCell }) => {
    if (!cell.text && !cell.link && (!cell.segments || cell.segments.length === 0)) return null;

    const truncateClass = cell.truncate
        ? (cell.truncate === 2 ? 'text-truncate-2' : 'text-truncate')
        : undefined;

    let content: React.ReactNode;

    if (cell.segments && cell.segments.length > 0) {
        content = (
            <div style={{ display: 'inline-flex', gap: '6px', alignItems: 'center' }}>
                {cell.segments.map((seg, i) => (
                    <SimpleTooltip key={i} content={seg.tooltip}>
                        <span 
                            className={seg.color ? 'color-text-' + seg.color : undefined}
                            style={seg.text === '●' ? { fontSize: '7px', verticalAlign: 'middle', lineHeight: 1 } : undefined}
                        >
                            {seg.text}
                        </span>
                    </SimpleTooltip>
                ))}
            </div>
        );
    } else {
        content = cell.text;
        if (cell.color) {
            content = <span className={`color-text-${cell.color}`}>{content}</span>;
        }
    }

    if (truncateClass) {
        content = <div className={truncateClass}>{content}</div>;
    }

    if (cell.link) {
        content = (
            <a href={cell.link.url}
               target={cell.link.external ? '_blank' : undefined}
               rel={cell.link.external ? 'noopener noreferrer' : undefined}
               onClick={(e) => e.stopPropagation()}
               style={cell.link.external ? { display: 'inline-flex', alignItems: 'center', gap: '4px' } : undefined}>
                {content || cell.text}
                {cell.link.external && <ExternalLink size={11} style={{ opacity: 0.5, flexShrink: 0 }} />}
            </a>
        );
    }

    if (cell.subtitle) {
        let subtitleContent: React.ReactNode = cell.subtitle;
        if (cell.subtitleLink) {
            subtitleContent = (
                <a href={cell.subtitleLink.url}
                   target={cell.subtitleLink.external ? '_blank' : undefined}
                   rel={cell.subtitleLink.external ? 'noopener noreferrer' : undefined}
                   onClick={(e) => e.stopPropagation()}
                   className="tree-meta-link"
                   style={{ display: 'inline-flex', alignItems: 'center', gap: '3px', textDecoration: 'inherit' }}>
                    {cell.subtitle}
                    {cell.subtitleLink.external && <ExternalLink size={10} style={{ opacity: 0.5, flexShrink: 0 }} />}
                </a>
            );
        }
        content = (
            <div style={{ display: 'inline-flex', flexDirection: 'column' }}>
                <div>{content}</div>
                <div className="tree-meta" style={{ paddingLeft: '0', marginTop: '2px', display: 'flex', alignItems: 'center', gap: '4px' }}>
                    <span style={{ opacity: 0.5 }}>↳</span>
                    {subtitleContent}
                </div>
            </div>
        );
    }

    return <>{content}</>;
};

const CellItemsRenderer = ({ items }: { items: ITableCell['items'] }) => {
    if (!items || items.length === 0) return null;

    const dotColorMap: Record<string, string> = {
        green: 'var(--color-green, #22c55e)',
        cyan: 'var(--color-cyan, #06b6d4)',
        yellow: 'var(--color-yellow, #eab308)',
        dim: 'var(--text-quaternary, rgba(255,255,255,0.2))',
    };

    return (
        <div className="cr-table__cell-items" style={{ display: 'flex', flexWrap: 'wrap', gap: '10px' }}>
            {items.map((item, idx) => (
                <div key={idx} style={{ display: 'inline-flex', alignItems: 'center', whiteSpace: 'nowrap' }}>
                    {item.pulseDot && (
                        <SimpleTooltip content={item.pulseDot.tooltip || ''} side="top">
                            <span style={{
                                display: 'inline-block',
                                width: '8px', height: '8px',
                                borderRadius: '50%',
                                backgroundColor: dotColorMap[item.pulseDot.color] || dotColorMap.dim,
                                marginRight: '6px',
                                flexShrink: 0,
                                boxShadow: (item.pulseDot.color === 'green' || item.pulseDot.color === 'cyan')
                                    ? `0 0 6px ${dotColorMap[item.pulseDot.color]}`
                                    : 'none',
                            }} />
                        </SimpleTooltip>
                    )}
                    <span style={{ display: 'inline-flex', alignItems: 'center' }}>
                        {item.qualifiedContext && (
                            <>
                                <span style={{ color: 'var(--text-tertiary)', fontSize: '13px' }}>{item.qualifiedContext}</span>
                                <span style={{ color: 'var(--text-quaternary)', margin: '0 2px' }}>/</span>
                            </>
                        )}
                        {item.url ? (
                            <a 
                                href={item.url} 
                                target="_blank" 
                                rel="noopener noreferrer" 
                                onClick={(e) => e.stopPropagation()}
                                style={{ color: 'var(--text-secondary)', textDecoration: 'none', transition: 'color 0.15s', fontSize: '13px' }}
                                onMouseEnter={(e) => e.currentTarget.style.color = 'var(--text-primary)'}
                                onMouseLeave={(e) => e.currentTarget.style.color = 'var(--text-secondary)'}
                            >
                                {item.text}
                            </a>
                        ) : (
                            <span style={{ color: 'var(--text-secondary)', fontSize: '13px' }}>{item.text}</span>
                        )}
                    </span>
                    {item.badge && (
                        <span style={{ fontSize: '11px', color: 'var(--text-quaternary)', fontStyle: 'italic', marginLeft: '6px' }}>
                            {item.badge.text}
                        </span>
                    )}
                </div>
            ))}
        </div>
    );
};
const CellBarRenderer = ({ bar }: { bar: NonNullable<ITableCell['bar']> }) => (
    <div className="adoption-bar">
        {bar.map((seg, i) => {
            const bg =
                seg.color === 'green'  ? 'var(--color-green)'  :
                seg.color === 'yellow' ? 'var(--color-yellow)' :
                seg.color === 'red'    ? 'var(--color-red)'    :
                'rgba(255, 255, 255, 0.06)';
            return (
                <SimpleTooltip key={i} content={seg.label}>
                    <div
                        className="bar-seg"
                        style={{ width: `${seg.pct}%`, background: bg }}
                    />
                </SimpleTooltip>
            );
        })}
    </div>
);

const CellChecklistRenderer = ({ checklist }: { checklist: NonNullable<ITableCell['checklist']> }) => {
    if (!checklist || checklist.length === 0) return null;
    return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', marginTop: '6px' }}>
            {checklist.map((item, i) => {
                const isFail = item.status === 'fail';
                const isWarn = item.status === 'warn';
                const isPass = item.status === 'pass';
                
                const icon = isPass ? '✓' : isWarn ? '⚠' : '✗';
                const color = isFail ? 'var(--color-red)' : isWarn ? 'var(--color-yellow)' : 'var(--color-green)';
                const bg = isFail ? 'rgba(255, 50, 50, 0.1)' : isWarn ? 'rgba(255, 200, 50, 0.1)' : 'rgba(50, 255, 50, 0.1)';

                return (
                    <SimpleTooltip key={i} content={item.hint}>
                        <div style={{ 
                            display: 'flex', alignItems: 'center', gap: '8px',
                            color,
                            fontFamily: 'var(--font-mono)', fontSize: '11px',
                            opacity: 1, // ensure all statuses are perfectly visible
                            transition: 'opacity 0.2s ease',
                            cursor: item.hint ? 'help' : 'default'
                        }}>
                            <span style={{ 
                                display: 'flex', alignItems: 'center', justifyContent: 'center',
                                width: '18px', height: '18px', borderRadius: '4px',
                                background: bg,
                                color: color,
                                flexShrink: 0
                            }}>
                                {icon}
                            </span>
                            <span style={{ flex: 1, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', color: 'var(--text-primary)' }}>
                                {item.label}
                            </span>
                        </div>
                    </SimpleTooltip>
                );
            })}
        </div>
    );
};

const TableCellContent = ({ cell, meta, onPopoverOpen, popoverOpen }: TableCellContentProps) => {
    const [isExpanded, setIsExpanded] = useState(false);
    const [needsCollapse, setNeedsCollapse] = useState(false);
    const contentRef = useRef<HTMLDivElement>(null);
    const popoverBtnRef = useRef<HTMLButtonElement>(null);

    const hasPopover = !!(cell.popover && cell.popover.items.length > 0 && onPopoverOpen);
    
    useLayoutEffect(() => {
        if (!meta || meta.overflowAction !== 'collapse') return;
        if (contentRef.current) {
            const remInPx = parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
            const targetPx = (meta.maxHeightRem || 10) * remInPx;
            
            if (contentRef.current.scrollHeight > targetPx + 10) {
                setNeedsCollapse(true);
            }
        }
    }, [meta, cell.text]);

    const isCollapsed = needsCollapse && !isExpanded;
    const maxHeight = meta?.maxHeightRem ? `${meta.maxHeightRem}rem` : '10rem';

    const popoverButton = hasPopover ? (
        <button
            ref={popoverBtnRef}
            type="button"
            onClick={(e) => {
                e.stopPropagation();
                const rect = popoverBtnRef.current?.getBoundingClientRect();
                if (!rect) return;
                onPopoverOpen!({ x: rect.left, y: rect.top, width: rect.width, height: rect.height });
            }}
            aria-expanded={popoverOpen ? 'true' : 'false'}
            style={{
                background: 'transparent',
                border: 'none',
                padding: '2px 6px',
                margin: '-2px -6px',
                borderRadius: 4,
                color: popoverOpen ? 'var(--text-primary)' : 'var(--text-secondary)',
                font: 'inherit',
                fontSize: '13px',
                cursor: 'pointer',
                textDecoration: popoverOpen ? 'underline' : 'none',
                textDecorationColor: 'rgba(255,255,255,0.25)',
                textUnderlineOffset: '3px',
                transition: 'color 120ms, background 120ms, text-decoration-color 120ms',
            }}
            onMouseEnter={(e) => {
                e.currentTarget.style.color = 'var(--text-primary)';
                e.currentTarget.style.background = 'rgba(255,255,255,0.04)';
                e.currentTarget.style.textDecoration = 'underline';
                e.currentTarget.style.textDecorationColor = 'rgba(255,255,255,0.4)';
            }}
            onMouseLeave={(e) => {
                e.currentTarget.style.color = popoverOpen ? 'var(--text-primary)' : 'var(--text-secondary)';
                e.currentTarget.style.background = 'transparent';
                e.currentTarget.style.textDecoration = popoverOpen ? 'underline' : 'none';
                e.currentTarget.style.textDecorationColor = 'rgba(255,255,255,0.25)';
            }}
        >
            {cell.text}
        </button>
    ) : null;

    const mainContent = (
        <>
            <div
                ref={contentRef}
                style={{
                    maxHeight: isCollapsed ? maxHeight : 'none',
                    overflow: isCollapsed ? 'hidden' : 'visible',
                    position: 'relative'
                }}
            >
                {hasPopover ? popoverButton : <CellTextRenderer cell={cell} />}
                {isCollapsed && (
                    <div style={{
                        position: 'absolute',
                        bottom: 0,
                        left: 0,
                        right: 0,
                        height: '3rem',
                        background: 'linear-gradient(to bottom, transparent, var(--bg-surface, var(--bg-card, #000)))',
                        pointerEvents: 'none'
                    }} />
                )}
            </div>
            {needsCollapse && (
                <button 
                    onClick={() => setIsExpanded(!isExpanded)}
                    style={{
                        background: 'var(--bg-dim, rgba(255, 255, 255, 0.05))',
                        border: '1px solid var(--border-default, rgba(255, 255, 255, 0.1))',
                        borderRadius: '4px',
                        color: 'var(--text-secondary)',
                        fontSize: '12px',
                        padding: '4px 12px',
                        cursor: 'pointer',
                        display: 'inline-flex',
                        alignItems: 'center',
                        gap: '6px',
                        marginTop: '8px',
                        marginBottom: '4px',
                        transition: 'all 0.15s ease'
                    }}
                    onMouseEnter={e => { e.currentTarget.style.color = 'var(--text-primary)'; e.currentTarget.style.borderColor = 'var(--border-hover, rgba(255, 255, 255, 0.2))'; }}
                    onMouseLeave={e => { e.currentTarget.style.color = 'var(--text-secondary)'; e.currentTarget.style.borderColor = 'var(--border-default, rgba(255, 255, 255, 0.1))'; }}
                >
                    {isExpanded ? (
                        <>Show less <ArrowUp size={12} /></>
                    ) : (
                        <>Show all <ArrowDown size={12} /></>
                    )}
                </button>
            )}
        </>
    );

    return (
        <div className="cr-table-cell-content-wrapper">
            {cell.tooltip && !hasPopover ? (
                <SimpleTooltip content={cell.tooltip}>
                    {/* Wrap in fit-content so tooltip arrow centers on the text, not the 100% cell width */}
                    <div style={{ width: 'fit-content', maxWidth: '100%' }}>
                        {mainContent}
                    </div>
                </SimpleTooltip>
            ) : mainContent}

            <CellItemsRenderer items={cell.items} />
            {cell.bar && cell.bar.length > 0 && <CellBarRenderer bar={cell.bar} />}
            {cell.checklist && cell.checklist.length > 0 && <CellChecklistRenderer checklist={cell.checklist} />}
            <Badges badges={cell.badges as any} />
        </div>
    );
};

// ─── CSV Export ────────────────────────────────────────────────────────────────

function collectLeafRows(rows: any[]): any[] {
    const leaves: any[] = [];
    for (const row of rows) {
        const subs = row.subRows && row.subRows.length > 0 ? row.subRows : null;
        if (subs) {
            // Walk into sub-rows — export only leaves (deepest level)
            leaves.push(...collectLeafRows(subs));
        } else {
            leaves.push(row);
        }
    }
    return leaves;
}

function exportTableToCsv(table: any, headers: (string | { label: string })[], title: string) {
    const headerLabels = headers.map(h => typeof h === 'string' ? h : h.label);
    const filteredRows = table.getFilteredRowModel().rows;
    const leafRows = collectLeafRows(filteredRows);

    // 1. Identify which columns need a "Details" split.
    // A column needs a Details split if ANY cell in that column has popover.items or tooltip (and text is a number).
    const colNeedsDetails = new Array(headerLabels.length).fill(false);
    for (const row of leafRows) {
        row.original.cells.forEach((c: any, i: number) => {
            if (!c) return;
            const hasPopover = c.popover?.items?.length > 0;
            const hasTooltipDetails = c.tooltip && !c.popover && c.text && /^\d+$/.test(c.text.trim());
            if (hasPopover || hasTooltipDetails) {
                colNeedsDetails[i] = true;
            }
        });
    }

    // 2. Build the new headers
    const finalHeaders: string[] = [];
    for (let i = 0; i < headerLabels.length; i++) {
        finalHeaders.push(headerLabels[i]);
        if (colNeedsDetails[i]) {
            finalHeaders.push(`${headerLabels[i]} Details`);
        }
    }

    // 3. Build the rows
    const rowsData: unknown[][] = [];
    for (const row of leafRows) {
        const rowData: unknown[] = [];
        row.original.cells.forEach((c: any, i: number) => {
            if (!c) {
                rowData.push('—');
                if (colNeedsDetails[i]) rowData.push('');
                return;
            }

            const isSplitCol = colNeedsDetails[i];
            const mainParts: string[] = [];

            if (c.text !== undefined && c.text !== "") {
                mainParts.push(c.text);
            } else if ((!c.text || c.text === "") && c.badges && !isSplitCol) {
                mainParts.push(c.badges.map((b: any) => b.text).join(', '));
            } else if ((!c.text || c.text === "") && c.items && !isSplitCol) {
                mainParts.push(c.items.map((item: any) => item.text).join(', '));
            }

            if (c.segments) {
                mainParts.push(c.segments.map((s: any) => s.text).join(' '));
            }

            if (!isSplitCol) {
                if (c.text && c.badges) mainParts.push(c.badges.map((b: any) => b.text).join(', '));
                if (c.text && c.items) mainParts.push(c.items.map((item: any) => item.text + (item.badge ? ` (${item.badge.text})` : '')).join(', '));
            }

            rowData.push(mainParts.filter(Boolean).join(' ').trim() || '—');

            if (isSplitCol) {
                let detailsStr = '';
                if (c.popover?.items?.length) {
                    detailsStr = c.popover.items.map((item: any) => item.text).join(', ');
                } else if (c.tooltip && c.text && /^\d+$/.test(c.text.trim())) {
                    detailsStr = c.tooltip;
                }
                rowData.push(detailsStr);
            }
        });

        rowsData.push(rowData);
    }

    const slug = (title || 'export').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    downloadCsv(rowsToCsv(finalHeaders, rowsData), `${slug}.csv`);
}

// ─── Semver Range Filter ──────────────────────────────────────────────────────

const SemverFilter = ({ column, table: _table }: { column: any, table: any }) => {
    const [isOpen, setIsOpen] = useState(false);
    const [rangeInput, setRangeInput] = useState<string>((column.getFilterValue() as string) || '');
    const buttonRef = useRef<HTMLButtonElement>(null);
    const popoverRef = useRef<HTMLDivElement>(null);
    const ref = useRef<HTMLDivElement>(null);

    const isValidRange = rangeInput.trim() === '' || semver.validRange(rangeInput.trim()) !== null;
    const hasFilter = !!column.getFilterValue();

    const openTimeRef = useRef(0);
    useEffect(() => {
        if (isOpen) openTimeRef.current = Date.now();
        const handleInteraction = (event: Event) => {
            if (event.type === 'scroll') {
                if (Date.now() - openTimeRef.current < 100) return;
                const target = event.target as Node;
                if (popoverRef.current && popoverRef.current.contains(target)) return;
                setIsOpen(false);
                return;
            }
            const clickedInsideButton = ref.current && ref.current.contains(event.target as Node);
            const clickedInsidePopover = popoverRef.current && popoverRef.current.contains(event.target as Node);
            if (!clickedInsideButton && !clickedInsidePopover) {
                setIsOpen(false);
            }
        };
        if (isOpen) {
            document.addEventListener('mousedown', handleInteraction);
            document.addEventListener('scroll', handleInteraction, true);
        }
        return () => {
            document.removeEventListener('mousedown', handleInteraction);
            document.removeEventListener('scroll', handleInteraction, true);
        };
    }, [isOpen]);

    useLayoutEffect(() => {
        if (isOpen && popoverRef.current && buttonRef.current) {
            const rect = buttonRef.current.getBoundingClientRect();
            popoverRef.current.style.position = 'fixed';
            popoverRef.current.style.top = `${rect.bottom + 8}px`;
            if (rect.left + 280 > window.innerWidth - 10) {
                popoverRef.current.style.left = `${rect.right - 280}px`;
            } else {
                popoverRef.current.style.left = `${rect.left}px`;
            }
        }
    }, [isOpen]);

    const applyFilter = useCallback(() => {
        const trimmed = rangeInput.trim();
        if (trimmed === '' || !semver.validRange(trimmed)) {
            column.setFilterValue(undefined);
        } else {
            column.setFilterValue(trimmed);
        }
    }, [rangeInput, column]);

    const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
        if (e.key === 'Enter') {
            applyFilter();
        } else if (e.key === 'Escape') {
            setIsOpen(false);
        }
    }, [applyFilter]);

    return (
        <div ref={ref} style={{ display: 'flex', alignItems: 'center' }}>
            <button
                ref={buttonRef}
                onClick={(e) => { e.stopPropagation(); setIsOpen(!isOpen); }}
                style={{
                    background: 'none', border: 'none', cursor: 'pointer', padding: '0px 4px',
                    display: 'flex', alignItems: 'center', justifyContent: 'center', opacity: isOpen ? 1 : 0.4,
                    color: hasFilter ? 'var(--color-cyan)' : 'inherit', position: 'relative'
                }}
            >
                <Filter size={14} />
            </button>
            {isOpen && createPortal(
                <div
                    ref={popoverRef}
                    className="filter-popover active"
                    onClick={e => e.stopPropagation()}
                    onMouseDown={e => e.stopPropagation()}
                    style={{ padding: 0, width: '280px', overflow: 'hidden' }}
                >
                    <div style={{ display: 'flex', flexDirection: 'column' }}>
                        <div style={{ display: 'flex', alignItems: 'center', padding: '6px 12px' }}>
                            <input
                                type="text"
                                placeholder="Semver range (e.g. >=2.0, ^3.x)"
                                value={rangeInput}
                                onChange={e => setRangeInput(e.target.value)}
                                onKeyDown={handleKeyDown}
                                onBlur={applyFilter}
                                autoFocus
                                style={{
                                    flex: 1, minWidth: 0, background: 'transparent',
                                    border: 'none', color: 'var(--text-primary)', fontSize: '13px',
                                    padding: '4px 0', outline: 'none',
                                    fontFamily: '"JetBrains Mono", monospace',
                                }}
                            />
                            {hasFilter && (
                                <button
                                    onClick={() => { setRangeInput(''); column.setFilterValue(undefined); }}
                                    style={{
                                        background: 'none', border: 'none', color: 'var(--text-tertiary)',
                                        cursor: 'pointer', padding: '4px', display: 'flex',
                                        alignItems: 'center', justifyContent: 'center', flexShrink: 0
                                    }}
                                >
                                    <X size={14} />
                                </button>
                            )}
                        </div>
                        {rangeInput && !isValidRange && (
                            <div style={{ fontSize: '11px', color: 'var(--color-red, #ef4444)', padding: '0 12px 6px' }}>
                                Invalid range
                            </div>
                        )}
                        <div style={{ height: '1px', background: 'var(--border-subtle)' }} />
                        <div style={{
                            display: 'flex', gap: '2px', padding: '6px', background: 'var(--bg-surface, rgba(255,255,255,0.02))'
                        }}>
                            {['^', '~', '>=', '<=', '>'].map(op => (
                                <button
                                    key={op}
                                    onClick={() => setRangeInput(prev => prev ? `${op}${prev.replace(/^[~^>=<]+/, '')}` : op)}
                                    style={{
                                        background: 'transparent',
                                        border: 'none',
                                        borderRadius: '4px', color: 'var(--text-secondary)',
                                        fontSize: '12.5px', padding: '4px 8px', cursor: 'pointer',
                                        fontFamily: '"JetBrains Mono", monospace',
                                        transition: 'all 0.1s ease',
                                    }}
                                    onMouseEnter={e => { e.currentTarget.style.background = 'var(--border-subtle)'; e.currentTarget.style.color = 'var(--text-primary)'; }}
                                    onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.color = 'var(--text-secondary)'; }}
                                >
                                    {op}
                                </button>
                            ))}
                        </div>
                    </div>
                </div>,
                document.body
            )}
        </div>
    );
};

// ─── Column Filter (Text Mode) ───────────────────────────────────────────────

const ColumnFilter = ({ column, table }: { column: any, table: any }) => {
    const [isOpen, setIsOpen] = useState(false);
    const [searchQuery, setSearchQuery] = useState('');


    const uniqueValues = useMemo(() => {
        if (!isOpen) return []; // defer costly computation until clicked
        const valSet = new Set<string>();
        const colIdx = parseInt(column.id.split('_')[1], 10);
        if (isNaN(colIdx)) return [];
        
        const rows = table.getPreFilteredRowModel().rows;
        for (let i = 0; i < rows.length; i++) {
            const cell = rows[i].original.cells[colIdx];
            if (!cell) continue;
            
            if (cell.filterValues) {
                cell.filterValues.forEach((v: string) => valSet.add(v));
            } else {
                const txt = cell.text?.trim();
                if (txt) valSet.add(txt);
                if (cell.badges) {
                    for (const b of cell.badges) {
                        if (b.text) valSet.add(b.text);
                    }
                }
                if (cell.items) {
                    for (const item of cell.items) {
                        if (item.text) valSet.add(item.text);
                    }
                }
            }
        }
        return Array.from(valSet).sort();
    }, [isOpen, table.getPreFilteredRowModel().rows, column.id]);

    const filterValue: string[] = (column.getFilterValue() as string[]) || [];
    const hasFilter = filterValue.length > 0;

    const ref = useRef<HTMLDivElement>(null);
    const popoverRef = useRef<HTMLDivElement>(null);
    const buttonRef = useRef<HTMLButtonElement>(null);

    const openTimeRef = useRef(0);
    useEffect(() => {
        if (isOpen) openTimeRef.current = Date.now();
        const handleInteraction = (event: Event) => {
            if (event.type === 'scroll') {
                if (Date.now() - openTimeRef.current < 100) return;
                const target = event.target as Node;
                if (popoverRef.current && popoverRef.current.contains(target)) return;
                setIsOpen(false);
                return;
            }
            const clickedInsideButton = ref.current && ref.current.contains(event.target as Node);
            const clickedInsidePopover = popoverRef.current && popoverRef.current.contains(event.target as Node);
            if (!clickedInsideButton && !clickedInsidePopover) {
                setIsOpen(false);
            }
        };
        if (isOpen) {
            document.addEventListener('mousedown', handleInteraction);
            document.addEventListener('scroll', handleInteraction, true);
        }
        return () => {
            document.removeEventListener('mousedown', handleInteraction);
            document.removeEventListener('scroll', handleInteraction, true);
        };
    }, [isOpen]);

    useLayoutEffect(() => {
        if (isOpen && popoverRef.current && buttonRef.current) {
            const rect = buttonRef.current.getBoundingClientRect();
            popoverRef.current.style.position = 'fixed';
            popoverRef.current.style.top = `${rect.bottom + 8}px`;
            
            if (rect.left + 240 > window.innerWidth - 10) {
                popoverRef.current.style.left = `${rect.right - 240}px`;
            } else {
                popoverRef.current.style.left = `${rect.left}px`;
            }
        }
    }, [isOpen]);

    return (
        <div ref={ref} style={{ display: 'flex', alignItems: 'center' }}>
            <button 
                ref={buttonRef}
                onClick={(e) => { e.stopPropagation(); setIsOpen(!isOpen); setSearchQuery(''); }}
                style={{ 
                    background: 'none', border: 'none', cursor: 'pointer', padding: '0px 4px',
                    display: 'flex', alignItems: 'center', justifyContent: 'center', opacity: isOpen ? 1 : 0.4,
                    color: hasFilter ? 'var(--color-cyan)' : 'inherit', position: 'relative'
                }}
            >
                <Filter size={14} />
            </button>
            {isOpen && createPortal(
                <div 
                    ref={popoverRef}
                    className="filter-popover active"
                    onClick={e => e.stopPropagation()}
                    onMouseDown={e => e.stopPropagation()}
                    style={{
                        padding: 0,
                        width: '240px',
                        overflow: 'hidden'
                    }}
                >
                    {uniqueValues.length === 0 && (
                         <div style={{ padding: '8px', fontSize: '12px', color: 'var(--text-tertiary)', textAlign: 'center' }}>No filters available</div>
                    )}
                    {uniqueValues.length > 0 && (
                        <>
                            <div style={{ 
                                display: 'flex', alignItems: 'center', padding: '0 12px', 
                                borderBottom: '1px solid var(--border-subtle)', background: 'var(--bg-card)',
                                height: '38px', flexShrink: 0
                            }}>
                                <Search size={14} style={{ color: 'var(--text-tertiary)', marginRight: '8px', flexShrink: 0 }} />
                                <input 
                                    type="text" 
                                    placeholder="Filter..." 
                                    value={searchQuery}
                                    onChange={(e) => setSearchQuery(e.target.value)}
                                    style={{ 
                                        flex: 1, minWidth: 0, background: 'transparent', border: 'none', 
                                        color: 'var(--text-primary)', fontSize: '12.5px', outline: 'none' 
                                    }}
                                />
                                {hasFilter && (
                                    <button onClick={() => column.setFilterValue(undefined)} style={{ background: 'none', border: 'none', color: 'var(--text-tertiary)', cursor: 'pointer', marginLeft: '8px', padding: '4px', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                                        <X size={14} />
                                    </button>
                                )}
                            </div>
                            <div style={{ maxHeight: '200px', overflowY: 'auto', display: 'flex', flexDirection: 'column' }}>
                                {uniqueValues.filter(v => v.toLowerCase().includes(searchQuery.toLowerCase())).length > 0 ? 
                                    uniqueValues.filter(v => v.toLowerCase().includes(searchQuery.toLowerCase())).map(v => {
                                        const isSelected = filterValue.includes(v);
                                        return (
                                            <div 
                                                key={v} 
                                                onClick={() => {
                                                    const newVal = isSelected ? filterValue.filter(f => f !== v) : [...filterValue, v];
                                                    column.setFilterValue(newVal.length ? newVal : undefined);
                                                }}
                                                style={{
                                                    display: 'flex', alignItems: 'center', padding: '6px 12px', cursor: 'pointer',
                                                    fontSize: '12px', color: 'var(--text-secondary)', textAlign: 'left',
                                                    background: isSelected ? 'color-mix(in srgb, var(--cr-signal) 8%, transparent)' : 'transparent',
                                                    borderLeft: isSelected ? '2px solid var(--cr-signal)' : '2px solid transparent'
                                                }}
                                                onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--bg-surface)'; }}
                                                onMouseLeave={(e) => { e.currentTarget.style.background = isSelected ? 'color-mix(in srgb, var(--cr-signal) 8%, transparent)' : 'transparent'; }}
                                            >
                                                <div style={{ width: '16px', marginRight: '8px', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, color: 'var(--cr-signal)' }}>
                                                    {isSelected && <Check size={14} />}
                                                </div>
                                                <span style={{ 
                                                    overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', 
                                                    fontFamily: 'var(--font-sans)', textAlign: 'left', flex: 1, minWidth: 0
                                                }}>
                                                    {v}
                                                </span>
                                            </div>
                                        );
                                    }) : (
                                    <div style={{ padding: '8px', fontSize: '12px', color: 'var(--text-tertiary)', textAlign: 'center' }}>No matches</div>
                                )}
                            </div>
                        </>
                    )}
                </div>,
                document.body
            )}
        </div>
    );
};

export function DataTable({
    section,
    secIdx,
    onRowClick: onRowClickProp,
    selectedRowId: selectedRowIdProp,
}: {
    section: TableSection;
    secIdx: string | number;
    /** Optional: called with the row's drawerData when a clickable row is clicked. */
    onRowClick?: (drawerData: Record<string, unknown>) => void;
    /** Optional: highlights the row matching this id. */
    selectedRowId?: string;
}) {
    // Fallback to context (set by App when the System Registry tab is active)
    const drawerCtx = useRegistryDrawerContext();
    const onRowClick = onRowClickProp ?? drawerCtx?.onRowClick;
    const selectedRowId = selectedRowIdProp ?? drawerCtx?.selectedRowId;
    const [sorting, setSorting] = useState<SortingState>(section.initialSorting || []);
    const [globalFilter, setGlobalFilter] = useState('');
    const [popover, setPopover] = useState<PopoverState | null>(null);
    const savedPageSizeRef = useRef<number>(50);

    const data = useMemo<TableRow[]>(() => {
        return section.rows.map(row => {
            if (Array.isArray(row)) {
                return { cells: row };
            }
            return row;
        });
    }, [section.rows]);

    const columns = useMemo<ColumnDef<TableRow>[]>(() => {
        return section.headers.map((h, i) => {
            const isObj = typeof h !== 'string';
            const headerLabel = isObj ? (h as any).label : h;
            const meta = isObj ? (h as any).meta : undefined;
            const isSemverMode = meta?.filterMode === 'semver';

            return {
                header: headerLabel,
                accessorFn: (row) => {
                    const cell = row.cells[i];
                    if (!cell) return '';
                    if (cell.sortValue !== undefined) return cell.sortValue;
                    return cell.text.trim();
                },
                id: `col_${i}`,
                meta,
                cell: (info) => {
                    const cellVal = info.row.original.cells[i];
                    if (!cellVal) return null;

                    // Read dynamic state via table.options.meta. Keeps cell
                    // callbacks stable while letting them see fresh popover
                    // state and onRowClick on every render.
                    const tMeta = (info.table.options.meta ?? {}) as {
                        popover?: PopoverState | null;
                        setPopover?: (p: PopoverState | null) => void;
                        onRowClick?: (drawerData: Record<string, unknown>) => void;
                    };
                    const popover = tMeta.popover ?? null;
                    const setPopover = tMeta.setPopover;
                    const onRowClick = tMeta.onRowClick;

                    const rowId = info.row.original.id ?? `row_${info.row.id}`;
                    const cellPopoverOpen = popover?.rowId === rowId && popover?.colIdx === i;

                    let expander = null;
                    if (i === 0) {
                        const hasSubRows = info.row.subRows && info.row.subRows.length > 0;
                        if (hasSubRows) {
                            expander = (
                                <button
                                    onClick={info.row.getToggleExpandedHandler()}
                                    style={{
                                        background: 'none',
                                        border: 'none',
                                        cursor: 'pointer',
                                        padding: '2px 2px',
                                        marginRight: '6px',
                                        color: 'var(--text-secondary)',
                                        display: 'flex',
                                        alignItems: 'center',
                                        justifyContent: 'center',
                                        flexShrink: 0,
                                        width: '20px',
                                        height: '20px',
                                        borderRadius: '4px',
                                    }}
                                    onMouseEnter={e => e.currentTarget.style.background = 'var(--bg-surface)'}
                                    onMouseLeave={e => e.currentTarget.style.background = 'none'}
                                >
                                    {info.row.getIsExpanded() ? <ArrowDown size={14} /> : <ChevronRight size={14} />}
                                </button>
                            );
                        } else if (info.row.depth > 0) {
                            // Spacer for sub-rows to keep alignment if siblings have expanders
                            // (Depth 0 rows stay flush with header if not expandable)
                            expander = <span style={{ display: 'inline-block', width: '26px', flexShrink: 0 }} />;
                        }
                    }

                    // First cell of a clickable row gets a hover-revealed
                    // "Show relation" affordance. Whole-row click is no longer
                    // a navigation surface: count cells now own click for
                    // their list popovers, and we want a single, explicit
                    // entry point per row.
                    // Hover-revealed row actions, rendered in cell 0 so they
                    // sit at the leading edge regardless of column count.
                    // Order: blast-radius first (navigation), open-details
                    // last (drawer) — primary action stays closest to the row
                    // metadata it's about to reveal.
                    const drawerData = info.row.original.drawerData;
                    const blastRadiusUrn = info.row.original.blastRadiusUrn;
                    const isFirstCell = i === 0;
                    const showBlastRadius = isFirstCell && !!blastRadiusUrn;

                    const rowActionsEl = showBlastRadius ? (
                        <div
                            className="cr-row-action"
                            style={{ display: 'inline-flex', gap: 4, marginLeft: 8, flexShrink: 0 }}
                        >
                            <BlastRadiusButton
                                variant="icon"
                                size="md"
                                urn={blastRadiusUrn!}
                            />
                        </div>
                    ) : null;

                    return (
                        <div style={{ display: 'flex', alignItems: 'flex-start' }}>
                            {expander}
                            <div style={{ flex: 1, minWidth: 0 }}>
                                <TableCellContent
                                    cell={cellVal}
                                    meta={info.column.columnDef.meta as any}
                                    popoverOpen={cellPopoverOpen}
                                    onPopoverOpen={cellVal.popover && setPopover ? (anchor) => {
                                        setPopover({
                                            rowId,
                                            colIdx: i,
                                            anchor,
                                            title: cellVal.popover!.title,
                                            items: cellVal.popover!.items,
                                        });
                                    } : undefined}
                                />
                            </div>
                            {rowActionsEl}
                        </div>
                    );
                },
                filterFn: isSemverMode
                    // Semver range filter: filterValue is a range string like ">=2.0.0" or "^3.x"
                    ? (row, _columnId, filterValue: string) => {
                        if (!filterValue) return true;
                        const range = semver.validRange(filterValue);
                        if (!range) return true; // invalid range = show all

                        const extractVersions = (r: typeof row): string[] => {
                            const cell = r.original.cells[i];
                            if (!cell) return [];
                            const versions: string[] = [];
                            // Check segments (used in version sub-rows)
                            if (cell.segments) {
                                cell.segments.forEach((s: any) => {
                                    const cleaned = s.text.replace(/^v/, '');
                                    if (semver.valid(semver.coerce(cleaned))) versions.push(cleaned);
                                });
                            }
                            // Check text directly
                            if (cell.text) {
                                const cleaned = cell.text.replace(/^v/, '');
                                if (semver.valid(semver.coerce(cleaned))) versions.push(cleaned);
                            }
                            return versions;
                        };

                        const versions = extractVersions(row);
                        if (versions.some(v => {
                            const coerced = semver.coerce(v);
                            return coerced && semver.satisfies(coerced, range);
                        })) return true;

                        // Check parent rows for tree structures
                        let curr = row.getParentRow();
                        while (curr) {
                            const pVersions = extractVersions(curr);
                            if (pVersions.some(v => {
                                const coerced = semver.coerce(v);
                                return coerced && semver.satisfies(coerced, range);
                            })) return true;
                            curr = curr.getParentRow();
                        }
                        return false;
                    }
                    // Standard text filter
                    : (row, _columnId, filterValue: string[]) => {
                        if (filterValue.length === 0) return true;
                        
                        const checkMatch = (r: typeof row) => {
                            const cell = r.original.cells[i];
                            if (!cell) return false;
                            
                            if (cell.filterValues) {
                                return filterValue.some(fv => cell.filterValues!.some((cv: string) => cv.toLowerCase().includes(fv.toLowerCase())));
                            }

                            const texts: string[] = [];
                            texts.push(cell.text.trim());
                            if (cell.badges) {
                                cell.badges.forEach((b: any) => texts.push(b.text));
                            }
                            if (cell.items) {
                                cell.items.forEach((item: any) => texts.push(item.text));
                            }
                            return filterValue.some(fv => texts.some(t => t.toLowerCase().includes(fv.toLowerCase())));
                        };

                        if (checkMatch(row)) return true;
                        
                        let curr = row.getParentRow();
                        while (curr) {
                            if (checkMatch(curr)) return true;
                            curr = curr.getParentRow();
                        }
                        return false;
                    }
            };
        });
    }, [section.headers]);

    const table = useReactTable({
        data,
        columns,
        state: {
            sorting,
            globalFilter,
        },
        meta: {
            popover,
            setPopover,
            onRowClick,
        } as any,
        getSubRows: row => row.subRows,
        onSortingChange: setSorting,
        onGlobalFilterChange: setGlobalFilter,
        globalFilterFn: (row, _columnId, filterValue) => {
            const val = filterValue.toLowerCase();
            const checkMatch = (r: typeof row) => {
                return r.original.cells.some((c: any) => {
                    if (!c) return false;
                    if (c.searchValue && c.searchValue.toLowerCase().includes(val)) return true;
                    if (c.filterValues && c.filterValues.some((fv: string) => fv.toLowerCase().includes(val))) return true;
                    if (c.text && c.text.toLowerCase().includes(val)) return true;
                    if (c.badges && c.badges.some((b: any) => b.text.toLowerCase().includes(val))) return true;
                    if (c.items && c.items.some((item: any) => item.text.toLowerCase().includes(val))) return true;
                    if (c.segments && c.segments.some((s: any) => s.text.toLowerCase().includes(val))) return true;
                    return false;
                });
            };
            if (checkMatch(row)) return true;
            
            let curr = row.getParentRow();
            while (curr) {
                if (checkMatch(curr)) return true;
                curr = curr.getParentRow();
            }
            return false;
        },
        getCoreRowModel: getCoreRowModel(),
        getSortedRowModel: getSortedRowModel(),
        getFilteredRowModel: getFilteredRowModel(),
        getPaginationRowModel: getPaginationRowModel(),
        getExpandedRowModel: getExpandedRowModel(),
        paginateExpandedRows: false,
        initialState: {
            pagination: {
                pageSize: 50,
            },
        },
    });

    useEffect(() => {
        const handleBeforePrint = () => {
            savedPageSizeRef.current = table.getState().pagination.pageSize;
            flushSync(() => {
                table.setPageSize(Number.MAX_SAFE_INTEGER);
            });
        };

        const handleAfterPrint = () => {
            table.setPageSize(savedPageSizeRef.current);
        };

        window.addEventListener('beforeprint', handleBeforePrint);
        window.addEventListener('afterprint', handleAfterPrint);
        return () => {
            window.removeEventListener('beforeprint', handleBeforePrint);
            window.removeEventListener('afterprint', handleAfterPrint);
        };
    }, [table]);

    const handleSearch = (e: React.ChangeEvent<HTMLInputElement>) => {
        setGlobalFilter(e.target.value);
    };

    const PaginationControls = () => {
        if (table.getPageCount() <= 1) return null;
        
        return (
            <div style={{ display: 'flex', alignItems: 'center', gap: '16px' }}>
                <div style={{ color: 'var(--text-secondary)', fontSize: '13px' }}>
                    Page {table.getState().pagination.pageIndex + 1} of {table.getPageCount()}
                </div>
                <div style={{ display: 'flex', gap: '4px' }}>
                    <button className="btn-icon" onClick={() => table.setPageIndex(0)} disabled={!table.getCanPreviousPage()}>
                        <ChevronsLeft size={16} />
                    </button>
                    <button className="btn-icon" onClick={() => table.previousPage()} disabled={!table.getCanPreviousPage()}>
                        <ChevronLeft size={16} />
                    </button>
                    <button className="btn-icon" onClick={() => table.nextPage()} disabled={!table.getCanNextPage()}>
                        <ChevronRight size={16} />
                    </button>
                    <button className="btn-icon" onClick={() => table.setPageIndex(table.getPageCount() - 1)} disabled={!table.getCanNextPage()}>
                        <ChevronsRight size={16} />
                    </button>
                </div>
            </div>
        );
    };

    return (
        <section className="stagger-2">
            <style>{`
                .cr-row-action { opacity: 0; transition: opacity 120ms ease; }
                tr:hover .cr-row-action,
                tr.tr--selected .cr-row-action { opacity: 1; }
            `}</style>
            {(section.title || section.subtitle || section.headerStats) && (
                <div className="table-header" style={{ marginBottom: '16px' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                        <div>
                            {section.title && <h2 style={{ margin: '0 0 4px 0' }}>{section.title}</h2>}
                            {section.subtitle && <p className="subtitle" style={{ margin: 0, fontSize: '14px', color: 'var(--text-tertiary)' }}>{section.subtitle}</p>}
                        </div>
                        {section.headerStats && section.headerStats.length > 0 && (
                            <div className="header-stats" style={{ display: 'flex', gap: '32px', alignItems: 'center' }}>
                                {section.headerStats.map((s: any, i: number) => (
                                    <div key={i} className="h-stat" style={{ textAlign: 'right' }}>
                                        <div className={`h-stat-val ${s.color ? 'color-text-' + s.color : ''}`}>
                                            {s.value}
                                        </div>
                                        <div className="h-stat-lbl">{s.label}</div>
                                    </div>
                                ))}
                            </div>
                        )}
                    </div>
                </div>
            )}
            
            <div className="table-toolbar" id={`toolbar-${secIdx}`}>
                <div className="search-input">
                    <Search size={16} />
                    <input 
                        type="text" 
                        className="search-field" 
                        placeholder="Search team, repository, configs..." 
                        value={globalFilter}
                        onChange={handleSearch}
                    />
                </div>
                <div className="filter-controls" style={{ display: 'flex', alignItems: 'center', gap: '24px' }}>
                    {!section.tableOptions?.hideExport && (
                        <button
                            aria-label="Export CSV"
                            onClick={() => exportTableToCsv(table, section.headers, section.title)}
                            style={{
                                display: 'inline-flex', alignItems: 'center', gap: '6px',
                                background: 'none',
                                border: '1px solid var(--border-subtle, rgba(255,255,255,0.08))',
                                borderRadius: '6px',
                                color: 'var(--text-tertiary)',
                                fontSize: '12px',
                                fontFamily: 'var(--font-sans)',
                                padding: '5px 12px 5px 10px',
                                cursor: 'pointer',
                                transition: 'all 0.15s ease',
                                letterSpacing: '0.01em',
                                whiteSpace: 'nowrap'
                            }}
                            onMouseEnter={e => {
                                e.currentTarget.style.color = 'var(--text-primary)';
                                e.currentTarget.style.borderColor = 'var(--border-hover, rgba(255,255,255,0.2))';
                                e.currentTarget.style.background = 'var(--bg-surface, rgba(255,255,255,0.04))';
                            }}
                            onMouseLeave={e => {
                                e.currentTarget.style.color = 'var(--text-tertiary)';
                                e.currentTarget.style.borderColor = 'var(--border-subtle, rgba(255,255,255,0.08))';
                                e.currentTarget.style.background = 'none';
                            }}
                        >
                            <Download size={13} />
                            Export
                        </button>
                    )}
                    <div className="table-metadata">
                        {table.getFilteredRowModel().rows.length} rows
                    </div>
                    <PaginationControls />
                </div>
            </div>

            <div className="table-container spotlight-card">
                <div 
                    className="table-wrap"
                    onScroll={(e) => {
                        const target = e.currentTarget;
                        if (target.scrollLeft > 0) {
                            if (!target.classList.contains('is-scrolled')) target.classList.add('is-scrolled');
                        } else {
                            if (target.classList.contains('is-scrolled')) target.classList.remove('is-scrolled');
                        }
                    }}
                >
                    <table id={`table-${secIdx}`}>
                        <thead>
                        {table.getHeaderGroups().map(headerGroup => (
                            <tr key={headerGroup.id}>
                                {headerGroup.headers.map((header, index) => {
                                    const isSorted = header.column.getIsSorted();
                                    const meta = (header.column.columnDef.meta as any) || {};
                                    const customWidth = meta.width;
                                    const showFilter = meta.filter !== false;

                                    const headerTooltip: string | undefined = meta.tooltip;
                                    const headerLabelEl = (
                                        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                                            {flexRender(header.column.columnDef.header, header.getContext())}
                                        </span>
                                    );

                                    return (
                                        <th
                                            key={header.id}
                                            className={index === 0 ? 'sticky-col' : ''}
                                            style={{
                                                userSelect: 'none',
                                                width: customWidth || (index === 0 ? '28%' : undefined),
                                                minWidth: customWidth || undefined
                                            }}
                                        >
                                            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '4px', width: '100%', overflow: 'hidden' }}>
                                                <div
                                                    style={{
                                                        display: 'flex', alignItems: 'center', gap: '6px',
                                                        cursor: header.column.getCanSort() ? 'pointer' : 'default',
                                                        overflow: 'hidden', flex: 1
                                                    }}
                                                    onClick={header.column.getToggleSortingHandler()}
                                                >
                                                    {headerTooltip ? (
                                                        <SimpleTooltip content={headerTooltip} side="top">
                                                            <span style={{ display: 'inline-flex', alignItems: 'center', minWidth: 0 }}>
                                                                {headerLabelEl}
                                                            </span>
                                                        </SimpleTooltip>
                                                    ) : headerLabelEl}
                                                    <div style={{ flexShrink: 0, display: 'flex' }}>
                                                        {isSorted === 'asc' ? <ArrowUp size={14} style={{ opacity: 0.6 }} /> :
                                                         isSorted === 'desc' ? <ArrowDown size={14} style={{ opacity: 0.6 }} /> :
                                                         null}
                                                    </div>
                                                </div>
                                                {showFilter && (
                                                    <div style={{ flexShrink: 0 }}>
                                                        {meta.filterMode === 'semver'
                                                            ? <SemverFilter column={header.column} table={table} />
                                                            : <ColumnFilter column={header.column} table={table} />
                                                        }
                                                    </div>
                                                )}
                                            </div>
                                        </th>
                                    );
                                })}
                            </tr>
                        ))}
                    </thead>
                    <tbody>
                        {table.getRowModel().rows.map(row => {
                            const drawerData = row.original.drawerData;
                            const isClickable = !!onRowClick && !!drawerData;
                            const rowId = row.original.id;
                            const isSelected = !!selectedRowId && rowId === selectedRowId;
                            return (
                                <tr
                                    key={row.id}
                                    className={[
                                        row.depth > 0 ? 'sub-row' : '',
                                        isClickable ? 'tr--clickable' : '',
                                        isSelected ? 'tr--selected' : '',
                                    ].filter(Boolean).join(' ')}
                                    onClick={(e) => {
                                        const target = e.target as HTMLElement;
                                        if (target.closest('a') || target.closest('button')) return;
                                        if (isClickable) onRowClick(drawerData!);
                                    }}
                                >
                                    {row.getVisibleCells().map((cell, index) => {
                                        const meta = (cell.column.columnDef.meta as any) || {};
                                        const customWidth = meta.width;
                                        return (
                                            <td
                                                key={cell.id}
                                                className={index === 0 ? 'sticky-col' : ''}
                                                style={{
                                                    width: customWidth,
                                                    whiteSpace: meta.nowrap ? 'nowrap' : undefined,
                                                    fontFamily: meta.nowrap ? "'JetBrains Mono', monospace" : undefined,
                                                    fontSize: meta.nowrap ? '12px' : undefined,
                                                    color: meta.nowrap ? 'var(--text-secondary)' : undefined,
                                                    ...(index === 0 ? {
                                                        paddingLeft: row.depth === 0 ? '20px' : `calc(20px + ${row.depth * 1.5}rem)`,
                                                        maxWidth: meta.nowrap ? 'none' : (meta.maxWidth || customWidth || '220px'),
                                                        overflow: meta.nowrap ? 'visible' : 'hidden',
                                                        whiteSpace: 'nowrap',
                                                        width: customWidth || '28%'
                                                    } : {})
                                                }}
                                            >
                                                {flexRender(cell.column.columnDef.cell, cell.getContext())}
                                            </td>
                                        );
                                    })}
                                </tr>
                            );
                        })}
                        {table.getRowModel().rows.length === 0 && (
                            <tr>
                                <td colSpan={columns.length} style={{ textAlign: 'center', padding: '24px' }}>
                                    No results found.
                                </td>
                            </tr>
                        )}
                    </tbody>
                </table>
                </div>
            </div>
            
            {table.getPageCount() > 1 && (
                <div className="table-toolbar" style={{ marginTop: '16px', justifyContent: 'flex-end' }}>
                    <div className="filter-controls" style={{ display: 'flex', alignItems: 'center', gap: '24px' }}>
                        <div className="table-metadata">
                            {table.getFilteredRowModel().rows.length} rows
                        </div>
                        <PaginationControls />
                    </div>
                </div>
            )}

            <ListPopover
                open={!!popover}
                anchor={popover?.anchor ?? null}
                title={popover?.title ?? ''}
                items={popover?.items ?? []}
                onClose={() => setPopover(null)}
            />
        </section>
    );
}
