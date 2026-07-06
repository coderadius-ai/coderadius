import { useEffect, type RefObject } from 'react';

const FOCUSABLE = [
    'a[href]',
    'button:not([disabled])',
    'input:not([disabled])',
    'textarea:not([disabled])',
    'select:not([disabled])',
    '[tabindex]:not([tabindex="-1"])',
].join(',');

export function useFocusTrap(ref: RefObject<HTMLElement | null>) {
    useEffect(() => {
        const container = ref.current;
        if (!container) return;

        const previouslyFocused = document.activeElement as HTMLElement | null;
        const firstFocusable = container.querySelector<HTMLElement>(FOCUSABLE);
        firstFocusable?.focus();

        function handleKeyDown(e: KeyboardEvent) {
            if (e.key !== 'Tab' || !container) return;
            const focusables = Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE));
            if (focusables.length === 0) return;

            const first = focusables[0];
            const last = focusables[focusables.length - 1];

            if (e.shiftKey && document.activeElement === first) {
                e.preventDefault();
                last.focus();
            } else if (!e.shiftKey && document.activeElement === last) {
                e.preventDefault();
                first.focus();
            }
        }

        container.addEventListener('keydown', handleKeyDown);
        return () => {
            container.removeEventListener('keydown', handleKeyDown);
            previouslyFocused?.focus();
        };
    }, [ref]);
}
