import type { TopologyNode } from '@coderadius/shared-types';
import { NodeIcon } from '../../Taxonomy';
import { getServiceQualifier, useMultiServiceRepos } from '../hooks/MultiServiceReposContext';

/** Inline qualified name element: "context / name" for compact UI. */
export function QualifiedServiceName({
    node,
    urn,
    size = 11,
}: {
    node: TopologyNode;
    urn: string;
    size?: number;
}) {
    const ctx = getServiceQualifier(node, urn, useMultiServiceRepos());
    return (
        <>
            <div style={{ flexShrink: 0, display: 'flex', alignItems: 'center' }}>
                <NodeIcon type={node.type} size={size} />
            </div>
            <span className="cr-mid-ellipsis" style={{ display: 'flex' }}>
                {ctx ? (
                    <>
                        <span className="cr-mid-ellipsis__head">
                            <span className="cr-qualified__context">{ctx}</span>
                            <span className="cr-qualified__sep">/</span>
                        </span>
                        <span className="cr-mid-ellipsis__tail">{node.name}</span>
                    </>
                ) : (
                    <span className="cr-mid-ellipsis__head">{node.name}</span>
                )}
            </span>
        </>
    );
}
