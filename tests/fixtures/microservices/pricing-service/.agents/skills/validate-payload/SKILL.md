---
name: validate-payload
description: Validates incoming request payloads against JSON Schema before processing.
---

# Validate Payload

1. Load the schema for the endpoint from the schema registry
2. Validate the request body against the schema
3. Return structured validation errors with field paths
4. Log validation failures with correlation ID
