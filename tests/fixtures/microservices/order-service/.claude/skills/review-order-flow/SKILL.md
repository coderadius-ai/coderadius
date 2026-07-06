---
name: review-order-flow
description: Reviews changes to the order processing pipeline against business rules and idempotency constraints.
---

# Review Order Flow

When reviewing changes that touch order creation, status transitions, or payment callbacks:

1. Verify idempotency keys are propagated through the entire chain
2. Check that status transitions follow the state machine
3. Ensure webhook handlers validate signatures before processing
4. Flag any direct DB writes that bypass the domain event pipeline
