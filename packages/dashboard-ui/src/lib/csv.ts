/**
 * Escape a single value for inclusion in an RFC 4180 CSV row.
 * Coerces non-strings to string, collapses whitespace runs to a single space,
 * and quotes the field when it contains a separator, quote, or newline.
 */
export function csvEscape(val: unknown): string {
    const raw = val == null ? '' : String(val);
    const clean = raw.replace(/\s+/g, ' ').trim();
    if (clean.includes(',') || clean.includes('"') || clean.includes('\n')) {
        return `"${clean.replace(/"/g, '""')}"`;
    }
    return clean;
}

/**
 * Build a CSV blob from a header row and a list of data rows.
 * Both headers and cell values are escaped via `csvEscape`. Rows must already
 * be string-coercible by the caller.
 */
export function rowsToCsv(headers: string[], rows: unknown[][]): string {
    const lines: string[] = [headers.map(csvEscape).join(',')];
    for (const row of rows) {
        lines.push(row.map(csvEscape).join(','));
    }
    return lines.join('\n');
}

/**
 * Trigger a browser download for the given CSV payload under the chosen filename.
 */
export function downloadCsv(csv: string, filename: string): void {
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename.endsWith('.csv') ? filename : `${filename}.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
}
