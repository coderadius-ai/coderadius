import { ChevronRight } from 'lucide-react';

/**
 * Trailing expand indicator for OperatorTable rows with `renderExpandedRow`.
 *
 * Render it in a dedicated last column (52px, right-aligned). The chevron is
 * purely presentational: rotation and signal color come from CSS keyed on the
 * table's `cr-operator-table__row--expanded` / `:hover` states, so no per-row
 * props are needed.
 */
export function RowExpand() {
    return (
        <span className="cr-row-expand" aria-hidden="true">
            <ChevronRight size={13} />
        </span>
    );
}
