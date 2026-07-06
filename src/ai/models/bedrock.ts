import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createAmazonBedrock } from '@ai-sdk/amazon-bedrock';
import { logger } from '../../utils/logger.js';

function loadSharedCredentials(profile: string): { accessKeyId: string; secretAccessKey: string; sessionToken?: string } | undefined {
    const credPath = path.join(os.homedir(), '.aws', 'credentials');
    if (!fs.existsSync(credPath)) return undefined;

    const content = fs.readFileSync(credPath, 'utf-8');
    const sectionRegex = new RegExp(`\\[${profile}\\]([^\\[]*)`);
    const match = content.match(sectionRegex);
    if (!match) return undefined;

    const section = match[1];
    const get = (key: string) => section.match(new RegExp(`^\\s*${key}\\s*=\\s*(.+)$`, 'm'))?.[1]?.trim();

    const accessKeyId = get('aws_access_key_id');
    const secretAccessKey = get('aws_secret_access_key');
    if (!accessKeyId || !secretAccessKey) return undefined;

    return { accessKeyId, secretAccessKey, sessionToken: get('aws_session_token') };
}

export function getBedrockProvider(region?: string) {
    const awsRegion = region && region !== 'global' ? region : undefined;
    const resolvedRegion = awsRegion || process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION;
    if (!resolvedRegion) {
        throw new Error(
            'AWS Bedrock requires a region. ' +
            'Set AWS_REGION or configure it in ~/.coderadius/config/settings.json under ai.providers.bedrock.region'
        );
    }

    const profile = process.env.AWS_PROFILE || 'default';
    const sharedCreds = loadSharedCredentials(profile);

    logger.debug(`[Bedrock] region=${resolvedRegion}, profile=${profile}`);

    return createAmazonBedrock({
        region: resolvedRegion,
        ...(sharedCreds ? {
            accessKeyId: sharedCreds.accessKeyId,
            secretAccessKey: sharedCreds.secretAccessKey,
            sessionToken: sharedCreds.sessionToken,
        } : {}),
    });
}

export const getBedrockModel = (modelName: string, region?: string) => {
    return getBedrockProvider(region)(modelName);
};
