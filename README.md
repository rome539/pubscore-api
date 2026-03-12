# PubScore API
Validated Nostr review API powering **PubScore** and Fren Finder.

## What It Does
- **Ingester** — Listens to 6 Nostr relays for `kind:38383` review events continuously, with an authors backfill pass every 6 hours to catch events missed by relay `#p` tag indexing
- **Validator** — Filters out self-reviews, bad signatures, invalid ratings, and reviewers with fewer than 30 followers
- **SQLite DB** — Stores only clean, deduplicated reviews (one per reviewer per profile, keeps newest)
- **REST API** — Serves clean review data publicly at `https://api.pubscore.space`

---

## API Endpoints

| Endpoint | Description |
|----------|-------------|
| `GET /reviews?npub={npub}` | Full reviews for a profile — rating, text, categories, reviewer, timestamp. Supports cursor-based pagination. |
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

## Tag Leaderboard — `/leaderboard/tag`

Returns all profiles tagged with a specific category, ordered by tag count.

### Valid Tags
`trade` `knowledge` `helpful` `funny` `creative` `warning`

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
