import type { NotificationClient } from '../infrastructure/NotificationClient';

/**
 * Use-case that sends an email notification via the injected NotificationClient SDK.
 *
 * The NotificationClient is an opaque SDK wrapper:
 *   - No visible axios/fetch calls
 *   - No Zodios definition
 *   - HTTP is encapsulated inside the pre-compiled SDK
 *
 * Without proper pipeline support, this function will NOT produce an
 * APIEndpoint node in the graph — the LLM sees it as an "internal wrapper call".
 */
export class AppointmentNotificationUseCase {
    constructor(
        private readonly notificationClient: NotificationClient,
    ) {}

    async notifyConfirmation(appointmentId: string, email: string): Promise<void> {
        await this.notificationClient.sendEmail({
            to: email,
            templateId: 'appointment-confirmation',
            data: { appointmentId },
        });
    }

    async notifyReminder(phone: string, message: string): Promise<void> {
        await this.notificationClient.sendSms({ phone, message });
    }
}
