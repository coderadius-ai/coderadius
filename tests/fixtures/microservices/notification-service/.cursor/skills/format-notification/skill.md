---
name: format-notification
description: Formats notification payloads for email, SMS, and push channels with locale awareness.
---

# Format Notification

When building a notification payload:

1. Resolve the user's locale from their profile preferences
2. Select the correct template variant for the channel (email/sms/push)
3. Interpolate dynamic fields (order ID, tracking URL, amount)
4. Truncate SMS to 160 chars, preserving the tracking URL
