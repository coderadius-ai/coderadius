---
name: retry-payment
description: Retries failed 3DS payment with idempotent key and jitter backoff.
---

# Retry Payment

When a payment fails with a retryable error:

1. Generate an idempotency key from the order ID and attempt number
2. Apply exponential backoff with jitter (base 500ms, max 30s)
3. Log each retry attempt with the correlation ID
4. After 3 failed attempts, emit a payment.failed domain event
