# PRD-001 — Create Order

## Summary
Allow authenticated customers to place a new order through the BE REST API.

## User Story
> As a customer, I want to submit a new order with a list of items so that my purchase is recorded and can be fulfilled.

## Endpoints

### POST /orders
**Request body**
```json
{
  "customerId": "string (UUID)",
  "items": [
    { "productId": "string (UUID)", "quantity": 1 }
  ],
  "shippingAddress": {
    "line1": "string",
    "city": "string",
    "country": "string (ISO 3166-1 alpha-2)"
  }
}
```

**Success response — 201 Created**
```json
{
  "orderId": "string (UUID)",
  "status": "pending",
  "createdAt": "ISO 8601 timestamp"
}
```

**Error responses**
- `400` — invalid payload (Zod validation failure)
- `401` — missing / invalid JWT
- `422` — one or more productIds not found

## Acceptance Criteria
1. Order is persisted to the `orders` table with status `pending`.
2. Each line item is persisted to `order_items` with the resolved unit price at time of order.
3. An `order.created` domain event is published to the internal event bus.
4. The endpoint is protected by the existing JWT middleware.
5. Unit tests cover happy path + 400/422 error cases.

## Out of Scope
- Payment processing (separate PRD).
- Inventory reservation (phase 2).
