import type Parser from 'tree-sitter';
import { stripPhpStringsAndComments } from '../core/languages/php/platform-io.js';

// ─── PHP Route Extractor ──────────────────────────────────────────────────────
//
// Pure, framework-agnostic module for PHP HTTP route detection.
//
// NO side effects. NO I/O. NO LLM. NO graph writes. Input → Output only.
//
// Frameworks supported (V1):
//   - Slim 4         ($app->get('/path', ...) + $app->group('/prefix', fn))
//   - Slim 3         (same API, backward compatible)
//   - Laravel        (Route::get('/path', ...) + Route::group() + Route::resource())
//   - Symfony        (#[Route('/path', methods: ['GET'])] + @Route annotations)
//   - CodeIgniter 4  ($routes->get('/path', ...) + #[HTTP('GET')] attribute)
//   - Lumen          ($router->get('/path', ...))
//   - WordPress REST (register_rest_route('ns', '/path', [...]))
//   - WordPress AJAX (add_action('wp_ajax_my_action', callback))
//   - Hyperf/Swoole  (#[GetMapping('/path')] #[Controller] attributes)
//   - Phalcon        (#[Get('/path')] or actionName() convention)
//   - Yii 2          (actionIndex() convention in Controller class)
//   - API Platform   (#[ApiResource] → full REST surface)
//   - Legacy PHP     (filesystem routing: catalogo.php has $_GET/echo → GET /catalogo.php)
//
// Explicitly NOT in V1:
//   - Route::group prefix concatenation (deferred, complex tree walk)
//   - Dynamic paths ($path variable) — skip, not deterministic
//   - Middleware-only closures
// ─────────────────────────────────────────────────────────────────────────────

// ─── Types ───────────────────────────────────────────────────────────────────

export type PhpRouteFramework =
    | 'slim'
    | 'laravel'
    | 'symfony'
    | 'codeigniter'
    | 'lumen'
    | 'wordpress-rest'
    | 'wordpress-ajax'
    | 'hyperf'
    | 'phalcon'
    | 'yii'
    | 'api-platform'
    | 'legacy-php';

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

/**
 * A single extracted PHP route.
 * One PhpRoute → one `::__route_handler` synthetic chunk.
 */
export interface PhpRoute {
    method: HttpMethod;
    path: string;
    framework: PhpRouteFramework;
}

// ─── Constants ────────────────────────────────────────────────────────────────

/** HTTP methods Slim/Laravel/etc. expose as direct call names. */
const DIRECT_HTTP_METHODS = new Set<string>(['get', 'post', 'put', 'patch', 'delete']);

/** Methods to expand when 'any'/'match' are used. */
const ALL_METHODS: HttpMethod[] = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'];

/** Route::resource() standard action map → 5 endpoint (API resource = no create/edit views). */
const RESOURCE_ROUTES: Array<{ method: HttpMethod; suffix: string }> = [
    { method: 'GET',    suffix: '' },         // index
    { method: 'POST',   suffix: '' },         // store
    { method: 'GET',    suffix: '/{id}' }, // show
    { method: 'PUT',    suffix: '/{id}' }, // update
    { method: 'DELETE', suffix: '/{id}' }, // destroy
];

/** Map from Hyperf/Phalcon attribute names to HTTP methods. */
const ATTRIBUTE_METHOD_MAP: Record<string, HttpMethod> = {
    GetMapping: 'GET', Get: 'GET',
    PostMapping: 'POST', Post: 'POST',
    PutMapping: 'PUT', Put: 'PUT',
    PatchMapping: 'PATCH', Patch: 'PATCH',
    DeleteMapping: 'DELETE', Delete: 'DELETE',
    RequestMapping: 'GET', // default; override via method arg
};

/** API Platform REST surface (GET collection, POST, GET item, PUT, PATCH, DELETE). */
const API_PLATFORM_ROUTES: Array<{ method: HttpMethod; suffix: string }> = [
    { method: 'GET',    suffix: '' },
    { method: 'POST',   suffix: '' },
    { method: 'GET',    suffix: '/{id}' },
    { method: 'PUT',    suffix: '/{id}' },
    { method: 'PATCH',  suffix: '/{id}' },
    { method: 'DELETE', suffix: '/{id}' },
];

// ─── Path Normalization ───────────────────────────────────────────────────────

/**
 * Normalize a PHP route path to the CodeRadius canonical form.
 *
 * Variable names are PRESERVED (lossless) so the path matches the OpenAPI
 * spec's path verbatim. The rewire's raw-path comparison
 * (rewireImplementsEdgesToOpenApi) requires byte equality with the
 * canonical OpenAPI path, which is also written via normalizeApiPathLossless.
 *
 * Conversions:
 *   {id}           → {id}       (named param: var name preserved)
 *   {id:\d+}       → {id}       (Slim inline regex: strip constraint, keep name)
 *   :id            → {id}       (legacy colon param → curly syntax)
 *   *              → {splat}    (wildcard → canonical name)
 *   [optional]     → stripped   (CI4 optional segment — treated as absent)
 *   trailing /     → stripped   (canonical: no trailing slash)
 *   double //      → /          (normalization)
 *
 * Ensures result always starts with '/'.
 */
