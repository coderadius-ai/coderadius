import type { TopologyNode } from '@coderadius/shared-types';
import { ExternalLink } from 'lucide-react';
import { buildFileUrl } from '../../../lib/git-url';
import { RelBadge } from '../../Taxonomy';
import { splitQualifiedName } from '../lib/function-name';

/**
 * One function row in the drawer's "Code Evidence" list.
 *
 * The row is a link to the file (when we have a repo URL); the trailing copy
 * button copies the function name. `rels` is the per-function set of
 * relationships this function participates in for the currently-selected path
 * group — rendered as compact letter badges next to the name.
 */
export function FunctionItem({
    f,
    node,
    rels,
}: {
    f: { name: string; file: string | null; startLine?: number };
    node: TopologyNode;
    rels?: string[];
}) {
    const repoUrl = node.repository?.url ?? null;
    const branch = node.repository?.mainBranch ?? 'main';
    const fileUrl = buildFileUrl(repoUrl, f.file, branch, f.startLine);

    // Namespace-qualified names (PHP FQCNs) dim the namespace so the
    // Class.method tail leads. Two sibling spans, zero inserted characters:
    // selection, copy and find-in-page still see the byte-identical name.
    const { prefix, tail } = splitQualifiedName(f.name);

    const hasRels = rels && rels.length > 0;
    const inner = (
        <>
            <div style={{
                display: 'flex',
                alignItems: 'flex-start',
                justifyContent: 'space-between',
                gap: '8px',
                minWidth: 0,
            }}>
                {/* Left cluster: name + inline external-link icon. The
                    extlink sits next to the title (revealed on row hover)
                    rather than floating on the right of the card, so the
                    affordance reads as part of the title rather than a
                    separate trailing element. */}
                <span style={{ display: 'inline-flex', alignItems: 'flex-start', gap: '6px', flex: 1, minWidth: 0 }}>
                    <span className="blast-drawer__func-name" style={{ flex: 1, minWidth: 0 }}>
                        {prefix && <span className="blast-drawer__func-ns">{prefix}</span>}
                        {tail}
                    </span>
                    {fileUrl && (
                        <span className="blast-drawer__func-extlink" aria-hidden="true">
                            <ExternalLink size={10} />
                        </span>
                    )}
                </span>
                {hasRels && (
                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: '3px', flexShrink: 0, marginTop: '1px' }}>
                        {rels!.map((r, i) => (
                            <RelBadge key={`${r}-${i}`} rel={r} variant="letter" />
                        ))}
                    </span>
                )}
            </div>
            {f.file && <span className="blast-drawer__func-file">{f.file}</span>}
        </>
    );

    return (
        <li className="blast-drawer__func-item">
            {fileUrl ? (
                <a
                    href={fileUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="blast-drawer__func-row"
                >
                    {inner}
                </a>
            ) : (
                <div className="blast-drawer__func-row">
                    {inner}
                </div>
            )}
        </li>
    );
}
