import { registerAs } from '@nestjs/config';

/**
 * Conduit config — channels for outbox dispatching.
 *
 * This file exercises the registerAs() factory pattern:
 *   export default registerAs('scope', () => ({ key: env || 'fallback' }))
 *
 * The static analyzer must:
 *   1. Parse the call_expression inside export default
 *   2. Use 'conduit' (first string arg) as the scope
 *   3. Extract cdtChannelSave / cdtChannelBundle as scoped constants
 *   4. Resolve env fallbacks via extractFallbackLiteral
 */
export default registerAs('conduit', () => ({
    cdtChannelSave: process.env.CDT_CHANNEL_SAVE || 'Platform-OrderSave',
    cdtChannelBundle: process.env.CDT_CHANNEL_BUNDLE || 'Platform-OrderBundle',
    transporter: 'mongo',
}));
