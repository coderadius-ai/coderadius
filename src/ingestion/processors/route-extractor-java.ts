import type Parser from 'tree-sitter';

// ─── Java Route Extractor ───────────────────────────────────────────────────────
//
// Pure, framework-agnostic module for Java HTTP route detection. Mirrors the
// ATTRIBUTE strategy of route-extractor-php.ts (PHP 8 attributes → Java
// annotations).
//
// NO side effects. NO I/O. NO LLM. NO graph writes. Input → Output only.
//
// Frameworks supported (V1):
//   - Spring MVC / WebFlux
//       @RestController | @Controller  (class marker — required)
//       class-level   @RequestMapping("/prefix")            → path prefix
//       method-level  @GetMapping / @PostMapping / @PutMapping
//                     @PatchMapping / @DeleteMapping("/x")   → verb + path
//       method-level  @RequestMapping(value="/x",            → verb(s) from
//                                     method=RequestMethod.GET)  the method= arg
//   - JAX-RS (Jakarta REST / RESTEasy / Jersey)
//       class-level   @Path("/prefix")                       → path prefix
//       method-level  @GET | @POST | @PUT | @PATCH | @DELETE  → verb (marker)
//       method-level  @Path("/{id}")                          → sub-path
//
// Path params are already curly in both frameworks: Spring `/{id}` and JAX-RS
// `/{id}` (or `/{id:\\d+}`) → kept as `{id}` (lossless var-name preservation).
// ─────────────────────────────────────────────────────────────────────────────

// ─── Types ───────────────────────────────────────────────────────────────────

export type JavaRouteFramework = 'spring' | 'jaxrs';

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

/** One extracted Java route. One JavaRoute → one `::__route_handler` chunk. */
export interface JavaRoute {
    method: HttpMethod;
    path: string;
    framework: JavaRouteFramework;
}

// ─── Constants ────────────────────────────────────────────────────────────────

/** Spring `@<Verb>Mapping` annotation → HTTP method. */
const SPRING_MAPPING_METHOD: Record<string, HttpMethod> = {
    GetMapping: 'GET',
    PostMapping: 'POST',
    PutMapping: 'PUT',
    PatchMapping: 'PATCH',
    DeleteMapping: 'DELETE',
};

