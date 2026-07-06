/**
 * PHP ORM entity-mapping recognition for synthetic `::__class_metadata`
 * chunks (Doctrine ORM/ODM annotations + attributes, Eloquent base classes
 * and mapping properties). Consumed by the heuristic pre-filter via the
 * `LanguagePlugin.recognizesOrmMetadataChunk` hook so entity-mapping chunks
 * schedule past the I/O gates — the framework grammar lives here, never in
 * the agnostic filter.
 *
 * This is a SCHEDULING gate (deliberately broad); the richer extraction
 * patterns live in `orm-static.ts`.
 */

import { stripPhpStringsAndComments } from './platform-io.js';

export function phpRecognizesOrmMetadataChunk(rawSource: string): boolean {
    // Annotations live in docblocks, so they are matched on the RAW source;
    // code-shape checks run on the comment/string-masked text so a comment
    // or string literal cannot spoof them.
    const codeOnly = stripPhpStringsAndComments(rawSource);

    // Doctrine annotation: @ORM\Table, @ORM\Entity, @ORM\Column
    if (/@ORM\\(?:Table|Entity|Column)\b/i.test(rawSource)) return true;
    // Doctrine ODM annotation: @MongoDB\Document, @MongoDB\EmbeddedDocument
    if (/@MongoDB\\(?:Document|EmbeddedDocument)\b/i.test(rawSource)) return true;
    // PHP 8 attribute: #[ORM\Table], #[MongoDB\Document], or any prefix-less
    // #[Document]/#[EmbeddedDocument] (Doctrine ODM common shorthand).
    if (/#\[(?:[\w\\]+\\)?(?:Table|Entity|Column|Document|EmbeddedDocument)\b/i.test(rawSource)) return true;
    // Eloquent: class extends Model | Authenticatable | Pivot
    if (/extends\s+(?:\\?[\w\\]+\\)?(?:Model|Authenticatable|Pivot)\b/.test(codeOnly)) return true;
    // Eloquent / Mongo class properties: $table = '...' or $collection = '...'
    if (/\$(?:table|collection)\s*=\s*['"`]/.test(codeOnly)) return true;

    return false;
}
