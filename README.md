# PubScore API

Validated Nostr review API powering [PubScore](https://pubscore.space) and Fren Finder.

## What It Does

- **Ingester** — Listens to 6 Nostr relays for `kind:38383` review events continuously, with an authors backfill pass every 6 hours to catch events missed by relay `#p` tag indexing
- **Validator** — Filters out self-reviews, bad signatures, invalid ratings, and reviewers with fewer than 30 followers
- **SQLite DB** — Stores only clean, deduplicated reviews (one per reviewer per profile, keeps newest)
- **REST API** — Serves clean review data publicly at `https://api.pubscore.space`

## API Endpoints

| Endpoint | Description |
|---|---|
| `GET /reviews?npub={npub}` | Full reviews for a profile — rating, text, categories, reviewer, timestamp |
| `GET /score?npub={npub}` | Lightweight score only — avg rating + count |
| `GET /scores?npubs={npub1,npub2,...}` | Batch scores for up to 200 npubs |
| `GET /leaderboard?window={all\|week\|month}&limit={n}` | Top rated profiles (max 1000) |
| `GET /health` | API status, uptime, ingester stats |
| `GET /stats` | Public review and profile counts |

## Validation Rules

Every review stored has passed these checks:

- ✓ Valid Nostr event signature
- ✓ Reviewer has ≥30 followers
- ✓ Rating between 1–5
- ✓ No self-reviews
- ✓ One review per reviewer per profile (newest kept)
- ✓ Max 20 reviews per reviewer per day

## Deployment

### 1. DNS
Add an A record pointing `api.yourdomain.com` to your VPS IP.

### 2. Copy files to VPS

```bash
scp -r ./* deploy@YOUR_VPS_IP:~/pubscore-api/
```

### 3. SSH in and deploy

```bash
ssh deploy@YOUR_VPS_IP
cd ~/pubscore-api
chmod +x deploy.sh
./deploy.sh
```

### 4. Verify

```bash
# On the VPS:
curl localhost:3000/health

# Once DNS propagates:
curl https://api.yourdomain.com/health
```

## Files

```
pubscore-api/
├── server.js          — Express API + routes
├── validator.js       — Validation rules
├── ingester.js        — Relay listener + authors backfill
├── follower-checker.js — Follower count lookup + pending queue
├── db.js              — SQLite queries
├── package.json
├── deploy.sh          — One-shot VPS setup
└── data/
    └── pubscore.db    (created at runtime, not tracked in git)
```

## PM2 Commands

```bash
pm2 logs pubscore-api      # view logs
pm2 restart pubscore-api   # restart
pm2 monit                  # monitor CPU/RAM
pm2 stop pubscore-api      # stop
```

## Deploy Updates

```bash
# On your local machine:
git add .
git commit -m "your change"
git push

# On the VPS:
cd ~/pubscore-api
git pull origin main
pm2 restart pubscore-api
```
