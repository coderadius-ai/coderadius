export interface Order {
    id: string;
    items: ReadonlyArray<{ sku: string; quantity: number }>;
}

export function buildOrder(items: Order['items']): Order {
    return { id: crypto.randomUUID(), items };
}
