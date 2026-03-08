# PubScore API

Validated Nostr review API for PubScore and Fren Finder.

## What It Does

- **Ingester** — Listens to 5 Nostr relays for `kind:38383` review events continuously
- **Validator** — Filters out self-reviews, bad signatures, invalid ratings, rate-limits spammers
- **SQLite DB** — Stores only clean, deduplicated reviews (one per reviewer per profile, keeps newest)
- **REST API** — Serves clean data to PubScore frontend and Fren Finder

## Deployment Steps

### 1. DNS (Namecheap)
Add an **A record** for your domain:
- **Type:** A Record  
- **Host:** api  
- **Value:** 167.172.252.175  
- **TTL:** Automatic

### 2. Copy files to VPS
```bash
scp -r ./* deploy@167.172.252.175:~/pubscore-api/
```

### 3. SSH in and deploy
```bash
ssh deploy@167.172.252.175
cd ~/pubscore-api
chmod +x deploy.sh
./deploy.sh
```

### 4. Verify
```bash
# On the VPS:
curl localhost:3000/health

# Once DNS propagates (may take a few minutes):
curl https://api.pubscore.space/health
```

## API Endpoints

| Endpoint | Description |
|----------|-------------|
| `GET /reviews?npub={npub}` | Full reviews for a profile |
| `GET /score?npub={npub}` | Lightweight score only |
| `GET /scores?npubs={npub1,npub2,...}` | Batch scores (max 200) |
| `GET /health` | Health check + stats |
| `GET /stats` | Public review/profile counts |

## Files

```
pubscore-api/
├── server.js      — Express API + routes
├── validator.js   — Validation rules
├── db.js          — SQLite queries
├── ingester.js    — Relay listener
├── package.json
├── deploy.sh      — One-shot VPS setup
└── data/
    └── pubscore.db  (created at runtime)
```

## PM2 Commands
```bash
pm2 logs pubscore-api      # view logs
pm2 restart pubscore-api   # restart
pm2 monit                  # monitor
pm2 stop pubscore-api      # stop
```
