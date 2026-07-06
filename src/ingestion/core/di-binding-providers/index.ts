import type { DiBindingProvider } from './types.js';
import { SymfonyServicesYamlProvider } from './symfony-services-yaml.js';
import { SymfonyServicesPhpProvider } from './symfony-services-php.js';
import { PhpDiContainerProvider } from './php-di-container.js';

export type { DiBindingProvider, DiBindingProviderContext, RawDiBinding } from './types.js';

export const DI_BINDING_PROVIDERS: readonly DiBindingProvider[] = [
    new SymfonyServicesYamlProvider(),
    new SymfonyServicesPhpProvider(),
    new PhpDiContainerProvider(),
];
