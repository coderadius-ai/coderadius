import type { ConfigValueProvider } from './types.js';
import { SymfonyMessengerYamlProvider } from './symfony-messenger-yaml.js';
import { SymfonyMessengerPhpProvider } from './symfony-messenger-php.js';

export type {
    ConfigValueProvider,
    ConfigValueProviderContext,
} from './types.js';

export const CONFIG_VALUE_PROVIDERS: readonly ConfigValueProvider[] = [
    new SymfonyMessengerYamlProvider(),
    new SymfonyMessengerPhpProvider(),
];