/** JAX-RS HTTP-verb marker annotations (`@GET`, `@POST`, ...). */
const JAXRS_HTTP_METHODS = new Set<HttpMethod>(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']);

/** Valid `RequestMethod.<X>` enum constants Spring exposes. */
const REQUEST_METHOD_VALUES = new Set<HttpMethod>(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']);

/** Spring class markers that make a class an HTTP controller. */
const SPRING_CONTROLLER_MARKERS = new Set(['RestController', 'Controller']);

/** Named annotation args that carry the route path (positional or named). */
const PATH_ARG_KEYS = ['value', 'path'];

// ─── Path Normalization ───────────────────────────────────────────────────────

/**
 * Normalize a Java route path to the CodeRadius canonical form.
 *
 * Variable names are PRESERVED (lossless) so the path matches an OpenAPI spec
 * verbatim. Conversions:
 *   {id}        → {id}     (already canonical curly form — Spring & JAX-RS)
 *   {id:\\d+}   → {id}     (JAX-RS inline regex: strip constraint, keep name)
 *   double //   → /
 *   trailing /  → stripped (except root)
 * Ensures the result starts with '/'.
 */
export function normalizeJavaPath(raw: string): string {
    let p = (raw ?? '').trim();
    p = p.replace(/^['"]|['"]$/g, '');
    // JAX-RS inline regex constraint: {id:\d+} → {id} (keep var name)
    p = p.replace(/\{([^}:]+):[^}]*\}/g, '{$1}');
    p = p.replace(/\/+/g, '/');
    if (p.length > 1 && p.endsWith('/')) p = p.slice(0, -1);
    if (!p.startsWith('/')) p = '/' + p;
    return p;
}

/** Concatenate a class-level prefix with a method-level sub-path. */
export function concatJavaPaths(prefix: string, suffix: string): string {
    const pfx = prefix && prefix.trim() ? normalizeJavaPath(prefix) : '';
    const sfx = suffix && suffix.trim() ? normalizeJavaPath(suffix) : '';
    if (!pfx && !sfx) return '/';
    if (!pfx) return sfx;
    if (!sfx || sfx === '/') return pfx;
    return normalizeJavaPath(pfx + sfx);
}

// ─── Entry Point ───────────────────────────────────────────────────────────────

/**
 * Extract all Java routes from a parsed file. Walks every class declaration,
 * runs the Spring and JAX-RS strategies, and deduplicates by (method, path).
 */
export function extractJavaRoutes(rootNode: Parser.SyntaxNode): JavaRoute[] {
    const routes: JavaRoute[] = [];

    const walk = (node: Parser.SyntaxNode): void => {
        if (node.type === 'class_declaration') {
            routes.push(...extractClassRoutes(node));
        }
        for (const child of node.children) walk(child);
    };
    walk(rootNode);

    const seen = new Set<string>();
    return routes.filter(r => {
        const key = `${r.method} ${r.path}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
    });
}

// ─── Class-Level Dispatch ──────────────────────────────────────────────────────

function extractClassRoutes(classNode: Parser.SyntaxNode): JavaRoute[] {
    const classAnnotations = annotationsOf(classNode);
    const annNames = new Set(classAnnotations.map(annotationName));

    const isSpringController = [...annNames].some(n => SPRING_CONTROLLER_MARKERS.has(n));
    const jaxrsPrefix = pathOfAnnotation(classAnnotations, 'Path');
    const isJaxrsResource = jaxrsPrefix !== null;

    if (!isSpringController && !isJaxrsResource) return [];

    const body = classNode.childForFieldName('body');
    if (!body) return [];

    const routes: JavaRoute[] = [];
    const springPrefix = pathOfAnnotation(classAnnotations, 'RequestMapping') ?? '';

    for (const member of body.children) {
        if (member.type !== 'method_declaration') continue;
        if (isSpringController) routes.push(...springMethodRoutes(member, springPrefix));
        if (isJaxrsResource) routes.push(...jaxrsMethodRoutes(member, jaxrsPrefix ?? ''));
    }
    return routes;
}

// ─── Spring Strategy ───────────────────────────────────────────────────────────

function springMethodRoutes(method: Parser.SyntaxNode, classPrefix: string): JavaRoute[] {
    const routes: JavaRoute[] = [];
    for (const ann of annotationsOf(method)) {
        const name = annotationName(ann);
        const verb = SPRING_MAPPING_METHOD[name];
        if (verb) {
            const path = annotationStringArg(ann, PATH_ARG_KEYS) ?? '';
            routes.push({ method: verb, path: concatJavaPaths(classPrefix, path), framework: 'spring' });
            continue;
        }
        if (name === 'RequestMapping') {
            routes.push(...requestMappingRoutes(ann, classPrefix));
        }
    }
    return routes;
}

/**
 * `@RequestMapping(value="/x", method=RequestMethod.GET)`. When `method=` is
 * absent we default to GET (conservative — avoids the 5-verb explosion of
 * Spring's "all methods" default for an unspecified mapping).
 */
function requestMappingRoutes(ann: Parser.SyntaxNode, classPrefix: string): JavaRoute[] {
    const path = annotationStringArg(ann, PATH_ARG_KEYS) ?? '';
    const fullPath = concatJavaPaths(classPrefix, path);
    const verbs = requestMappingHttpMethods(ann);
    const resolved = verbs.length > 0 ? verbs : (['GET'] as HttpMethod[]);
    return resolved.map(method => ({ method, path: fullPath, framework: 'spring' as JavaRouteFramework }));
}

// ─── JAX-RS Strategy ───────────────────────────────────────────────────────────

function jaxrsMethodRoutes(method: Parser.SyntaxNode, classPrefix: string): JavaRoute[] {
    const annotations = annotationsOf(method);
    const verbs = annotations
        .map(annotationName)
        .filter((n): n is HttpMethod => JAXRS_HTTP_METHODS.has(n as HttpMethod));
    if (verbs.length === 0) return [];

    const methodPath = pathOfAnnotation(annotations, 'Path') ?? '';
    const fullPath = concatJavaPaths(classPrefix, methodPath);
    return verbs.map(verb => ({ method: verb, path: fullPath, framework: 'jaxrs' as JavaRouteFramework }));
}

// ─── Annotation AST Helpers ─────────────────────────────────────────────────────

/** Collect `annotation` / `marker_annotation` nodes attached to a declaration. */
function annotationsOf(node: Parser.SyntaxNode): Parser.SyntaxNode[] {
    const out: Parser.SyntaxNode[] = [];
    for (const child of node.children) {
        if (child.type === 'modifiers') {
            for (const m of child.children) {
                if (m.type === 'annotation' || m.type === 'marker_annotation') out.push(m);
            }
        } else if (child.type === 'annotation' || child.type === 'marker_annotation') {
            out.push(child);
        }
    }
    return out;
}

/** Simple name of an annotation (last segment of a qualified name). */
function annotationName(ann: Parser.SyntaxNode): string {
    const nameNode = ann.childForFieldName('name');
    if (!nameNode) return '';
    return nameNode.text.split('.').pop() ?? '';
}

/** Path string of the first annotation whose simple name matches `name`. */
function pathOfAnnotation(annotations: Parser.SyntaxNode[], name: string): string | null {
    for (const ann of annotations) {
        if (annotationName(ann) === name) {
            return annotationStringArg(ann, PATH_ARG_KEYS) ?? '';
        }
    }
    return null;
}

/**
 * Resolve the path string of an annotation: a positional string literal, or a
 * `value=`/`path=` named argument. Returns null when no static string is
 * present (dynamic path — let downstream stages decide).
 */
function annotationStringArg(ann: Parser.SyntaxNode, keys: readonly string[]): string | null {
    const args = ann.childForFieldName('arguments');
    if (!args) return null;
    for (const child of args.children) {
        if (child.type === 'string_literal') return unquoteString(child);
        if (child.type === 'array_initializer') {
            const first = firstStringLiteral(child);
            if (first !== null) return first;
        }
        if (child.type === 'element_value_pair') {
            const value = pairValueForKeys(child, keys);
            if (value !== null) return value;
        }
    }
    return null;
}

function pairValueForKeys(pair: Parser.SyntaxNode, keys: readonly string[]): string | null {
    const key = pair.childForFieldName('key')?.text;
    if (!key || !keys.includes(key)) return null;
    const value = pair.childForFieldName('value');
    if (!value) return null;
    if (value.type === 'string_literal') return unquoteString(value);
    if (value.type === 'array_initializer') return firstStringLiteral(value);
    return null;
}

/** HTTP verbs declared by a `method=RequestMethod.X` (or array) named arg. */
function requestMappingHttpMethods(ann: Parser.SyntaxNode): HttpMethod[] {
    const args = ann.childForFieldName('arguments');
    if (!args) return [];
    for (const child of args.children) {
        if (child.type !== 'element_value_pair') continue;
        if (child.childForFieldName('key')?.text !== 'method') continue;
        return requestMethodConstants(child.childForFieldName('value'));
    }
    return [];
}

/** Collect `RequestMethod.<VERB>` constants from a value node (scalar or array). */
function requestMethodConstants(value: Parser.SyntaxNode | null): HttpMethod[] {
    const out: HttpMethod[] = [];
    const visit = (n: Parser.SyntaxNode | null | undefined): void => {
        if (!n) return;
        if (n.type === 'field_access' || n.type === 'identifier') {
            const seg = n.text.split('.').pop()?.toUpperCase() ?? '';
            if (REQUEST_METHOD_VALUES.has(seg as HttpMethod)) out.push(seg as HttpMethod);
            return;
        }
        for (const child of n.children) visit(child);
    };
    visit(value);
    return out;
}

function firstStringLiteral(node: Parser.SyntaxNode): string | null {
    const literal = node.children.find(c => c.type === 'string_literal');
    return literal ? unquoteString(literal) : null;
}

/**
 * Unquote a `string_literal` node. Slices the outer delimiter quotes off the
 * full literal text so embedded escapes (e.g. a JAX-RS regex `"/{id:\\d+}"`,
 * which tree-sitter splits into fragment + escape_sequence children) survive
 * intact for `normalizeJavaPath` to process.
 */
function unquoteString(node: Parser.SyntaxNode): string {
    const text = node.text;
    const first = text[0];
    if (text.length >= 2 && (first === '"' || first === "'") && text[text.length - 1] === first) {
        return text.slice(1, -1);
    }
    return text;
}
