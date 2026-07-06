/**
 * Dismissable-layer helpers.
 *
 * A "dismissable layer" is a piece of UI (popover, dropdown, popper) that
 * closes when the user clicks somewhere "outside" it. The naive check
 * `layer.contains(event.target)` is wrong for any layer that paints
 * descendants via a React portal (tooltips, nested popovers, select
 * dropdowns): the portaled DOM lives under `document.body`, not under the
 * layer's element, so clicks on it look like outside-clicks and falsely
 * dismiss the layer.
 *
 * This module gives every layer a single rule for "is this click logically
 * inside me?":
 *
 *   1. The click target is a descendant of the layer's own DOM, OR
 *   2. The click target is inside a portaled element marked as part of any
 *      dismissable layer (via the `data-cr-layer-portal` attribute, or via
 *      the well-known `.cr-tooltip-content` class that wraps every
 *      `SimpleTooltip` portal — see `components/Tooltip.tsx`).
 *
 * Future portaled overlays opt in by setting `data-cr-layer-portal` on
 * their portal root; no caller has to special-case them again.
 */

const LAYER_PORTAL_ATTR = 'data-cr-layer-portal';

/**
 * Returns true when a click `target` should be considered "inside" the
 * given `layer` for dismissal purposes. Walks up from `target` looking
 * for: the layer itself, any tooltip portal (`.cr-tooltip-content`), or
 * any element carrying the `data-cr-layer-portal` attribute.
 *
 * Pass the result of `(e: MouseEvent).target` directly — it accepts
 * `EventTarget | null` for ergonomic call sites.
 */
export function isInsideLayer(
    target: EventTarget | null,
    layer: HTMLElement | null,
): boolean {
    if (!layer) return false;
    if (!(target instanceof Element)) return false;
    if (layer.contains(target)) return true;
    if (target.closest('.cr-tooltip-content')) return true;
    if (target.closest(`[${LAYER_PORTAL_ATTR}]`)) return true;
    return false;
}

/** Attribute name for opting a portal root into the dismissable-layer rule. */
export const LAYER_PORTAL_DATA_ATTR = LAYER_PORTAL_ATTR;
