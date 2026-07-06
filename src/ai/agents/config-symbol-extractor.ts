// ═══════════════════════════════════════════════════════════════════════════════
// ConfigSymbolExtractor — LLM Agent for DI Binding Extraction
//
// Reads a config/factory file and extracts DI service → physical
// infrastructure name mappings as structured JSON. Language-agnostic: works
// with PHP, YAML, TypeScript, Python, or any format the LLM can read.
//
// Cost: 1 LLM call per config file (~2-10 per repo total).
// ═══════════════════════════════════════════════════════════════════════════════

import { Agent } from '@mastra/core/agent';
import { z } from 'zod';
import { getModel } from '../models/provider.js';

const ExtractedSymbolSchema = z.object({
    diKey: z.string().describe(
        'The DI container service key, variable name, or constant name '
        + '(e.g., "notpurchasable.publisher", "BILLING_TOPIC", "order.consumer").'
    ),
    physicalName: z.string().describe(
        'The physical infrastructure name this key resolves to. '
        + 'For message brokers, extract the routing key / topic name (or the queue name when no routing key exists). DO NOT extract the exchange name. '
        + 'Example: if exchange="payments_exchange" and routing_key="payment.completed.v2", '
        + 'the physicalName MUST be "payment.completed.v2" (NOT "payments_exchange:payment.completed.v2"). '
        + 'If BOTH queue and routing_key are defined (e.g., for a consumer binding), use the ROUTING KEY: '
        + 'the routing key is the cross-service channel identity, the queue name is a service-local consumer detail. '
        + 'Never use the queue name when a routing_key is present. '
        + 'If the value is computed from environment variables or string concatenation, '
        + 'extract as a template string using {VAR_NAME} syntax (e.g., "acme.{ENV}.payments").'
    ),
    technology: z.string().optional().describe(
        'The technology if identifiable (e.g., "rabbitmq", "kafka", "pubsub", "sqs").'
    ),
    category: z.enum(['di_service', 'env_var', 'constant', 'config_value']).default('di_service').describe(
        'Classification: di_service for DI container keys, env_var for environment variables, '
        + 'constant for class/module constants, config_value for config file entries.'
    ),
});

const ConfigSymbolExtractionSchema = z.object({
    bindings: z.array(ExtractedSymbolSchema).describe(
        'List of DI/infrastructure bindings found in this file. '
        + 'Empty array if no infrastructure bindings are found.'
    ),
});

export type ConfigSymbolExtractionResult = z.infer<typeof ConfigSymbolExtractionSchema>;

let _configSymbolExtractorAgent: Agent | null = null;

export function getConfigSymbolExtractorAgent(): Agent {
    if (!_configSymbolExtractorAgent) {
        _configSymbolExtractorAgent = new Agent({
            id: 'config-symbol-extractor',
            name: 'Config Symbol Extractor',
            defaultOptions: {
                modelSettings: { temperature: 0, maxRetries: 0 },
            },
            instructions: `You are a static analysis expert specializing in Dependency Injection containers and infrastructure configuration.

I will provide you with the contents of a configuration or factory file from an enterprise codebase. Your task is to extract ALL mappings between DI service keys and their physical infrastructure names.

For each binding, extract:
- **diKey**: The service identifier used in the DI container (e.g., the string passed to $container->get(), @Inject(), or a YAML service key).
- **physicalName**: The ACTUAL physical name of the infrastructure resource (routing key, topic name, queue name, database name, API endpoint). For message brokers, if both a queue and a routing_key are defined, use the routing_key (it is the broker-level channel identity); use the queue name only when no routing_key is present. DO NOT extract the exchange name. If the physical name is computed dynamically (e.g., via getenv(), string concatenation, or config parameters), extract it as a template using {VAR_NAME} syntax.
- **technology**: The technology if you can identify it (rabbitmq, kafka, pubsub, sqs, redis, mysql, etc.).
- **category**: Classification of this binding.

RULES:
1. ONLY extract bindings that map to INFRASTRUCTURE resources (queues, topics, databases, caches, API endpoints). DO NOT extract pure domain service bindings.
2. If a value uses environment variables (getenv('X'), process.env.X, os.environ['X']), replace the dynamic part with {X} in the physicalName.
3. If a value uses string concatenation, compose the full string with {VAR} placeholders for dynamic parts.
4. If you cannot determine the physical name at all (pure runtime computation), skip that binding.
5. Return an empty bindings array if the file contains no infrastructure bindings.
6. MESSAGE BUS / COMMAND BUS PATTERNS (Symfony Messenger, MediatR, Axon, Masstransit, etc.):
   If you see a configuration array or method mapping a specific Message/Command/Event Class to a
   physical transport, routing key, or queue name (e.g., PHP AmqpConfig::getMessageMap(), 
   Symfony messenger.yaml routing, Spring @KafkaListener topic), extract it:
   - Use the SHORT class name of the message (e.g., "SaveReadyMessage", "OrderCreatedEvent") as the 'diKey'.
   - Use the physical queue/routing key (e.g., "pkg.courier.save.requested") as the 'physicalName'.
   - Set 'category' to 'di_service'.
   DO NOT use the FQCN (fully-qualified class name) as the diKey — use only the short name.`,
            model: getModel('ingest'),
        });
    }
    return _configSymbolExtractorAgent;
}

export { ConfigSymbolExtractionSchema };
