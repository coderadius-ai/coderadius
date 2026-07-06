/**
 * Anonymous SDK wrapper for an external notification delivery service.
 * Mirrors the real pattern: instantiation via factory + injected config.
 *
 * In production, this would be something like @acme/notification-client.
 * The SDK encapsulates HTTP calls — no axios/fetch visible in the codebase.
 */
export interface NotificationClientConfig {
    baseUrl: string;
    apiKey: string;
    timeout?: number;
}

export interface SendEmailPayload {
    to: string;
    templateId: string;
    data: Record<string, unknown>;
}

export interface SmsPayload {
    phone: string;
    message: string;
}

export class NotificationClient {
    constructor(private readonly config: NotificationClientConfig) {}

    async sendEmail(payload: SendEmailPayload): Promise<{ messageId: string }> {
        // SDK internals are opaque — HTTP is encapsulated
        throw new Error('SDK stub — not for execution');
    }

    async sendSms(payload: SmsPayload): Promise<{ messageId: string }> {
        throw new Error('SDK stub — not for execution');
    }
}

/**
 * Factory function — mirrors the real NestJS provider pattern.
 * Called in a Nest module with config injected from env.
 */
export function createNotificationClient(config: NotificationClientConfig): NotificationClient {
    return new NotificationClient(config);
}
