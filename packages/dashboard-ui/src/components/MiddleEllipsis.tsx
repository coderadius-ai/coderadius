import type { CSSProperties } from 'react';

/**
 * Smart middle-ellipsis: truncates the prefix while preserving
 * the last segment after a separator (/, :, .).
 */
export function splitForMiddleEllipsis(
    text: string,
    separators = ['/', ':', '.'],
): { head: string; tail: string } | null {
    let lastIdx = -1;
    for (const sep of separators) {
        const idx = text.lastIndexOf(sep);
        if (idx > lastIdx) lastIdx = idx;
    }
    if (lastIdx < 0 || lastIdx >= text.length - 1) return null;
    return {
        head: text.slice(0, lastIdx + 1),
        tail: text.slice(lastIdx + 1),
    };
}

export function MiddleEllipsis({
    text,
    separators,
    className,
    style,
    noTitle,
}: {
    text: string;
    separators?: string[];
    className?: string;
    style?: CSSProperties;
    noTitle?: boolean;
}) {
    const split = splitForMiddleEllipsis(text, separators);
    const cls = `cr-mid-ellipsis${className ? ` ${className}` : ''}`;
    const titleProp = noTitle ? undefined : text;
    if (!split) {
        return (
            <span className={cls} title={titleProp} style={style}>
                <span className="cr-mid-ellipsis__head">{text}</span>
            </span>
        );
    }
    return (
        <span className={cls} title={titleProp} style={style}>
            <span className="cr-mid-ellipsis__head">{split.head}</span>
            <span className="cr-mid-ellipsis__tail">{split.tail}</span>
        </span>
    );
}
