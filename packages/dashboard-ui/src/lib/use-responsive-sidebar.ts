import { useEffect, useState } from 'react';

// Auto-collapse threshold: anything ≤14" MacBook (1512px CSS) gets the
// icon-rail by default. 16" MBP (1728), 1080p/1440p externals stay expanded.
const NARROW_QUERY = '(max-width: 1535px)';

export function useResponsiveSidebar(): [boolean, (next: boolean) => void] {
    const [collapsed, setCollapsed] = useState<boolean>(() => {
        if (typeof window === 'undefined') return true;
        return window.matchMedia(NARROW_QUERY).matches;
    });

    useEffect(() => {
        if (typeof window === 'undefined') return;
        const mq = window.matchMedia(NARROW_QUERY);
        const sync = (e: MediaQueryListEvent) => setCollapsed(e.matches);
        mq.addEventListener('change', sync);
        return () => mq.removeEventListener('change', sync);
    }, []);

    return [collapsed, setCollapsed];
}
