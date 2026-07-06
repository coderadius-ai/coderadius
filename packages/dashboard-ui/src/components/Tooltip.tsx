import * as TooltipPrimitive from '@radix-ui/react-tooltip';
import React from 'react';
import type { ReactNode, CSSProperties } from 'react';

/* ── Re-export Radix primitives for advanced usage ────────────────── */
export const TooltipProvider = TooltipPrimitive.Provider;
export const TooltipRoot = TooltipPrimitive.Root;
export const TooltipTrigger = TooltipPrimitive.Trigger;
export const TooltipPortal = TooltipPrimitive.Portal;

/* ── Styled Content ───────────────────────────────────────────────── */
export function TooltipContent({
    children,
    side = 'top',
    sideOffset = 8,
    className,
    style,
    ...props
}: TooltipPrimitive.TooltipContentProps & { style?: CSSProperties }) {
    return (
        <TooltipPrimitive.Portal>
            <TooltipPrimitive.Content
                side={side}
                sideOffset={sideOffset}
                collisionPadding={12}
                className={`cr-tooltip-content ${className || ''}`}
                style={style}
                {...props}
            >
                {children}
                <TooltipPrimitive.Arrow className="cr-tooltip-arrow" width={10} height={5} />
            </TooltipPrimitive.Content>
        </TooltipPrimitive.Portal>
    );
}

/* ── SimpleTooltip ─────────────────────────────────────────────────── *
 * Drop-in tooltip wrapper. Uses `asChild` by default so the trigger
 * element is the child itself (no extra DOM nodes).
 *
 * When children is NOT a single React element (e.g. multiple children
 * or a string), we automatically wrap in a <span> to satisfy Radix's
 * Slot requirement (React.Children.only).
 * ─────────────────────────────────────────────────────────────────── */
interface SimpleTooltipProps {
    content: ReactNode;
    children: ReactNode;
    side?: 'top' | 'right' | 'bottom' | 'left';
    enabled?: boolean;
    delayDuration?: number;
}

export function SimpleTooltip({
    content,
    children,
    side = 'top',
    enabled = true,
    delayDuration = 120
}: SimpleTooltipProps) {
    if (!enabled || !content) return <>{children}</>;

    // Determine if children is a single valid React element.
    // If not, wrap in a <span> so Radix's asChild/Slot doesn't crash.
    const isSingleElement = React.isValidElement(children) && React.Children.count(children) === 1;
    const trigger = isSingleElement ? children : <div className="cr-tooltip-trigger">{children}</div>;

    return (
        <TooltipPrimitive.Root delayDuration={delayDuration}>
            <TooltipPrimitive.Trigger asChild>
                {trigger}
            </TooltipPrimitive.Trigger>
            <TooltipContent side={side}>{content}</TooltipContent>
        </TooltipPrimitive.Root>
    );
}
