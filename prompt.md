# Coupon System — Implementation Prompt

This document explains exactly how the coupon system works in FishTokri and how to replicate the same logic in the customer-facing frontend app. Both apps share the same MongoDB Atlas cluster, so the data is already there.

---

## MongoDB — Where the Data Lives

### 1. Coupon definitions
**Database:** `<subHubName>` (each sub-hub has its own dedicated database, e.g. `Thane`)
**Collection:** `coupons`

Each document looks like:
```json
{
  "_id": "ObjectId(...)",
  "code": "ONETIME",
  "title": "Test",
  "description": "Test",
  "type": "flat",
  "discountValue": 50,
  "minOrderAmount": 100,
  "maxUsage": 1,
  "isFirstTimeOnly": true,
  "isActive": true,
  "applicableCategories": [],
  "applicableProducts": [],
  "expiresAt": null,
  "createdAt": "ISODate",
  "updatedAt": "ISODate"
}
```

**Important fields:**
- `maxUsage` — maximum number of times **a single customer** can use this coupon. `null` or missing means unlimited.
- `isActive` — if `false`, coupon must never be shown or accepted.
- `expiresAt` — if set and in the past, coupon must be treated as expired and rejected.
- `isFirstTimeOnly` — if `true`, the coupon is only for customers who have never placed an order before.

> **The coupon document does NOT store a usage counter.** It is a pure definition. All per-customer usage tracking lives exclusively in the customer document in the `customers` database (see below). This avoids race conditions when multiple customers use the same coupon simultaneously.

---

### 2. Customer coupon usage
**Database:** `customers`
**Collection:** `customers`

Each customer document has two coupon arrays that together represent the complete usage history:

#### `activeCoupons` — coupons tied to currently live (non-delivered) orders

```json
"activeCoupons": [
  {
    "couponId": "ObjectId as string",
    "couponCode": "ONETIME",
    "couponTitle": "Test",
    "subHubId": "ObjectId as string",
    "usedCount": 2,
    "orderIds": ["orderId1", "orderId2"],
    "appliedAt": "ISODate"
  }
]
```

**How this array works:**
- There is **one entry per unique coupon** (keyed by `couponId`), never one per order.
- `usedCount` = number of currently active (non-delivered, non-cancelled) orders that have this coupon applied.
- `orderIds` = the exact list of those active order IDs.
- When `usedCount` drops to 0, the entire entry is removed from the array.
- If the same customer applies the same coupon to a second order while the first is still active, `usedCount` becomes 2 and both order IDs appear in `orderIds`.

#### `usedCoupons` — permanent history of coupons from delivered orders

```json
"usedCoupons": [
  {
    "couponId": "ObjectId as string",
    "couponCode": "ONETIME",
    "couponTitle": "Test",
    "orderId": "ObjectId as string",
    "subHubId": "ObjectId as string",
    "usedAt": "ISODate"
  }
]
```

**How this array works:**
- One entry is pushed **per delivered order** — it is NOT aggregated like `activeCoupons`.
- If a customer had 3 orders all delivered with the same coupon, there will be 3 separate entries in this array.
- Entries are never deleted once written, **except** when an already-delivered order is reversed back to active status (un-delivered).

---

### 3. Orders
**Database:** `orders`
**Collection:** `orders`

Each order stores the coupon(s) that were applied at the time of creation:
```json
{
  "couponId": "ObjectId as string",
  "couponCode": "ONETIME",
  "couponTitle": "Test",
  "status": "pending"
}
```

Active statuses (order is live): `pending`, `confirmed`, `out_for_delivery`, `takeaway`
Terminal statuses: `delivered`, `cancelled`

---

## How to Compute Total Coupon Usage for a Customer

This is the single formula used everywhere — in the frontend to decide whether to show a coupon, and in the backend to enforce the limit before creating an order.

```
totalUsage = activeCoupons[couponId].usedCount
           + count(usedCoupons entries where couponId matches)
```

- `activeCoupons[couponId].usedCount` → how many active orders currently have this coupon (0 if no entry exists for this couponId).
- `count(usedCoupons where couponId matches)` → how many delivered orders permanently used this coupon.

If `totalUsage >= coupon.maxUsage` → the customer has exhausted this coupon.

---

## Logic to Implement in the Customer Frontend

### Step 1 — Fetching the customer document

When a customer logs in, fetch their document from `customers.customers`. You need the full `activeCoupons` and `usedCoupons` arrays.

---

### Step 2 — Filtering coupons before displaying them

Before showing any coupon to the customer, filter out:
1. Coupons where `isActive === false`
2. Coupons where `expiresAt` is set and is in the past
3. Coupons where the customer has already reached `maxUsage`

```js
function isCouponAvailable(coupon, customer) {
  // 1. Inactive
  if (coupon.isActive === false) return false;

  // 2. Expired
  if (coupon.expiresAt && new Date(coupon.expiresAt).getTime() < Date.now()) return false;

  // 3. Usage limit reached — check customer document, NOT the coupon document
  if (coupon.maxUsage != null && Number(coupon.maxUsage) > 0) {
    const couponId = String(coupon._id);

    // Active usage: find the entry in activeCoupons keyed by couponId
    const activeEntry = (customer.activeCoupons ?? []).find(
      (ac) => String(ac.couponId) === couponId
    );
    // usedCount is the number of currently active orders using this coupon.
    // Fall back to 1 if usedCount is missing (old data format compatibility).
    const activeCount = activeEntry
      ? (activeEntry.usedCount != null ? Number(activeEntry.usedCount) : 1)
      : 0;

    // Historical usage: count entries in usedCoupons (one per delivered order)
    const historicalCount = (customer.usedCoupons ?? []).filter(
      (uc) => String(uc.couponId) === couponId
    ).length;

    if (activeCount + historicalCount >= Number(coupon.maxUsage)) return false;
  }

  return true;
}
```

