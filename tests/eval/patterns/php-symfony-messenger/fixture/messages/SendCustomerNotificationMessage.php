<?php

namespace TravelApp\Message;

/**
 * Symfony Messenger message for sending customer notifications.
 * Dispatched by BookingConfirmedHandler as a follow-up async command.
 */
final class SendCustomerNotificationMessage
{
    public function __construct(
        private readonly string $customerEmail,
        private readonly string $templateName,
        private readonly array $templateVars = [],
        private readonly string $channel = 'email',
    ) {}

    public function getCustomerEmail(): string { return $this->customerEmail; }
    public function getTemplateName(): string { return $this->templateName; }
    public function getTemplateVars(): array { return $this->templateVars; }
    public function getChannel(): string { return $this->channel; }
}
