# FishTokri — Timeslot Order-Count Logic & Hiding Rules

This document is for any client application (mobile app, third-party frontend, etc.) that places orders through the FishTokri API. Follow everything here exactly so timeslot counts stay correct and full slots are hidden from customers.

---

## 1. How Order Counts Work

### Source of Truth — the `orders` collection

Counts are **never hardcoded** inside the timeslot document. Every time `GET /timeslots` is called, the backend runs a live MongoDB aggregation over the `orders` collection and computes:

| Counter | Meaning |
|---|---|
| `todaysOrderCount` | Non-cancelled orders for **this timeslot** with `deliveryDate === today (IST)` |
| `nextDayOrderCount` | Non-cancelled orders for **this timeslot** with `deliveryDate === tomorrow (IST)` |

After computing, both values are written back into the timeslot document in MongoDB so they are visible in Compass too.

### What "today" and "tomorrow" mean — always IST (UTC+5:30)

All date logic uses **Indian Standard Time**. There is no DST in India so the offset is always fixed at `+05:30`.

```
todayISO    = current date in IST  →  "YYYY-MM-DD"  e.g. "2026-05-29"
tomorrowISO = todayISO + 1 day                       e.g. "2026-05-30"
```

Pseudocode for any client:
```
now      = UTC timestamp
istNow   = now + 5h 30m
todayISO = format(istNow, "YYYY-MM-DD")
tomorrowISO = format(istNow + 24h, "YYYY-MM-DD")
```

### Which orders count toward the limit

An order increments a slot's count **only when ALL of the following are true**:

1. `scheduleType === "slot"` — takeaway/instant orders do NOT count toward slot limits.
2. `timeslotId === <the slot's _id as a string>` — must match exactly (string comparison, not ObjectId).
3. `deliveryDate === todayISO` (counts toward `todaysOrderCount`) **or** `deliveryDate === tomorrowISO` (counts toward `nextDayOrderCount`).
4. `status !== "cancelled"` — cancelled orders are excluded from the count.

---

## 2. Timeslot Document Fields

```jsonc
{
  "_id": "6a1se8526ed6492bca76f9a3",   // string when returned by API
  "label": "02:00 AM – 03:00 AM",
  "startTime": "02:00 AM",              // format: "HH:MM AM/PM"
  "endTime":   "03:00 AM",
  "isActive": true,
  "isInstant": false,
  "orderLimit": 2,                      // 0 = no limit
  "sortOrder": 3,
  "extraCharge": 0,
  "todaysOrderCount": 1,               // live-computed by GET /timeslots
  "nextDayOrderCount": 2               // live-computed by GET /timeslots
}
```

---

## 3. When to Hide a Timeslot

Apply **all three rules** before showing a slot to the customer. A slot must be hidden if **any one** of these is true:

### Rule 1 — Slot is inactive
```
slot.isActive === false  →  HIDE
```

### Rule 2 — Order limit reached for the selected delivery date
```
limit = slot.orderLimit ?? 0

if (limit > 0) {
  if (selectedDate === todayISO && slot.todaysOrderCount >= limit)  →  HIDE
  if (selectedDate === tomorrowISO && slot.nextDayOrderCount >= limit)  →  HIDE
}
```
> A `limit` of `0` means unlimited — never hide on count alone.

### Rule 3 — Slot start time is in the past (today only)
This rule applies **only when the selected delivery date is today**.

```
parse slot.startTime as "HH:MM AM/PM"
convert to minutes-since-midnight: slotStartMins

currentMins = IST hours * 60 + IST minutes

if (selectedDate === todayISO && slotStartMins <= currentMins)  →  HIDE
```

Tomorrow's slots are never hidden for being "in the past" — they are all future slots by definition.

### Summary — visibility decision tree

```
isActive === false?          → HIDE
limit > 0 AND count >= limit? → HIDE
today AND already started?   → HIDE
otherwise                    → SHOW
```

---

## 4. API — Fetching Timeslots

```
GET /api/sub-hubs/:subHubId/menu/timeslots
Authorization: Bearer <jwt>
```

Response:
```jsonc
{
  "timeslots": [ /* array of timeslot objects with live todaysOrderCount / nextDayOrderCount */ ],
  "total": 16
}
```

**Poll this endpoint** while the order form is open (e.g. every 5 seconds) so that if another user fills a slot, it disappears from the customer's screen without a manual refresh.

---

## 5. Placing a Slot Order — Required Fields

When calling `POST /api/orders`, include these fields for a scheduled delivery:

```jsonc
{
  "customerName": "...",
  "items": [ ... ],
  "deliveryType": "delivery",           // or "takeaway"

  // Schedule fields — required for slot orders
  "scheduleType": "slot",              // MUST be "slot" to count toward limits
  "deliveryDate": "2026-05-29",        // YYYY-MM-DD in IST; today or tomorrow
  "timeslotId": "6a1se8526ed6492bca76f9a3",  // slot._id as string
  "timeslotLabel": "02:00 AM – 03:00 AM",
  "timeslotStart": "02:00 AM",
  "timeslotEnd": "03:00 AM",

  // Hub context
  "subHubId": "...",
  "subHubName": "Thane",               // the subHub's dbName — used for DB routing
  "superHubId": "...",
  "superHubName": "...",

  // ... other order fields (address, payments, etc.)
}
```

> **Critical:** `scheduleType` must be `"slot"` and `timeslotId` must be the slot's `_id` string. If either is missing, the order will NOT update the slot count.

For **takeaway** orders, use `scheduleType: "instant"` and omit `timeslotId` — these never count toward any slot limit.

---

## 6. What Happens to Counts After Each Action

| Action | Effect on MongoDB timeslot |
|---|---|
| `POST /api/orders` with `scheduleType: "slot"` | Count re-aggregated and written immediately (fire-and-forget, <1 s) |
| `PUT /api/orders/:id` (any status change including cancel) | Count re-aggregated and written immediately |
| `DELETE /api/orders/:id` | Count re-aggregated and written immediately |
| `GET /timeslots` (any fetch) | Count re-aggregated and written for all slots of that sub-hub |

This means whether a customer places an order, an admin cancels it, or an admin deletes it — the count in MongoDB is always updated within seconds and the next `GET /timeslots` call will return the correct value.

---

## 7. Delivery Date — Only Today or Tomorrow

The platform currently supports only two delivery dates:

- **Today** — `todayISO` in IST
- **Tomorrow** — `tomorrowISO` in IST

Do not allow customers to pick arbitrary future dates. The slot-count system only tracks `todaysOrderCount` and `nextDayOrderCount`; orders with any other `deliveryDate` will not be counted or limited.

---

## 8. Quick Implementation Checklist for the Mobile App

- [ ] Compute `todayISO` / `tomorrowISO` in IST (`UTC + 5:30`), not the device's local timezone.
- [ ] Call `GET /timeslots` when the order screen opens.
- [ ] Poll `GET /timeslots` every ~5 seconds while the screen is visible.
- [ ] Filter slots using all three rules (inactive, limit reached, past start time for today).
- [ ] Send `scheduleType: "slot"`, `timeslotId`, `timeslotLabel`, `timeslotStart`, `timeslotEnd`, and `deliveryDate` when placing a slot order.
- [ ] Send `subHubName` (the sub-hub's database name, not its display name) — the backend uses this for DB routing and count sync.
- [ ] Do not allow selecting a slot that is hidden — validate client-side and also expect the backend to enforce limits server-side in a future update.