Only show coupons where `isCouponAvailable` returns `true`.

---

### Step 3 — When an order is created

**Before inserting the order (server-side enforcement):**

```
1. Extract couponId from the order payload
2. Fetch the coupon document from <subHubName>.coupons by _id
   → verify isActive === true and expiresAt is not in the past
3. Fetch the customer document from customers.customers by _id
   → read activeCoupons and usedCoupons arrays
4. Compute totalUsage:
     activeEntry = activeCoupons.find(ac => ac.couponId === couponId)
     activeCount = activeEntry?.usedCount ?? 0
     historicalCount = usedCoupons.filter(uc => uc.couponId === couponId).length
     totalUsage = activeCount + historicalCount
5. If coupon.maxUsage > 0 AND totalUsage >= coupon.maxUsage
   → reject with HTTP 400, error: "CouponUsageLimitReached"
```

**After the order is inserted successfully**, update `activeCoupons` in the customer document:

```js
// Try to increment an existing entry for this couponId
result = db.customers.updateOne(
  { _id: customerId, "activeCoupons.couponId": couponId },
  {
    $inc: { "activeCoupons.$.usedCount": 1 },
    $addToSet: { "activeCoupons.$.orderIds": orderId }
  }
)

// If no entry existed for this couponId yet, create one
if (result.matchedCount === 0) {
  db.customers.updateOne(
    { _id: customerId },
    {
      $push: {
        activeCoupons: {
          couponId: couponId,
          couponCode: couponCode,
          couponTitle: couponTitle,
          subHubId: subHubId,
          usedCount: 1,
          orderIds: [orderId],
          appliedAt: new Date()
        }
      }
    }
  )
}
```

---

### Step 4 — When an order is cancelled or rejected

Decrement `usedCount` and remove the `orderId`. If `usedCount` reaches 0, remove the entire entry so the coupon becomes available again:

```js
// Step 1 — decrement usedCount
db.customers.updateOne(
  { _id: customerId, "activeCoupons.couponId": couponId },
  { $inc: { "activeCoupons.$.usedCount": -1 } }
)

// Step 2 — remove orderId from orderIds array
db.customers.updateOne(
  { _id: customerId },
  { $pull: { "activeCoupons.$[elem].orderIds": orderId } },
  { arrayFilters: [{ "elem.couponId": couponId }] }
)

// Step 3 — clean up entry if usedCount dropped to 0 or below
db.customers.updateOne(
  { _id: customerId },
  { $pull: { activeCoupons: { couponId: couponId, usedCount: { $lte: 0 } } } }
)
```

---

### Step 5 — When an order is delivered

Move the coupon from `activeCoupons` to `usedCoupons` permanently:

```js
// Step 1 — run the same 3-step decrement from Step 4 above
// (removes or decrements the activeCoupons entry)

// Step 2 — push a permanent record to usedCoupons
db.customers.updateOne(
  { _id: customerId },
  {
    $push: {
      usedCoupons: {
        couponId: couponId,
        couponCode: couponCode,
        couponTitle: couponTitle,
        orderId: orderId,
        subHubId: subHubId,
        usedAt: new Date()
      }
    }
  }
)
```

---

## All Order Status Transitions

| Order event | `activeCoupons` action | `usedCoupons` action |
|---|---|---|
| Order **created** (any active status) | Upsert entry: `usedCount++`, push `orderId` | No change |
| Order **cancelled** | Decrement `usedCount`, remove `orderId`; delete entry if count ≤ 0 | No change |
| Order **delivered** | Decrement `usedCount`, remove `orderId`; delete entry if count ≤ 0 | Push permanent entry |
| Order **un-delivered** → back to active | Upsert entry: `usedCount++`, push `orderId` | Remove entry for this `orderId` |
| Order **un-cancelled** → back to active | Upsert entry: `usedCount++`, push `orderId` | No change |
| Order **cancelled → delivered** (rare) | No change | Push permanent entry directly |

---

## Key Rules

1. **`usedCount` lives in the customer document, not in the coupon document.** The coupon document is a read-only definition — never write usage data to it.
2. **One `activeCoupons` entry per coupon per customer.** Always upsert using `couponId` as the key, never push a new entry blindly.
3. **`usedCoupons` entries are per-order, not per-coupon.** A customer with 3 delivered orders using the same coupon will have 3 separate entries.
4. **`usedCoupons` is permanent** — never delete from it unless un-delivering an order.
5. **`maxUsage` is per-customer** — `totalUsage = activeCoupons.usedCount + usedCoupons.length` for that couponId. It is not a global usage counter across all customers.
6. **Always enforce server-side.** Do the `maxUsage` check in the API before inserting the order regardless of what the frontend shows.
7. **Filter on the frontend too.** Do not show coupons where `activeCount + historicalCount >= maxUsage` to the logged-in customer to prevent failed attempts.
