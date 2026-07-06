import type { ValueFact } from '../value-resolution/types.js';

export interface ConfigValueProviderContext {
    relativePath: string;
    repoRoot: string;
    repoName: string;
}

export interface ConfigValueProvider {
    readonly id: string;
    readonly label: string;
    readonly contentSignatures?: RegExp[];

    matchFile(relativePath: string, basename: string): boolean;

    extractValueFacts(
        content: string,
        context: ConfigValueProviderContext,
    ): ValueFact[];
}