export function normalizePhpPath(raw: string): string {
    let p = raw.trim();

    // Strip surrounding quotes if accidentally included
    p = p.replace(/^['"]|['"]$/g, '');

    // Slim inline regex: {id:\d+} → {id}  (strip regex constraint, keep var name)
    p = p.replace(/\{([^}:]+):[^}]+\}/g, '{$1}');

    // Named params {id}, {slug}, {name} are already in the canonical curly form.

    // Legacy colon params: :id → {id}  (preserve var name)
    p = p.replace(/:([a-zA-Z_][a-zA-Z0-9_]*)/g, '{$1}');

    // Wildcard segments → {splat}  (canonical anonymous wildcard)
    p = p.replace(/\*/g, '{splat}');

    // CI4 optional segments [segment] → strip
    p = p.replace(/\[[^\]]*\]/g, '');

    // Normalize multiple slashes
    p = p.replace(/\/+/g, '/');

    // Strip trailing slash (except root)
    if (p.length > 1 && p.endsWith('/')) p = p.slice(0, -1);

    // Ensure leading slash
    if (!p.startsWith('/')) p = '/' + p;

    return p;
}

/**
 * Concatenate a group prefix with a nested route path.
 * Handles double-slash prevention and root-path edge cases.
 */
export function concatPaths(prefix: string, suffix: string): string {
    const p = normalizePhpPath(prefix);
    const s = normalizePhpPath(suffix);
    if (s === '/') return p || '/';
    return normalizePhpPath(p + s);
}

// ─── Core Extraction Functions ────────────────────────────────────────────────

/**
 * Extract all PHP routes from a parsed file.
 *
 * This is the main entry point. It runs all strategy detectors in sequence
 * and deduplicates by (method, path).
 *
 * @param rootNode  - Tree-sitter root node of the parsed PHP file.
 * @param source    - Raw source text (used for regex-based Symfony annotation detection).
 * @param filepath  - Relative file path (used for Yii convention detection).
 */
