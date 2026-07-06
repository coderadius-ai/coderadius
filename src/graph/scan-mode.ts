export const SCAN_MODES = ['structure', 'semantic', 'contracts'] as const;

export type ScanMode = typeof SCAN_MODES[number];

/** Legacy scan mode values stored in existing graph data (fast → semantic, deep → contracts) */
const LEGACY_MAP: Record<string, ScanMode> = {
    'fast': 'semantic',
    'deep': 'contracts',
};

export function parseScanMode(scanMode: string | null | undefined): ScanMode | null {
    if (!scanMode) return null;
    if (scanMode === 'structure' || scanMode === 'semantic' || scanMode === 'contracts') {
        return scanMode;
    }
    // Backward compat: existing graph data may have 'fast' or 'deep'
    return LEGACY_MAP[scanMode] ?? null;
}

export function isCompatibleScanMode(
    scanMode: string | null | undefined,
    requestedMode: ScanMode,
): boolean {
    const parsed = parseScanMode(scanMode);
    if (!parsed) return false;

    if (requestedMode === 'contracts') {
        return parsed === 'contracts';
    }

    // 'semantic' is compatible with both 'semantic' and 'contracts'
    if (requestedMode === 'semantic') {
        return parsed === 'semantic' || parsed === 'contracts';
    }

    // 'structure' is compatible with any
    return true;
}

export function resolveScanMode(scanMode: string | null | undefined): ScanMode | null {
    return parseScanMode(scanMode);
}
