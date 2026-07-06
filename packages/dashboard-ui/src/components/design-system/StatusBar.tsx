import type { ReactNode } from 'react';

export interface StatusBarProps {
    left: ReactNode;
    right: ReactNode;
    className?: string;
}

export function StatusBar({ left, right, className }: StatusBarProps) {
    return (
        <footer className={`cr-statusbar${className ? ` ${className}` : ''}`}>
            <div className="cr-statusbar__group">{left}</div>
            <div className="cr-statusbar__group">{right}</div>
        </footer>
    );
}

export function StatusBarSep() {
    return <span className="cr-statusbar__sep" aria-hidden="true">&middot;</span>;
}

export function StatusBarDot({ tone = 'ok' }: { tone?: 'ok' | 'warn' | 'danger' }) {
    return <span className={`cr-statusbar__dot cr-statusbar__dot--${tone}`} aria-hidden="true" />;
}

export function StatusBarOk({ children }: { children: ReactNode }) {
    return <span className="cr-statusbar__ok">{children}</span>;
}

export function StatusBarKbd({ children }: { children: ReactNode }) {
    return <kbd>{children}</kbd>;
}
