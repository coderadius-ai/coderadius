/**
 * CI Component declaration utilities.
 *
 * Parses the `component:` keyword shape inside a GitLab CI `include:` block
 * and reconstructs the canonical raw template URL. The declaration shape and
 * URN builder are CI-tool-agnostic; the parser is GitLab-specific (the syntax
 * `host/path/name@ref` is GitLab Components 16.0+). A future GitHub Actions
 * reusable-workflow parser would slot in here under a different entry point
 * and stamp `tool: 'github-actions'` on the same `CIComponent` node shape.
 *
 * GitLab declaration shape:
 *   include:
 *     - component: gitlab.example.com/namespace/project/name@ref
 *       inputs:
 *         key: value
 *
 * URL pattern:
 *   https://{host}/{namespace/project}/-/raw/{ref}/templates/{name}/template.yml
 *
 * The fetch+resolve of the remote template (which would surface image, scripts,
 * deploy stages, review env) is a separate async concern. This module is pure
 * string parsing — no I/O.
 */

export interface CIComponentDeclaration {
    /** Original reference string, e.g. "gitlab.example.com/foo/bar/runner@main" */
    rawRef: string;
    /** Host, e.g. "gitlab.example.com" */
    host: string;
    /** Project path between host and component name, e.g. "foo/bar" */
    projectPath: string;
    /** Component name (the last path segment before @ref), e.g. "runner" */
    name: string;
    /** Git ref (branch, tag, or commit SHA), e.g. "main" or "1.2.3" */
    ref: string;
    /** Canonical raw URL of the component template */
    templateUrl: string;
    /** Optional inputs payload, JSON-serialized for graph storage */
    inputsJson?: string;
}

/**
 * Parse a GitLab `component:` ref string into its constituents and rebuild the
 * canonical raw template URL.
 *
 * Returns null if the ref is not a well-formed GitLab component reference.
 * Well-formed = "host/path/with/slashes/component-name@ref" with at least
 * one slash between host and name.
 */
export function parseGitLabComponentRef(rawRef: string, inputs?: unknown): CIComponentDeclaration | null {
    if (typeof rawRef !== 'string' || rawRef.length === 0) return null;

    const atIdx = rawRef.lastIndexOf('@');
    if (atIdx <= 0 || atIdx === rawRef.length - 1) return null;

    const left = rawRef.slice(0, atIdx);
    const ref = rawRef.slice(atIdx + 1).trim();
    if (!ref) return null;

    const slashIdx = left.indexOf('/');
    if (slashIdx <= 0) return null;
    const host = left.slice(0, slashIdx);
    const pathAndName = left.slice(slashIdx + 1);

    const lastSlash = pathAndName.lastIndexOf('/');
    if (lastSlash <= 0) return null;
    const projectPath = pathAndName.slice(0, lastSlash);
    const name = pathAndName.slice(lastSlash + 1);
    if (!projectPath || !name) return null;

    const templateUrl =
        `https://${host}/${projectPath}/-/raw/${ref}/templates/${name}/template.yml`;

    return {
        rawRef,
        host,
        projectPath,
        name,
        ref,
        templateUrl,
        inputsJson: inputs && typeof inputs === 'object'
            ? JSON.stringify(inputs)
            : undefined,
    };
}

/**
 * Build a stable URN for a CI component declaration. The CI tool
 * ('gitlab-ci', 'github-actions') is encoded in the URN so components from
 * different tools cannot collide even if they happen to share
 * host/path/name/ref strings.
 *
 * The URN encodes the full reference (tool + host + path + name + ref) so
 * that two pipelines pinning the same component at the same ref share one
 * node, while two pipelines pinning different refs of the same component
 * get separate nodes (intentional — different versions, potentially
 * different behaviour).
 */
export function ciComponentUrn(decl: CIComponentDeclaration, tool: string): string {
    return `cr:cicomponent:${tool}:${decl.host}:${decl.projectPath}:${decl.name}@${decl.ref}`;
}
