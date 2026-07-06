const CR_TO_OSV: Record<string, string> = {
    npm: 'npm',
    composer: 'Packagist',
    go: 'Go',
    pypi: 'PyPI',
};

export function toOsvEcosystem(crEcosystem: string): string | undefined {
    return CR_TO_OSV[crEcosystem];
}
