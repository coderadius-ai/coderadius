/** Per-node-type labels for the left/right columns of the explorer page. */
export function getColumnLabels(nodeType: string): {
    left: { title: string; desc: string };
    right: { title: string; desc: string };
} {
    switch (nodeType) {
        case 'Service':
            return {
                left: { title: 'Dependencies', desc: 'What this service needs to function' },
                right: { title: 'Impact Radius', desc: 'What breaks if this service fails' },
            };
        case 'DataContainer':
            return {
                left: { title: 'Written By', desc: 'Services that populate this data' },
                right: { title: 'Read By', desc: 'Services that consume this data' },
            };
        case 'MessageChannel':
            return {
                left: { title: 'Published By', desc: 'Services that emit to this channel' },
                right: { title: 'Subscribed By', desc: 'Services that listen on this channel' },
            };
        case 'APIEndpoint':
            return {
                // right → downstream: services that CALL this endpoint (consumers)
                right: { title: 'Called By', desc: 'Services that call this endpoint (consumers)' },
                // left → upstream: services that IMPLEMENT_ENDPOINT (expose it)
                left: { title: 'Served By', desc: 'Services that implement and expose this endpoint' },
            };
        default:
            return {
                left: { title: 'Upstream Providers', desc: 'Resources this node depends on' },
                right: { title: 'Downstream Consumers', desc: 'What breaks if this changes' },
            };
    }
}
