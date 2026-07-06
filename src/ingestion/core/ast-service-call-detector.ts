import type Parser from 'tree-sitter';

// ─── AST-Based Service Call Detection ────────────────────────────────────────
//
// Language-agnostic utilities for detecting service/dependency calls within
// a tree-sitter AST subtree. Used by Gate 2.5 to verify that a tainted
// symbol match actually involves a service invocation, not just a type
// annotation or variable declaration.
//
// Each language plugin provides its own call node types and filter predicate
// via the LanguagePlugin.hasServiceCallsInRange() method. These utilities
// power the common traversal logic.

/**
 * Find the deepest AST node whose source range fully contains
 * the given [startLine, endLine] range (1-indexed).
 *
 * Returns null if no node spans the exact range (safety fallback).
 */
export function findNodeSpanning(
    root: Parser.SyntaxNode,
    startLine: number,
    endLine: number,
): Parser.SyntaxNode | null {
    let best: Parser.SyntaxNode | null = null;

    const walk = (node: Parser.SyntaxNode): void => {
        const nodeStart = node.startPosition.row + 1;
        const nodeEnd = node.endPosition.row + 1;
        if (nodeStart <= startLine && nodeEnd >= endLine) {
            best = node;
            for (const child of node.children) walk(child);
        }
    };

    walk(root);
    return best;
}

/**
 * Walk an AST subtree looking for call nodes of the specified types.
 * For each matching call node, invokes the predicate to determine if
 * it qualifies as a "service call" (e.g. member access on an injected dep).
 *
 * @param node           Root of the subtree to walk
 * @param callNodeTypes  Set of tree-sitter node types considered "calls"
 * @param isServiceCall  Predicate: does this call node target a service?
 * @returns true if at least one qualifying service call is found
 */
export function walkForServiceCalls(
    node: Parser.SyntaxNode,
    callNodeTypes: Set<string>,
    isServiceCall: (callNode: Parser.SyntaxNode) => boolean,
): boolean {
    if (callNodeTypes.has(node.type) && isServiceCall(node)) {
        return true;
    }
    for (const child of node.children) {
        if (walkForServiceCalls(child, callNodeTypes, isServiceCall)) return true;
    }
    return false;
}
