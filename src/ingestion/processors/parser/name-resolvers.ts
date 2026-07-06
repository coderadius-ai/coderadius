import Parser from 'tree-sitter';

type SyntaxNode = Parser.SyntaxNode;
type NameResolver = (node: SyntaxNode) => string | null;

// Resolver 1: Function assigned to a variable
// const fetchUser = async () => {}  →  fetchUser
const fromVariableDeclarator: NameResolver = (node) => {
    if (node.parent?.type !== 'variable_declarator') return null;
    return node.parent.childForFieldName('name')?.text ?? null;
};

// Resolver 1b: Class field arrow functions / property initializers
// private save = async () => {}  →  save
const fromClassFieldDefinition: NameResolver = (node) => {
    const parentType = node.parent?.type;
    if (!parentType || !['public_field_definition', 'field_definition', 'property_definition'].includes(parentType)) {
        return null;
    }
    return node.parent?.childForFieldName('name')?.text ?? null;
};

// Resolver 2: Argument of a call expression
// Derives a name from the call context: callee + preceding literal arguments
// router.post('/orders', handler)  →  POST_/orders
// app.listen(3000, handler)        →  listen_3000
// cron.schedule('0 * * * *', fn)  →  schedule_0_*_*_*
// arr.forEach(fn)                  →  forEach_callback
// emitter.on('payment.done', fn)  →  on_payment.done
const fromCallArgument: NameResolver = (node) => {
    if (node.parent?.type !== 'arguments') return null;
    const callExpr = node.parent.parent;
    if (callExpr?.type !== 'call_expression') return null;

    const callee = callExpr.childForFieldName('function');
    const methodName = callee?.childForFieldName('property')?.text ?? callee?.text ?? 'call';

    // Collect the string/number literal args that appear BEFORE this function arg
    const args = node.parent.children.filter(c => !['(', ')', ','].includes(c.type));
    const thisArgIdx = args.indexOf(node);
    const priorLiterals = args
        .slice(0, thisArgIdx)
        .filter(a => ['string', 'number', 'template_string'].includes(a.type))
        .map(a => a.text.replace(/['"`]/g, '').trim())
        .filter(Boolean)
        .join('_');

    if (priorLiterals) {
        // Upper case HTTP methods for better readability
        const httpMethods = ['get', 'post', 'put', 'delete', 'patch', 'options'];
        const prefix = httpMethods.includes(methodName.toLowerCase()) ? methodName.toUpperCase() : methodName;
        return `${prefix}_${priorLiterals}`;
    }

    return `${methodName}_callback`;
};

// Resolver 3: Property of an object literal
// const routes = { createUser: async () => {} }  →  createUser
const fromObjectProperty: NameResolver = (node) => {
    const pair = node.parent;
    if (pair?.type !== 'pair') return null;
    return pair.childForFieldName('key')?.text ?? null;
};

// Resolver 4: Export default
// export default function() {}  →  default_export
const fromExportDefault: NameResolver = (node) => {
    if (node.parent?.type === 'export_statement') return 'default_export';
    return null;
};

export const NAME_RESOLVERS: NameResolver[] = [
    fromVariableDeclarator,
    fromClassFieldDefinition,
    fromCallArgument,
    fromObjectProperty,
    fromExportDefault,
];

export function resolveAnonymousName(node: SyntaxNode): string {
    for (const resolver of NAME_RESOLVERS) {
        const result = resolver(node);
        if (result) return result;
    }
    return 'anonymous';
}

/**
 * Like resolveAnonymousName, but also returns whether the resolved name can
 * be guaranteed unique within its source file.
 *
 * `nameIsAmbiguous = true` means the caller should include a start-position
 * suffix in the function URN as a tiebreaker.
 *
 * Uniqueness guarantees by resolver:
 *   fromVariableDeclarator   → unique (re-declaration is a SyntaxError)
 *   fromClassFieldDefinition → unique (class field names must be unique)
 *   fromExportDefault        → unique (only one default export per file)
 *   fromObjectProperty       → NOT unique: two object literals in the same
 *                              file can share the same key name, and the
 *                              chunker does NOT qualify the name with the
 *                              parent object variable (unlike class methods)
 *   fromCallArgument         → NOT unique (same call can repeat: forEach, on, it)
 *   'anonymous' fallback     → NOT unique (multiple unresolvable closures)
 */
export function resolveAnonymousNameWithAmbiguity(node: SyntaxNode): {
    name: string;
    nameIsAmbiguous: boolean;
} {
    // Resolvers that guarantee uniqueness within their scope
    const UNAMBIGUOUS_RESOLVERS = new Set([
        fromVariableDeclarator,
        fromClassFieldDefinition,
        // fromObjectProperty is intentionally excluded:
        // two object literals in the same file can have properties with the same
        // key name (e.g. `const a = { process: () => {} }` and
        // `const b = { process: () => {} }`), and the chunker does NOT prepend
        // the object variable name as a scope prefix (unlike class methods, which
        // get ClassName.methodName qualification). Without the position suffix
        // these would collide to the same URN.
        fromExportDefault,
    ]);

    for (const resolver of NAME_RESOLVERS) {
        const result = resolver(node);
        if (result) {
            return {
                name: result,
                nameIsAmbiguous: !UNAMBIGUOUS_RESOLVERS.has(resolver),
            };
        }
    }

    return { name: 'anonymous', nameIsAmbiguous: true };
}
