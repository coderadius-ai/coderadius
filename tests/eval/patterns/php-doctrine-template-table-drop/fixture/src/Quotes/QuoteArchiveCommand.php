<?php

namespace Acme\Orders\Quotes;

/**
 * Command that archives quote rows from a per-type table.
 *
 * The table name is built dynamically at runtime: `quote_books`,
 * `quote_music`, `quote_games`, etc. The class-level comment
 * documents the pattern as `quote_{kind}`.
 *
 * The schema extractor (structural or LLM) may pick up the template
 * substring `quote_{kind}` and emit it as a DataStructure name.
 * That is unbindable — no DataContainer literal matches the template
 * string. The pipeline MUST drop it before reaching mergeEmergentSchema.
 *
 * Same pattern for `res_quote_arch_{kind}` (result archive).
 */
class QuoteArchiveCommand
{
    /**
     * Archive quote rows from `quote_{kind}` into `res_quote_arch_{kind}`.
     *
     * Columns of `quote_{kind}`:
     *   - id (int)
     *   - customer_id (int)
     *   - amount (decimal)
     *   - created_at (datetime)
     *
     * Columns of `res_quote_arch_{kind}`:
     *   - id (int)
     *   - archived_at (datetime)
     */
    public function archive(string $kind): int
    {
        // Real code would build the SQL dynamically; we keep the fixture
        // minimal because the regression is about the EXTRACTOR's output,
        // not the runtime semantics.
        $src = "quote_{$kind}";
        $dst = "res_quote_arch_{$kind}";
        return 0;
    }
}
