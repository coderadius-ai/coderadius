<?php

namespace TravelApp\Handler;

use Doctrine\ORM\EntityManagerInterface;
use Symfony\Component\Messenger\Attribute\AsMessageHandler;
use Symfony\Component\Messenger\MessageBusInterface;
use TravelApp\Entity\Trip;
use TravelApp\Entity\Booking;
use TravelApp\Message\BookingConfirmedMessage;
use TravelApp\Message\SendCustomerNotificationMessage;

/**
 * Symfony Messenger handler for BookingConfirmedMessage.
 *
 * This handler demonstrates several patterns the LLM should detect:
 *   1. Doctrine EntityManager usage (persist, flush → DB write)
 *   2. MessageBus dispatch (async message → another handler)
 *   3. External HTTP webhook call (curl)
 *   4. Reading from the `users` table (shared DB anti-pattern, 4th service now!)
 *
 * All of these are I/O operations that should survive the heuristic filter.
 */
#[AsMessageHandler]
class BookingConfirmedHandler
{
    public function __construct(
        private readonly EntityManagerInterface $entityManager,
        private readonly MessageBusInterface $messageBus,
    ) {}

    public function __invoke(BookingConfirmedMessage $message): void
    {
        // 1. Doctrine: Update trip status via ORM
        $trip = $this->entityManager->getRepository(Trip::class)->find($message->getTripId());
        if (!$trip) {
            throw new \RuntimeException("Trip {$message->getTripId()} not found");
        }

        $trip->setStatus('BOOKED');
        $trip->setTotalPrice($message->getPricePaid());

        // 2. Doctrine: Create booking record via ORM
        $booking = new Booking();
        $booking->setTripId($message->getTripId());
        $booking->setProviderId($message->getProviderId());
        $booking->setExternalBookingId((string) $message->getBookingId());
        $booking->setPricePaid($message->getPricePaid());
        $booking->setStatus('CONFIRMED');

        $this->entityManager->persist($booking);
        $this->entityManager->flush();

        // 3. Symfony Messenger: Dispatch follow-up notification
        if ($message->getCustomerEmail()) {
            $this->messageBus->dispatch(new SendCustomerNotificationMessage(
                customerEmail: $message->getCustomerEmail(),
                templateName: 'booking_confirmed',
                templateVars: [
                    'tripId' => $message->getTripId(),
                    'bookingId' => $message->getBookingId(),
                    'price' => $message->getPricePaid(),
                    'currency' => $message->getCurrency(),
                ],
            ));
        }

        // 4. External webhook (legacy integration with partner system)
        $webhookUrl = getenv('PARTNER_WEBHOOK_URL') ?: 'https://partners.travelapp.com/api/hooks';
        $ch = curl_init("{$webhookUrl}/booking-confirmed");
        curl_setopt_array($ch, [
            CURLOPT_POST => true,
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_HTTPHEADER => ['Content-Type: application/json'],
            CURLOPT_POSTFIELDS => json_encode([
                'event' => 'booking.confirmed',
                'tripId' => $message->getTripId(),
                'bookingId' => $message->getBookingId(),
                'providerId' => $message->getProviderId(),
                'amount' => $message->getPricePaid(),
                'currency' => $message->getCurrency(),
            ]),
        ]);
        curl_exec($ch);
        curl_close($ch);
    }

    /**
     * Pure business logic — should be filtered out by the heuristic filter.
     */
    private function calculateCommission(float $price, int $providerId): float
    {
        $rates = [42 => 0.08, 99 => 0.12]; // SkyFly 8%, Oceanic 12%
        return $price * ($rates[$providerId] ?? 0.10);
    }
}
