import { useCallback, useMemo, useState } from 'react';
import { ChevronRight } from 'lucide-react';
import type { TopologySchema } from '@coderadius/shared-types';
import { buildFileUrl } from '../../../lib/git-url';
import { SchemaFormatBadge } from '../../Taxonomy';

interface SchemaTree {
    [key: string]: {
        type?: string | null;
        required?: boolean;
        children?: SchemaTree;
    };
}

function buildSchemaTree(fields: any[]): SchemaTree {
    const tree: SchemaTree = {};
    for (const f of fields) {
        const parts = f.name.split('.');
        let current = tree;
        for (let i = 0; i < parts.length; i++) {
            const part = parts[i];
            if (i === parts.length - 1) {
                if (!current[part]) current[part] = {};
                current[part].type = f.type;
                if (f.required !== undefined) current[part].required = f.required;
            } else {
                if (!current[part]) current[part] = {};
                if (!current[part].children) current[part].children = {};
                current = current[part].children!;
            }
        }
    }
    return tree;
}

function SchemaTreeNode({ name, node }: { name: string; node: any }) {
    const [expanded, setExpanded] = useState(false);
    const hasChildren = node.children && Object.keys(node.children).length > 0;

    return (
        <div className="blast-schema-tree__node-wrap">
            <div
                className={`blast-schema-field blast-schema-field--tree ${hasChildren ? 'blast-schema-field--folder' : ''}`}
                onClick={() => hasChildren && setExpanded(!expanded)}
                role={hasChildren ? 'button' : undefined}
                tabIndex={hasChildren ? 0 : undefined}
            >
                {hasChildren ? (
                    <span className="blast-schema-tree__toggle">
                        <ChevronRight size={14} strokeWidth={2} className={`blast-schema-tree__chevron ${expanded ? 'blast-schema-tree__chevron--open' : ''}`} />
                    </span>
                ) : (
                    <span className="blast-schema-tree__leaf-spacer" />
                )}

                <span className="blast-schema-field__name">
                    {name}
                    {node.required === false && <span className="blast-schema-field__optional-badge">?</span>}
                </span>

                {node.type && <span className="blast-schema-field__type">: {node.type}</span>}
            </div>

            {hasChildren && expanded && (
                <div className="blast-schema-tree__children">
                    {Object.entries(node.children).map(([childName, childNode]) => (
                        <SchemaTreeNode key={childName} name={childName} node={childNode} />
                    ))}
                </div>
            )}
        </div>
    );
}

export function EventSchemaPanel({ schema, repoUrl }: { schema: TopologySchema; repoUrl?: string | null }) {
    const [copied, setCopied] = useState(false);
    const fields = schema.fields;

    const tree = useMemo(() => buildSchemaTree(fields), [fields]);

    const sourcePaths = schema.sourcePaths || [];
    const primaryPath = sourcePaths[0];
    const displayName = primaryPath || schema.name;

    let linkPath = primaryPath;
    if (linkPath?.startsWith('/')) {
        linkPath = linkPath.replace(/^\/+/, '');
    }

    const finalRepoUrl = schema.repoUrl || repoUrl;
    const branch = schema.mainBranch ?? 'main';
    const fileUrl = buildFileUrl(finalRepoUrl, linkPath, branch);

    const handleCopy = useCallback(() => {
        const text = fields.map(f => `${f.name}${f.type ? `: ${f.type}` : ''}`).join('\n');
        navigator.clipboard.writeText(text).then(() => {
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
        });
    }, [fields]);

    const sectionLabel = schema.role === 'request' ? 'Request Schema'
        : schema.role === 'response' ? 'Response Schema'
        : schema.role === 'table' ? 'Table Schema'
        : 'Event Schema';

    return (
        <div className="blast-drawer__section">
            <span className="blast-drawer__section-label">{sectionLabel}</span>
            <div className="blast-schema-card">
                <div className="blast-schema-card__header">
                    <div className="blast-schema-card__title">
                        <div className="blast-schema-card__name-wrapper" style={{ alignItems: 'center', flexWrap: 'nowrap' }}>
                            {schema.format && <SchemaFormatBadge format={schema.format} size="sm" />}
                            {fileUrl ? (
                                <a
                                    href={fileUrl}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    className="blast-schema-card__name blast-schema-card__name--link"
                                    title={`Open ${displayName}`}
                                    style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}
                                >
                                    {displayName}
                                </a>
                            ) : (
                                <span className="blast-schema-card__name" style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{displayName}</span>
                            )}
                        </div>
                    </div>
                    <span className="blast-schema-card__count">
                        {fields.length} {fields.length === 1 ? 'field' : 'fields'}
                    </span>
                    {fields.length > 0 && (
                        <button
                            className={`blast-drawer__func-copy${copied ? ' blast-drawer__func-copy--done' : ''}`}
                            onClick={(e) => {
                                e.preventDefault();
                                e.stopPropagation();
                                handleCopy();
                            }}
                            title={copied ? 'Copied!' : 'Copy schema fields'}
                            aria-label="Copy schema fields"
                            style={{ opacity: 1 }}
                        >
                            {copied ? (
                                <svg width="11" height="11" viewBox="0 0 12 12" fill="none" aria-hidden="true"><polyline points="2,6 5,9 10,3" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"/></svg>
                            ) : (
                                <svg width="11" height="11" viewBox="0 0 12 12" fill="none" aria-hidden="true"><rect x="4" y="1" width="7" height="8" rx="1.2" stroke="currentColor" strokeWidth="1.2"/><rect x="1" y="3.5" width="7" height="8" rx="1.2" stroke="currentColor" strokeWidth="1.2" fill="var(--cr-bg-secondary, #111)"/></svg>
                            )}
                        </button>
                    )}
                </div>
                {fields.length > 0 && (
                    <div className="blast-schema-card__fields blast-schema-card__fields--tree">
                        {Object.entries(tree).map(([name, node]) => (
                            <SchemaTreeNode key={name} name={name} node={node} />
                        ))}
                    </div>
                )}
            </div>
        </div>
    );
}
