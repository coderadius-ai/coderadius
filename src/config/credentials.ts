import fs from 'node:fs';
import { logger } from '../utils/logger.js';
import chalk from 'chalk';
import { paths } from './paths.js';

const CREDENTIALS_PATH = paths.config.credentials;

/**
 * Loads credentials from ~/.coderadius/config/credentials.json and injects them into process.env.
 * Only injects if the environment variable is not already set.
 */
export function loadCredentials(): void {
    if (!fs.existsSync(CREDENTIALS_PATH)) {
        return;
    }

    try {
        const fileContent = fs.readFileSync(CREDENTIALS_PATH, 'utf-8');
        const credentials = JSON.parse(fileContent);

        if (typeof credentials !== 'object' || credentials === null) {
            throw new Error('credentials.json must contain a JSON object');
        }

        let injectedCount = 0;
        for (const [key, value] of Object.entries(credentials)) {
            // Only inject if not already present in the real environment
            if (process.env[key] === undefined) {
                if (typeof value === 'string') {
                    process.env[key] = value;
                    injectedCount++;
                } else if (typeof value === 'number' || typeof value === 'boolean') {
                    process.env[key] = String(value);
                    injectedCount++;
                } else {
                    logger.warn(`Skipping credential "${key}" because its value is not a string, number, or boolean.`);
                }
            }
        }

        if (injectedCount > 0) {
            logger.debug(`[Credentials] Injected ${injectedCount} secrets from credentials.json`);
        }
    } catch (error) {
        console.error(chalk.red(`\nError parsing credentials file at ${CREDENTIALS_PATH}:`));
        console.error(chalk.yellow((error as Error).message));
        console.error(chalk.dim('Please ensure it contains valid JSON (e.g., no trailing commas).'));
        process.exit(1);
    }
}
