# PubScore API
Validated Nostr review API powering **PubScore** and Fren Finder.

## What It Does
- **Ingester** — Listens to 6 Nostr relays for `kind:38100` review events continuously, with an authors backfill pass every 6 hours to catch events missed by relay `#p` tag indexing
- **Validator** — Filters out self-reviews, bad signatures, invalid ratings, and reviewers with fewer than 30 followers
- **SQLite DB** — Stores only clean, deduplicated reviews (one per reviewer per profile, keeps newest)
- **REST API** — Serves clean review data publicly at `https://api.pubscore.space`

---


## Review Event Format (Nostr)

PubScore reviews are published as `kind:38100` events.

Example:

```json
{
  "kind": 38100,
  "pubkey": "<reviewer's hex pubkey>",
  "created_at": 1709312400,
  "tags": [
    ["p", "<subject's hex pubkey>"],
    ["d", "<subject's hex pubkey>"],
    ["rating", "4"],
    ["t", "helpful"],
    ["t", "knowledge"]
  ],
  "content": "Great contributor to the community, always sharing useful resources.",
  "id": "...",
  "sig": "..."
}
```

---

## API Endpoints

| Endpoint | Description |
|----------|-------------|
| `GET /reviews?npub={npub}` | Full reviews for a profile — rating, text, categories, reviewer, timestamp. Supports cursor-based pagination. |
| `GET /reviews/by?npub={npub}` | All reviews written by a given npub — subjects, ratings, text, categories. |
| `GET /reviews/recent?npub={npub}&since={timestamp}&limit={n}` | Recent validated reviews for notifications and activity feeds. If `npub` is omitted, returns the latest reviews globally. |
| `DELETE /reviews/{id}?npub={npub}` | Delete a review from the API database. Only the original reviewer can delete their own. |
| `GET /score?npub={npub}` | Lightweight score only — avg rating + count |
| `GET /scores?npubs={npub1,npub2,...}` | Batch scores for up to 200 npubs |
| `GET /leaderboard?window={all\|week\|month}&limit={n}` | Top rated profiles (max 1000) |
| `GET /leaderboard/tag?tag={tag}&window={all\|week\|month}` | All profiles tagged with a specific category |
| `GET /health` | API status, uptime, ingester stats |
| `GET /stats` | Public review and profile counts |

---

## Pagination — `/reviews`

The `/reviews` endpoint uses cursor-based pagination to handle profiles with large numbers of reviews efficiently.

### Parameters

| Parameter | Default | Description |
|-----------|---------|-------------|
| `npub` | required | The npub to look up |
| `limit` | `50` | Number of reviews per page (max 200) |
| `before` | none | Unix timestamp cursor — returns reviews older than this value |

### Response Fields

```json
{
  "npub": "npub1...",
  "avgRating": 4.8,
  "count": 142,
  "limit": 50,
  "hasMore": true,
  "nextCursor": 1741200000,
  "reviews": [...]
}
```

| Field | Description |
|-------|-------------|
| `count` | Total number of reviews for this profile |
| `hasMore` | `true` if more reviews exist beyond this page |
| `nextCursor` | Pass this as `before` in the next request to get the next page. `null` when on the last page. |

### Example — Infinite Scroll

```js
// First page
const res = await fetch('https://api.pubscore.space/reviews?npub=npub1...');
const data = await res.json();
// data.hasMore === true
// data.nextCursor === 1741200000

// Next page
const res2 = await fetch(`https://api.pubscore.space/reviews?npub=npub1...&before=${data.nextCursor}`);
const data2 = await res2.json();
// Keep fetching until data.hasMore === false
```

---

## Reviews By Author — `/reviews/by`

Returns all reviews written by a given npub, ordered newest first.

### Parameters

| Parameter | Default | Description |
|-----------|---------|-------------|
| `npub` | required | The reviewer's npub |

### Example

```js
const res = await fetch('https://api.pubscore.space/reviews/by?npub=npub1...');
const data = await res.json();