export function extractPhpRoutes(
    rootNode: Parser.SyntaxNode,
    source: string,
    filepath: string,
): PhpRoute[] {
    const routes: PhpRoute[] = [];

    // Strategy 1: Call-expression based (Slim / Laravel / Lumen / CodeIgniter / WordPress)
    routes.push(...extractCallExpressionRoutes(rootNode, source));

    // Strategy 2: PHP 8 attribute based (Symfony / Hyperf / Phalcon / CodeIgniter / API Platform)
    routes.push(...extractAttributeRoutes(rootNode, source));

    // Strategy 3: DocBlock annotation based (Symfony legacy @Route)
    routes.push(...extractDocBlockRoutes(source));

    // Strategy 4: Action method convention (Yii 2 / Phalcon actionXxx())
    routes.push(...extractConventionRoutes(rootNode, filepath));

    // Deduplicate by (method, path)
    const seen = new Set<string>();
    return routes.filter(r => {
        const key = `${r.method}:${r.path}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
    });
}

// ─── Strategy 1: Call Expression Routes ──────────────────────────────────────

/**
 * Extract routes from call expressions:
 *   $app->get('/path', ...)             — Slim
 *   $router->get('/path', ...)          — Lumen / generic
 *   Route::get('/path', ...)            — Laravel static facade
 *   Route::resource('/resource', ...)   — Laravel resource
 *   Route::apiResource('/resource', ...)
 *   $routes->get('/path', ...)          — CodeIgniter 4
 *   register_rest_route('ns', '/path', [...]) — WordPress REST
 *
 * Also handles group() with prefix recursion:
 *   $app->group('/api', function($group) { $group->get('/users', ...) })
 */
export function extractCallExpressionRoutes(
    rootNode: Parser.SyntaxNode,
    _source: string,
): PhpRoute[] {
    const routes: PhpRoute[] = [];
    walkCallExpressions(rootNode, routes, '');
    return routes;
}

/**
 * Recursive AST walker for call expressions.
 * Carries `prefixStack` to handle nested group() calls.
 */
function walkCallExpressions(
    node: Parser.SyntaxNode,
    routes: PhpRoute[],
    prefix: string,
): void {
    if (node.type === 'expression_statement' || node.type === 'echo_statement') {
        for (const child of node.children) walkCallExpressions(child, routes, prefix);
        return;
    }

    if (node.type === 'member_call_expression') {
        const extracted = handleMethodCall(node, prefix);
        if (extracted) {
            if (extracted.type === 'route') routes.push(...extracted.routes);
            if (extracted.type === 'group') {
                // Recurse into the group closure body
                const closureBody = findClosureBody(node);
                if (closureBody) {
                    const newPrefix = concatPaths(prefix, extracted.prefix);
                    walkCallExpressions(closureBody, routes, newPrefix);
                }
                return;
            }
        }
    }

    if (node.type === 'scoped_call_expression') {
        const extracted = handleStaticCall(node, prefix);
        if (extracted) routes.push(...extracted);
    }

    if (node.type === 'function_call_expression') {
        const extracted = handleFunctionCall(node, prefix);
        if (extracted) routes.push(...extracted);
    }

    for (const child of node.children) walkCallExpressions(child, routes, prefix);
}

type MethodCallResult =
    | { type: 'route'; routes: PhpRoute[] }
    | { type: 'group'; prefix: string }
    | null;

/**
 * Handle $obj->method(...) calls.
 * Returns null if not a recognized routing call.
 */
function handleMethodCall(node: Parser.SyntaxNode, prefix: string): MethodCallResult {
    const nameNode = node.childForFieldName('name');
    if (!nameNode) return null;
    const methodName = nameNode.text.toLowerCase();

    // Skip $this->xxx() calls — these are service/domain method calls, not route registrations.
    // A routing call is always made on an $app / $router / $routes variable, never on $this.
    // This prevents false positives from $this->client->post('/url', ...) in service classes.
    const objectNode = node.children[0]; // first child is the object expression
    if (objectNode?.text?.startsWith('$this')) return null;

    // Get arguments node
    const argsNode = node.childForFieldName('arguments');
    if (!argsNode) return null;
    const args = getCallArguments(argsNode);

    // group('/prefix', closure) → recurse
    if (methodName === 'group') {
        const rawPrefix = extractStringLiteral(args[0]);
        if (rawPrefix === null) return null; // dynamic prefix — skip
        return { type: 'group', prefix: rawPrefix };
    }

    // map(['GET', 'POST'], '/path', handler) — Slim-style multi-method
    // Note: args[0] = methods array, args[1] = path (opposite of what one might expect)
    if (methodName === 'map') {
        const methods = extractStringArray(args[0]);
        const rawPath = extractStringLiteral(args[1]);
        if (rawPath === null || methods.length === 0) return null;
        const fullPath = concatPaths(prefix, rawPath);
        return {
            type: 'route',
            routes: methods.flatMap(m => resolveMethod(m, fullPath, 'slim')),
        };
    }

    // any('/path', handler) — all methods
    if (methodName === 'any') {
        const rawPath = extractStringLiteral(args[0]);
        if (rawPath === null) return null;
        const fullPath = concatPaths(prefix, rawPath);
        return {
            type: 'route',
            routes: ALL_METHODS.map(m => ({ method: m, path: fullPath, framework: 'slim' as PhpRouteFramework })),
        };
    }

    // get/post/put/patch/delete('/path', handler)
    if (DIRECT_HTTP_METHODS.has(methodName)) {
        const rawPath = extractStringLiteral(args[0]);
        if (rawPath === null) return null;
        // Route paths MUST start with '/'. Arguments like 'ORDER_REF', 'channel',
        // 'routing_key' etc. are query-string keys or domain object property names,
        // not URL route paths. Reject them here to prevent false-positive route chunks.
        if (!rawPath.startsWith('/')) return null;
        const method = methodName.toUpperCase() as HttpMethod;
        const fullPath = concatPaths(prefix, rawPath);
        // Detect Lumen vs Slim by variable name (best-effort; labelled as 'slim' covers both)
        return { type: 'route', routes: [{ method, path: fullPath, framework: 'slim' }] };
    }

    return null;
}

/**
 * Handle Route::method(...) or Route::resource(...) scoped static calls (Laravel).
 * tree-sitter PHP uses `scoped_call_expression` for `ClassName::method()`.
 */
function handleStaticCall(node: Parser.SyntaxNode, prefix: string): PhpRoute[] {
    // Check the class name is 'Route' (field: 'scope')
    const classNode = node.childForFieldName('scope') ?? node.childForFieldName('class');
    if (!classNode || classNode.text !== 'Route') return [];

    const nameNode = node.childForFieldName('name');
    if (!nameNode) return [];
    const methodName = nameNode.text.toLowerCase();

    const argsNode = node.childForFieldName('arguments');
    if (!argsNode) return [];
    const args = getCallArguments(argsNode);

    if (methodName === 'resource' || methodName === 'apiresource') {
        const rawPath = extractStringLiteral(args[0]);
        if (rawPath === null) return [];
        const basePath = concatPaths(prefix, rawPath);
        return RESOURCE_ROUTES.map(r => ({
            method: r.method,
            path: normalizePhpPath(basePath + r.suffix),
            framework: 'laravel' as PhpRouteFramework,
        }));
    }

    if (methodName === 'any') {
        const rawPath = extractStringLiteral(args[0]);
        if (rawPath === null) return [];
        const fullPath = concatPaths(prefix, rawPath);
        return ALL_METHODS.map(m => ({ method: m, path: fullPath, framework: 'laravel' as PhpRouteFramework }));
    }

    if (methodName === 'match') {
        // Route::match(['get', 'post'], '/path', handler)
        const methods = extractStringArray(args[0]);
        const rawPath = extractStringLiteral(args[1]);
        if (rawPath === null || methods.length === 0) return [];
        const fullPath = concatPaths(prefix, rawPath);
        return methods.flatMap(m => resolveMethod(m, fullPath, 'laravel'));
    }

    if (DIRECT_HTTP_METHODS.has(methodName)) {
        const rawPath = extractStringLiteral(args[0]);
        if (rawPath === null) return [];
        const method = methodName.toUpperCase() as HttpMethod;
        const fullPath = concatPaths(prefix, rawPath);
        return [{ method, path: fullPath, framework: 'laravel' }];
    }

    return [];
}

/**
 * Handle top-level function calls:
 *   register_rest_route('namespace', '/path', [...])  — WordPress REST API
 */
function handleFunctionCall(node: Parser.SyntaxNode, _prefix: string): PhpRoute[] {
    // tree-sitter PHP: function_call_expression has field 'function' (name node)
    const nameNode = node.childForFieldName('function') ?? node.childForFieldName('name');
    if (!nameNode) return [];

    if (nameNode.text === 'register_rest_route') {
        const argsNode = node.childForFieldName('arguments');
        if (!argsNode) return [];
        const args = getCallArguments(argsNode);
        // register_rest_route( $namespace, $route, $args )
        const rawNamespace = extractStringLiteral(args[0]);
        const rawPath = extractStringLiteral(args[1]);
        if (rawNamespace === null || rawPath === null) return [];

        // WordPress REST base: /wp-json/{namespace}{path}
        const fullPath = normalizePhpPath(`/wp-json/${rawNamespace}${rawPath}`);

        // Try to extract methods from the $args array literal
        const methods = extractWordPressRestMethods(args[2]);
        if (methods.length === 0) {
            // Default: GET + POST (most common)
            return [
                { method: 'GET', path: fullPath, framework: 'wordpress-rest' },
                { method: 'POST', path: fullPath, framework: 'wordpress-rest' },
            ];
        }
        return methods.flatMap(m => resolveMethod(m, fullPath, 'wordpress-rest'));
    }

    // ── WordPress AJAX hooks ───────────────────────────────────────────────────
    // add_action('wp_ajax_my_action', $callback)          — logged-in users
    // add_action('wp_ajax_nopriv_my_action', $callback)   — anonymous users
    //
    // Both forms map to:  POST /wp-admin/admin-ajax.php?action=my_action
    //
    // Why POST only: admin-ajax.php physically accepts GET/POST, but 99%+ of
    // WordPress plugins issue POST (form submit, $.ajax({type:'POST'})). Emitting
    // GET+POST per hook would pollute the graph with phantom GETs. The LLM
    // analyzes the callback body and will surface any explicit GET usage.
    //
    // Deduplication: wp_ajax_* and wp_ajax_nopriv_* for the same slug collapse
    // to one route because deduplicateRoutes() uses method+path as key.
    if (nameNode.text === 'add_action') {
        const argsNode = node.childForFieldName('arguments');
        if (!argsNode) return [];
        const args = getCallArguments(argsNode);
        const hook = extractStringLiteral(args[0]);
        if (hook === null) return [];
        const ajaxMatch = hook.match(/^wp_ajax(?:_nopriv)?_(.+)$/);
        if (!ajaxMatch) return []; // not a REST/AJAX hook (e.g. add_action('init', ...))
        const actionSlug = ajaxMatch[1];
        return [{
            method: 'POST' as HttpMethod,
            path: normalizePhpPath(`/wp-admin/admin-ajax.php?action=${actionSlug}`),
            framework: 'wordpress-ajax',
        }];
    }

    return [];
}

// ─── Strategy 2: PHP 8 Attribute Routes ──────────────────────────────────────

/**
 * Extract routes from PHP 8 attributes on classes and methods.
 *
 * Handles:
 *   #[Route('/path', methods: ['GET', 'POST'])]   — Symfony
 *   #[GetMapping('/path')]                         — Hyperf
 *   #[Get('/path')]                                — Phalcon
 *   #[ApiResource]                                 — API Platform
 *   #[HTTP('GET')]                                 — CodeIgniter 4
 *
 * Class-level #[Route] acts as prefix for method-level routes.
 * Class-level #[Controller('/prefix')] (Hyperf) acts as prefix.
 */
export function extractAttributeRoutes(
    rootNode: Parser.SyntaxNode,
    source: string,
): PhpRoute[] {
    const routes: PhpRoute[] = [];

    const walkClasses = (node: Parser.SyntaxNode): void => {
        if (node.type === 'class_declaration') {
            routes.push(...extractClassAttributeRoutes(node, source));
            return;
        }
        for (const child of node.children) walkClasses(child);
    };

    walkClasses(rootNode);
    return routes;
}

/**
 * Extract routes from a single class declaration's attributes and method attributes.
 */
function extractClassAttributeRoutes(classNode: Parser.SyntaxNode, _source: string): PhpRoute[] {
    const routes: PhpRoute[] = [];

    // --- Check for class-level API Platform #[ApiResource] ---
    const classPrefix = extractClassRoutePrefix(classNode);
    const isApiResource = hasAttribute(classNode, 'ApiResource');
    if (isApiResource) {
        // Derive resource path from class name: OrderEntity → /orders
        const className = classNode.childForFieldName('name')?.text ?? '';
        const resourcePath = classNameToResourcePath(className);
        for (const r of API_PLATFORM_ROUTES) {
            routes.push({
                method: r.method,
                path: normalizePhpPath(resourcePath + r.suffix),
                framework: 'api-platform',
            });
        }
        return routes; // API Platform → all REST routes covered, skip method scan
    }

    // --- Scan method-level attributes ---
    // PHP class body is a 'declaration_list' node (not 'body')
    const body = classNode.children.find(c => c.type === 'declaration_list');
    if (!body) return routes;

    for (const member of body.children) {
        if (member.type !== 'method_declaration') continue;

        const attrRoutes = extractMethodAttributeRoutes(member, classPrefix);
        routes.push(...attrRoutes);
    }

    return routes;
}

/**
 * Extract the route prefix from a class's own attributes.
 * Returns '' if no class-level route prefix is found.
 *
 * Handles:
 *   #[Route('/api/v1')]                 — Symfony class-level prefix
 *   #[Controller('/prefix')]            — Hyperf controller prefix
 */
function extractClassRoutePrefix(classNode: Parser.SyntaxNode): string {
    for (const child of classNode.children) {
        if (child.type !== 'attribute_list') continue;
        for (const group of child.children) {
            if (group.type !== 'attribute_group') continue;
            for (const attr of group.children) {
                if (attr.type !== 'attribute') continue;
                const attrName = getAttributeName(attr);

                if (attrName === 'Route' || attrName === 'Controller') {
                    // Arguments are directly children named 'arguments' on the attribute node
                    const argsNode = attr.children.find(c => c.type === 'arguments');
                    if (!argsNode) continue;
                    const args = getCallArguments(argsNode);
                    const firstStr = extractStringLiteral(args[0]);
                    if (firstStr !== null) return firstStr;
                }
            }
        }
    }
    return '';
}

/**
 * Extract routes from a method declaration's attributes.
 */
function extractMethodAttributeRoutes(methodNode: Parser.SyntaxNode, classPrefix: string): PhpRoute[] {
    const routes: PhpRoute[] = [];

    for (const child of methodNode.children) {
        if (child.type !== 'attribute_list') continue;
        for (const group of child.children) {
            if (group.type !== 'attribute_group') continue;
            for (const attr of group.children) {
                if (attr.type !== 'attribute') continue;
                const attrName = getAttributeName(attr);

                // Symfony: #[Route('/path', methods: ['GET', 'POST'])]
                if (attrName === 'Route') {
                    const path = getAttributeFirstStringArg(attr);
                    if (path === null) continue;
                    const fullPath = concatPaths(classPrefix, path);
                    const methods = getSymfonyAttributeMethods(attr);
                    if (methods.length === 0) {
                        // No methods= spec → defaults to all methods (Symfony behavior)
                        routes.push({ method: 'GET', path: fullPath, framework: 'symfony' });
                    } else {
                        for (const m of methods) {
                            routes.push(...resolveMethod(m, fullPath, 'symfony'));
                        }
                    }
                    continue;
                }

                // Hyperf: #[GetMapping('/path')] #[PostMapping('/path')]
                // Phalcon: #[Get('/path')] #[Post('/path')]
                // CodeIgniter: #[HTTP('GET')]
                if (attrName in ATTRIBUTE_METHOD_MAP) {
                    const method = ATTRIBUTE_METHOD_MAP[attrName];
                    const path = getAttributeFirstStringArg(attr) ?? '/';
                    const fullPath = concatPaths(classPrefix, path);
                    const framework: PhpRouteFramework = attrName.endsWith('Mapping') ? 'hyperf' : 'phalcon';
                    routes.push({ method, path: fullPath, framework });
                    continue;
                }

                // Hyperf: #[RequestMapping(path: '/path', methods: ['GET', 'POST'])]
                if (attrName === 'RequestMapping') {
                    const path = getAttributeNamedArg(attr, 'path') ?? getAttributeFirstStringArg(attr) ?? '/';
                    const fullPath = concatPaths(classPrefix, path);
                    const methods = getSymfonyAttributeMethods(attr);
                    if (methods.length === 0) {
                        routes.push({ method: 'GET', path: fullPath, framework: 'hyperf' });
                    } else {
                        for (const m of methods) {
                            routes.push(...resolveMethod(m, fullPath, 'hyperf'));
                        }
                    }
                    continue;
                }

                // CodeIgniter 4: #[HTTP('GET')]
                if (attrName === 'HTTP') {
                    const methodStr = getAttributeFirstStringArg(attr);
                    if (methodStr === null) continue;
                    const methodName = methodNode.childForFieldName('name')?.text ?? 'handler';
                    const path = '/' + methodName.toLowerCase();
                    routes.push(...resolveMethod(methodStr, concatPaths(classPrefix, path), 'codeigniter'));
                    continue;
                }
            }
        }
    }

    return routes;
}

// ─── Strategy 3: DocBlock Annotation Routes (Symfony Legacy) ─────────────────

/**
 * Extract Symfony @Route annotations from source text using a two-step approach.
 * Handles old-style DocBlock annotations (Symfony 3/4/5).
 *
 * Supported forms:
 *   @Route("/path")                                       — positional path
 *   @Route("/path", methods={"GET", "POST"})              — positional + methods
 *   @Route("/path", name="route_name", methods={"GET"})   — positional + name + methods
 *   @Route(path="/path", methods={"GET"})                 — named path (no positional)
 *   @Route(name="user_list", path="/api/users", methods={"GET"}) — name FIRST (enterprise pattern)
 *
 * Strategy:
 *   Step 1 — Extract the raw content between @Route( and the matching ).
 *   Step 2 — From the content, resolve path via:
 *            a) Explicit `path=` named argument (highest priority).
 *            b) First positional string literal (fallback, only if no `path=`).
 *   This avoids the "name=\"user_list\" mistaken for path" failure mode.
 */
export function extractDocBlockRoutes(source: string): PhpRoute[] {
    const routes: PhpRoute[] = [];

    // Step 1: locate each @Route(...) block in the source text.
    // We scan for `@Route(` and walk forward, counting parens to find the closing `)`.    
    // This correctly handles nested parentheses (e.g. regex constraints like {id:\d+}).
    const MARKER = '@Route(';
    let pos = 0;
    while ((pos = source.indexOf(MARKER, pos)) !== -1) {
        const openParen = pos + MARKER.length - 1; // index of '('
        let depth = 0;
        let end = openParen;
        for (let i = openParen; i < source.length; i++) {
            if (source[i] === '(') depth++;
            else if (source[i] === ')') {
                depth--;
                if (depth === 0) { end = i; break; }
            }
        }
        if (depth !== 0) { pos += MARKER.length; continue; } // unbalanced — skip

        const content = source.slice(openParen + 1, end); // text between the parens
        pos += MARKER.length; // advance to avoid infinite loop

        // Step 2a: try explicit `path=` or `path =` named argument first.
        //   Matches:  path="/api/users"  or  path='/api/users'
        const namedPathMatch = content.match(/\bpath\s*=\s*["']([^"']+)["']/);

        // Step 2b: fallback — first positional string literal at the start of the args.
        //   Only use if there is NO `path=` named arg anywhere in the content.
        const positionalMatch = !namedPathMatch
            ? content.match(/^\s*["']([^"']+)["']/)
            : null;

        const rawPath = namedPathMatch?.[1] ?? positionalMatch?.[1] ?? null;
        if (!rawPath) continue;

        const fullPath = normalizePhpPath(rawPath);

        // Extract methods={...}
        const methodsMatch = content.match(/\bmethods\s*=\s*\{([^}]*)\}/);
        if (!methodsMatch) {
            // No methods= → default GET
            routes.push({ method: 'GET', path: fullPath, framework: 'symfony' });
        } else {
            const methods = methodsMatch[1]
                .split(',')
                .map(m => m.replace(/["'\s]/g, '').toUpperCase())
                .filter(Boolean);
            for (const m of methods) {
                routes.push(...resolveMethod(m, fullPath, 'symfony'));
            }
        }
    }

    return routes;
}

// ─── Strategy 4: Convention-Based Routes (Yii 2 / Phalcon) ───────────────────

/**
 * Extract routes from controller action method naming conventions.
 *
 * Yii 2: actionIndex(), actionCreate(), actionUpdate($id) in a class extending Controller
 * Phalcon: indexAction(), createAction() in a class extending ControllerBase
 *
 * Only fires for files matching common controller path patterns.
 */
export function extractConventionRoutes(
    rootNode: Parser.SyntaxNode,
    filepath: string,
): PhpRoute[] {
    // Only process controller files
    const isControllerFile = /[Cc]ontroller(s)?[/\\]/.test(filepath) ||
        /Controller\.php$/.test(filepath);
    if (!isControllerFile) return [];

    const routes: PhpRoute[] = [];

    const walkClasses = (node: Parser.SyntaxNode): void => {
        if (node.type === 'class_declaration') {
            const baseClause = node.children.find(c => c.type === 'base_clause');
            const baseText = baseClause?.text ?? '';

            // Yii 2: extends Controller or \yii\web\Controller
            const isYii = /\bController\b/.test(baseText) || /yii/.test(baseText);
            // Phalcon: extends ControllerBase or \Phalcon\Mvc\Controller
            const isPhalcon = /ControllerBase|Phalcon/.test(baseText);

            if (!isYii && !isPhalcon) return;

            const framework: PhpRouteFramework = isPhalcon ? 'phalcon' : 'yii';
            const className = node.childForFieldName('name')?.text ?? '';
            // Derive controller name: UserController → user
            const controllerName = className.replace(/Controller$/, '').toLowerCase();

            const body = node.childForFieldName('body');
            if (!body) return;

            for (const member of body.children) {
                if (member.type !== 'method_declaration') continue;
                const methodName = member.childForFieldName('name')?.text ?? '';

                // Yii: actionCreateUser → POST /user/create-user (kebab-case, not .toLowerCase())
                const yiiMatch = methodName.match(/^action([A-Z][a-zA-Z0-9]*)$/);
                if (isYii && yiiMatch) {
                    // CamelCase → kebab-case: CreateUser → create-user
                    const actionName = yiiMatch[1]
                        .replace(/([a-z])([A-Z])/g, '$1-$2')
                        .toLowerCase();
                    // GET heuristic: starts with index, view, list, show, get, find, search
                    const isGet = /^(index|view|list|show|get|find|search)$/.test(actionName)
                        || /^(index|view|list|show|get|find|search)-/.test(actionName);
                    const method: HttpMethod = isGet ? 'GET' : 'POST';
                    routes.push({
                        method,
                        path: normalizePhpPath(`/${controllerName}/${actionName}`),
                        framework,
                    });
                    continue;
                }

                // Phalcon: createUserAction → /controller/create-user (kebab-case)
                const phalconMatch = methodName.match(/^([a-z][a-zA-Z0-9]*)Action$/);
                if (isPhalcon && phalconMatch) {
                    // camelCase → kebab-case: createUser → create-user
                    const actionName = phalconMatch[1]
                        .replace(/([a-z])([A-Z])/g, '$1-$2')
                        .toLowerCase();
                    const isGet = /^(index|view|list|show|get|find|search)$/.test(actionName)
                        || /^(index|view|list|show|get|find|search)-/.test(actionName);
                    const method: HttpMethod = isGet ? 'GET' : 'POST';
                    routes.push({
                        method,
                        path: normalizePhpPath(`/${controllerName}/${actionName}`),
                        framework,
                    });
                }
            }

            return;
        }
        for (const child of node.children) walkClasses(child);
    };

    walkClasses(rootNode);
    return routes;
}

// ─── AST Utility Helpers ──────────────────────────────────────────────────────

/**
 * Get all argument nodes from a call/method arguments list.
 * Filters out comma and paren tokens.
 */
function getCallArguments(argsNode: Parser.SyntaxNode): Parser.SyntaxNode[] {
    return argsNode.children.filter(c =>
        c.type !== ',' && c.type !== '(' && c.type !== ')' &&
        c.type !== 'comment',
    );
}

/**
 * Extract a string literal value from an AST node.
 * Returns null if the node is not a static string literal.
 */
function extractStringLiteral(node: Parser.SyntaxNode | undefined): string | null {
    if (!node) return null;

    // Direct string node: 'value' or "value"
    if (node.type === 'string') {
        return node.text.replace(/^['"]|['"]$/g, '');
    }

    // Encapsed string (interpolated) — skip, dynamic
    if (node.type === 'encapsed_string') return null;

    // Named argument: path: '/value'
    if (node.type === 'named_argument') {
        const valueNode = node.children.find(c => c.type !== 'name' && c.type !== ':');
        return extractStringLiteral(valueNode);
    }

    // Argument node wrapping a string
    if (node.type === 'argument') {
        const inner = node.children.find(c => c.type !== ',');
        return extractStringLiteral(inner);
    }

    return null;
}

/**
 * Extract an array of string literals from an array expression node.
 * Used for methods=['GET', 'POST'] arguments.
 */
function extractStringArray(node: Parser.SyntaxNode | undefined): string[] {
    if (!node) return [];

    // array(...) or [...] node
    const target = node.type === 'argument' ? node.children[0] : node;
    if (!target) return [];

    const results: string[] = [];
    const walkArray = (n: Parser.SyntaxNode): void => {
        if (n.type === 'string') {
            const val = n.text.replace(/^['"]|['"]$/g, '').toUpperCase();
            if (val) results.push(val);
        }
        for (const child of n.children) walkArray(child);
    };
    walkArray(target);
    return results;
}

/**
 * Find the closure/arrow-function body inside a group() call.
 * Traverses down into the argument list looking for a compound_statement.
 */
function findClosureBody(callNode: Parser.SyntaxNode): Parser.SyntaxNode | null {
    const findBody = (n: Parser.SyntaxNode): Parser.SyntaxNode | null => {
        if (n.type === 'compound_statement') return n;
        for (const child of n.children) {
            const result = findBody(child);
            if (result) return result;
        }
        return null;
    };
    return findBody(callNode);
}

/**
 * Check if a class has a specific attribute by name (PHP 8 style).
 */
function hasAttribute(classNode: Parser.SyntaxNode, name: string): boolean {
    for (const child of classNode.children) {
        if (child.type !== 'attribute_list') continue;
        for (const group of child.children) {
            if (group.type !== 'attribute_group') continue;
            for (const attr of group.children) {
                if (attr.type !== 'attribute') continue;
                if (getAttributeName(attr) === name) return true;
            }
        }
    }
    return false;
}

/**
 * Get the name of an attribute node (handles qualified names like ORM\Table).
 */
function getAttributeName(attrNode: Parser.SyntaxNode): string {
    const nameNode = attrNode.children.find(c =>
        c.type === 'name' || c.type === 'qualified_name',
    );
    if (!nameNode) return '';
    // Take last segment: ORM\Table → Table, Acl\Annotation\Route → Route
    const parts = nameNode.text.split('\\');
    return parts[parts.length - 1];
}

/**
 * Get the first string argument of an attribute call.
 * Attribute arguments are in an 'arguments' child node of the attribute.
 */
function getAttributeFirstStringArg(attrNode: Parser.SyntaxNode): string | null {
    const argsNode = attrNode.children.find(c => c.type === 'arguments');
    if (!argsNode) return null;
    const args = getCallArguments(argsNode);
    // If it's a named argument, we need to extract the value part
    const firstArg = args[0];
    if (firstArg?.type === 'argument') {
        const nameChild = firstArg.children.find(c => c.type === 'name');
        if (nameChild) {
            const valueChild = firstArg.children.find(c => c.type !== 'name' && c.type !== ':');
            return extractStringLiteral(valueChild);
        }
    }
    return extractStringLiteral(firstArg) ?? null;
}

/**
 * Get a named argument value from a PHP 8 attribute.
 * E.g., #[RequestMapping(path: '/users', methods: ['GET'])] → getNamedArg('path') = '/users'
 */
function getAttributeNamedArg(attrNode: Parser.SyntaxNode, argName: string): string | null {
    const argsNode = attrNode.children.find(c => c.type === 'arguments');
    if (!argsNode) return null;
    for (const child of argsNode.children) {
        if (child.type !== 'argument') continue;
        const nameChild = child.children.find(c => c.type === 'name');
        if (!nameChild || nameChild.text !== argName) continue;
        const valueChild = child.children.find(c => c.type !== 'name' && c.type !== ':');
        return extractStringLiteral(valueChild);
    }
    return null;
}

/**
 * Extract methods from a Symfony #[Route] or Hyperf #[RequestMapping] attribute.
 * Looks for `methods: ['GET', 'POST']` named argument.
 *
 * tree-sitter PHP 8 named arguments have type 'argument', NOT 'named_argument'.
 * Structure: argument { name('methods'), ':'-token, array_creation_expression }
 */
function getSymfonyAttributeMethods(attrNode: Parser.SyntaxNode): string[] {
    const argsNode = attrNode.children.find(c => c.type === 'arguments');
    if (!argsNode) return [];

    for (const child of argsNode.children) {
        if (child.type !== 'argument') continue;
        // Check if this is the named `methods:` argument
        const nameChild = child.children.find(c => c.type === 'name');
        if (!nameChild || nameChild.text !== 'methods') continue;
        // Value is the remaining child after name and ':'
        const valueChild = child.children.find(c => c.type !== 'name' && c.type !== ':');
        if (valueChild) return extractStringArray(valueChild);
    }
    return [];
}

/**
 * Extract HTTP methods from a WordPress register_rest_route() $args array.
 * Looks for 'methods' key in the array literal.
 */
function extractWordPressRestMethods(argsNode: Parser.SyntaxNode | undefined): string[] {
    if (!argsNode) return [];
    // Look for 'methods' => 'GET' or 'methods' => ['GET', 'POST']
    const methodsPattern = /['"]methods['"]\s*=>\s*(?:['"]([^'"]+)['"]|\[([^\]]*)\])/;
    const match = argsNode.text.match(methodsPattern);
    if (!match) return [];
    if (match[1]) return [match[1].toUpperCase()]; // single string
    if (match[2]) {
        return match[2]
            .split(',')
            .map(m => m.replace(/['"\s]/g, '').toUpperCase())
            .filter(Boolean);
    }
    return [];
}

/**
 * Convert an entity class name to a REST resource path.
 * OrderItem → /order-items, User → /users
 */
function classNameToResourcePath(className: string): string {
    // Strip common suffixes
    const stripped = className.replace(/Entity$|Model$|Resource$/, '');
    // CamelCase → kebab-case
    const kebab = stripped
        .replace(/([a-z])([A-Z])/g, '$1-$2')
        .toLowerCase();
    // Naive pluralize (covers 90% of English nouns)
    const plural = naivePluralize(kebab);
    return `/${plural}`;
}

function naivePluralize(s: string): string {
    if (s.endsWith('y') && !s.match(/[aeiou]y$/)) return s.slice(0, -1) + 'ies';
    if (s.endsWith('s') || s.endsWith('x') || s.endsWith('sh') || s.endsWith('ch')) return s + 'es';
    return s + 's';
}

/**
 * Resolve a raw method string to a PhpRoute[], handling normalization and
 * multi-method strings like 'GET,POST'.
 */
function resolveMethod(
    raw: string,
    path: string,
    framework: PhpRouteFramework,
): PhpRoute[] {
    const upper = raw.trim().toUpperCase();

    // Handle comma-separated: 'GET,POST'
    if (upper.includes(',')) {
        return upper.split(',').flatMap(m => resolveMethod(m.trim(), path, framework));
    }

    const VALID: Set<HttpMethod> = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']);
    if (!VALID.has(upper as HttpMethod)) return [];

    return [{ method: upper as HttpMethod, path, framework }];
}

// ─── Strategy 6: Legacy Filesystem Routing ────────────────────────────────────

/**
 * Detect legacy PHP files where the web server maps the URL directly to the
 * PHP file on disk (no framework router). E.g. pages/inventory/items/add.php
 * → /pages/inventory/items/add.php.
 *
 * STRICT SIGNAL HEURISTIC — requires at least one of:
 *   Signal A (input):  reads HTTP input  — $_GET, $_POST, $_REQUEST, $_FILES, $_SERVER, php://input
 *   Signal B (output): writes HTTP output — echo, print, header(, readfile(
 *
 * Rationale: config.php / db.php / functions.php ALL have top-level code but
 * none of them communicate over HTTP. The signal heuristic eliminates these
 * without needing a fragile filename blocklist.
 *
 * Files inside framework-managed directories (src/, app/, vendor/, etc.) are
 * excluded — they are included by a router, not served directly by the web server.
 *
 * The route path is the FULL given path, so the caller must pass a
 * repo-relative path: two scripts sharing a basename in different directories
 * stay distinct endpoints. A basename-only path would collapse them.
 *
 * Methods: GET always (any page script answers a browser navigation); POST is
 * added when the script reads $_POST/$_FILES (form/upload target).
 *
 * @param source   Full source text of the PHP file.
 * @param filepath Repo-relative path — used both for exclusion and the route path.
 * @returns Routes for the entrypoint, or [] if the file is not a web entrypoint.
 */
export function extractLegacyFilesystemRoute(
    source: string,
    filepath: string,
): PhpRoute[] {
    // Exclude files inside modern framework-managed directories. Relative
    // paths have no leading '/', so the segment must also match at string start.
    if (/(^|\/)(src|app|vendor|lib|includes|modules|Classes|Components)\//i.test(filepath)) {
        return [];
    }

    // Signals are CODE evidence: test them on string/comment-masked source so a
    // token inside a literal cannot count (e.g. a config array with
    // 'icon' => 'icon-print' must not match \bprint\b). Masking removes literal
    // CONTENT only — real statements and superglobal reads survive.
    const masked = stripPhpStringsAndComments(source);

    // CLI script guard: scripts that accept $argv are CLI entry points (migration runners,
    // scrapers, batch jobs). They are NOT web endpoints even if they also read $_REQUEST
    // — a common pattern for dual web/CLI compatibility where $_REQUEST is populated from
    // $argv for CLI invocation (e.g. $_REQUEST["ORDER_REF"] = $argv[1]).
    // Presence of $argv is the definitive signal: web PHP never has $argv populated.
    if (/\$argv\b/.test(masked)) return [];

    // Signal A — PHP file reads from the HTTP request.
    // php://input is exempt from masking: it only ever appears AS a string literal
    // (file_get_contents('php://input')), so it must be tested on the raw source.
    const hasHttpInput = /\$_(GET|POST|REQUEST|FILES|SERVER)\b/.test(masked)
        || /php:\/\/input/.test(source);

    // Signal B — PHP file writes to the HTTP response
    const hasHttpOutput = /\becho\b|\bprint\b|\bheader\s*\(|\breadfile\s*\(/.test(masked);

    if (!hasHttpInput && !hasHttpOutput) return [];

    const routePath = normalizePhpPath('/' + filepath.replace(/^\.\//, ''));
    const routes: PhpRoute[] = [{ method: 'GET', path: routePath, framework: 'legacy-php' }];
    if (/\$_(POST|FILES)\b/.test(masked)) {
        routes.push({ method: 'POST', path: routePath, framework: 'legacy-php' });
    }
    return routes;
}
