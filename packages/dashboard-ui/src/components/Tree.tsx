import type { TreeSection, TreeNode as ITreeNode } from '@coderadius/types';
import { Badges } from './Badges';

const TreeNode = ({ node, isRoot = false }: { node: ITreeNode; isRoot?: boolean }) => {
    const icon = node.isFunction ? (
        <svg className="icon color-text-yellow" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M5 19l4-14h4" />
            <path d="M5 12h10" />
        </svg>
    ) : (
        <svg className="icon color-text-blue" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"></path>
            <polyline points="3.27 6.96 12 12.01 20.73 6.96"></polyline>
            <line x1="12" y1="22.08" x2="12" y2="12"></line>
        </svg>
    );

    return (
        <div className={`tree-node ${isRoot ? 'tree-root-node' : ''}`}>
            <div className={`tree-node-content ${node.isFunction ? 'tree-fn' : ''}`}>
                <span className="tree-icon-wrapper">{icon}</span>
                <span className="tree-label">{node.label}</span>
                <Badges badges={node.badges as any} />
            </div>
            {node.meta && node.meta.length > 0 && (
                <div className="tree-meta">{node.meta.join(' · ')}</div>
            )}
            {node.children && node.children.length > 0 && (
                <div className="tree-children">
                    {node.children.map((c, i) => (
                        <TreeNode key={i} node={c} isRoot={false} />
                    ))}
                </div>
            )}
        </div>
    );
};

export function Tree({ section }: { section: TreeSection }) {
    return (
        <section className="stagger-3">
            <h2>{section.title}</h2>
            <div>
                {section.nodes && section.nodes.length > 0 ? (
                    section.nodes.map((n, i) => (
                        <div key={i} className="tree-root spotlight-card">
                            <TreeNode node={n} isRoot={true} />
                        </div>
                    ))
                ) : (
                    <p className="color-text-tertiary" style={{ fontSize: '14px' }}>Empty tree.</p>
                )}
            </div>
        </section>
    );
}