// data.count === 24
// data.reviews[0].subject === "npub1..."  (who they reviewed)
// data.reviews[0].rating === 5
```

### Response

```json
{
  "npub": "npub1...",
  "count": 24,
  "reviews": [
    {
      "id": "63893e47...",
      "subject": "npub1...",
      "subjectHex": "...",
      "reviewer": "npub1...",
      "reviewerHex": "...",
      "rating": 5,
      "content": "Solid trader, fast and reliable.",
      "categories": ["trade", "helpful"],
      "created_at": 1741201234
    }
  ]
}
```

---

## Delete a Review — `DELETE /reviews/{id}`

Removes a review from the API database. Only the original reviewer can delete their own review. This should be called alongside publishing a kind 5 deletion event to Nostr relays.

### Parameters

| Parameter | Description |
|-----------|-------------|
| `id` (path) | The 64-character hex event ID of the review |
| `npub` (query) | The reviewer's npub (used to verify ownership) |

### Example

```js
await fetch('https://api.pubscore.space/reviews/63893e47...?npub=npub1...', {
  method: 'DELETE'
});
// { "deleted": true }
```

### Responses

| Status | Body | Meaning |
|--------|------|---------|
| 200 | `{ "deleted": true }` | Review removed |
| 200 | `{ "deleted": false, "reason": "Review not found" }` | No review with that ID |
| 400 | `{ "error": "Invalid event ID" }` | ID is not 64-char hex |
| 403 | `{ "error": "You can only delete your own reviews" }` | npub doesn't match the reviewer |

---

### Notifications / Activity Feed — `/reviews/recent`

The `/reviews/recent` endpoint provides recent validated reviews and can be used for notification-style polling or activity feeds.

#### Parameters

| Parameter | Default | Description |
|-----------|---------|-------------|
| `npub` | optional | Filter to reviews targeting this profile |
| `since` | none | Only return reviews newer than this Unix timestamp |
| `limit` | `20` | Number of reviews to return (max 100) |

#### Example Usage

```js
// Latest recent reviews globally
const res = await fetch('https://api.pubscore.space/reviews/recent');
const data = await res.json();

// Recent reviews for one profile
const res2 = await fetch('https://api.pubscore.space/reviews/recent?npub=npub1...');

// Only reviews newer than a timestamp
const res3 = await fetch('https://api.pubscore.space/reviews/recent?npub=npub1...&since=1741200000');

{
  "count": 2,
  "since": 1741200000,
  "reviews": [
    {
      "subject": "npub1...",
      "subjectHex": "...",
      "reviewer": "npub1...",
      "reviewerHex": "...",
      "rating": 5,
      "content": "Very helpful trader.",
      "categories": ["helpful", "trade"],
      "created_at": 1741201234
    }
  ]
}
```

---

## Tag Leaderboard — `/leaderboard/tag`

Returns all profiles tagged with a specific category, ordered by tag count.

### Valid Tags
`TRUSTWORTHY` `KNOWLEDGEABLE` `HELPFUL` `FUNNY` `CREATIVE` `WARNING`

### Example
```
GET /leaderboard/tag?tag=helpful&window=week
```

### Response
```json
{
  "tag": "helpful",
  "window": "week",
  "profiles": [
    { "npub": "npub1...", "pubkey": "...", "count": 12 }
  ]
}
```
---

## Why This Data Is Reliable

Anyone can publish a `kind:38100` event to Nostr. Without filtering, 
review scores are trivially manipulated — sockpuppet accounts, 
self-reviews, and review bombing are all trivial attacks on a naive system.

Every review served by this API has passed strict validation before 
being stored. This means scores are resistant to spam and manipulation, 
making them safe to display in your app without additional filtering.

The validation rules below are what make the data trustworthy.

---

## Validation Rules

Every review stored has passed these checks:

- ✓ Valid Nostr event signature
- ✓ Reviewer has ≥30 followers
- ✓ Rating between 1–5
- ✓ No self-reviews
- ✓ One review per reviewer per profile (newest kept)
- ✓ Max 20 reviews per reviewer per day

---

## Self-Hosting
Clone the repo, add an A record pointing your domain to your VPS, 
run `deploy.sh`, and verify with `curl localhost:3000/health`.

---

## Files

```
pubscore-api/
├── server.js           — Express API + routes
├── validator.js        — Validation rules
├── ingester.js         — Relay listener + authors backfill
├── follower-checker.js — Follower count lookup + pending queue
├── db.js               — SQLite queries
├── package.json
├── deploy.sh           — One-shot VPS setup
└── data/
    └── pubscore.db     (created at runtime, not tracked in git)
```
