// server.js — PubScore Validation API
import express from 'express';
import cors from 'cors';
import { nip19 } from 'nostr-tools';
import { initDB, getReviewsForPubkey, getReviewsByAuthor, getScoreForPubkey, getScoresForPubkeys, getTotalReviewCount, getDistinctReviewedCount, getLeaderboard, getLeaderboardSince, getLeaderboardByTag, getLeaderboardByTagSince, getPendingCount, getRecentReviews } from './db.js';
import { startIngester, getIngesterStats } from './ingester.js';
import { startFollowerChecker, getFollowerCheckerStats } from './follower-checker.js';

const PORT = process.env.PORT || 3000;
const app = express();

// ---------------------------------------------------------------------------
// Middleware
// ---------------------------------------------------------------------------

app.use(cors({
  origin: '*',
  methods: ['GET'],
  maxAge: 86400
}));

app.use(express.json());

// Watermark — applied to every response
app.use((req, res, next) => {
  res.setHeader('X-Powered-By', 'PubScore API - pubscore.space');
  next();
});

// Simple rate limiter (per IP, in-memory)
const rateLimiter = new Map();
const RATE_LIMIT = 120;        // requests per window
const RATE_WINDOW_MS = 60000;  // 1 minute

function rateLimit(req, res, next) {
  const ip = req.ip || req.socket.remoteAddress;
  const now = Date.now();
  const entry = rateLimiter.get(ip);

  if (!entry || now - entry.start > RATE_WINDOW_MS) {
    rateLimiter.set(ip, { start: now, count: 1 });
    return next();
  }

  entry.count++;
  if (entry.count > RATE_LIMIT) {
    return res.status(429).json({ error: 'Rate limit exceeded. Try again shortly.' });
  }
  next();
}

app.use(rateLimit);

// Clean up stale rate limit entries every 5 minutes
setInterval(() => {
  const cutoff = Date.now() - RATE_WINDOW_MS * 2;
  for (const [ip, entry] of rateLimiter) {
    if (entry.start < cutoff) rateLimiter.delete(ip);
  }
}, 300000);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Decode an npub to hex pubkey. Returns null if invalid. */
function npubToHex(npub) {
  try {
    if (!npub || !npub.startsWith('npub1')) return null;
    const { type, data } = nip19.decode(npub);
    if (type !== 'npub') return null;
    return data;
  } catch {
    return null;
  }
}

/** Convert hex pubkey to npub */
function hexToNpub(hex) {
  try {
    return nip19.npubEncode(hex);
  } catch {
    return hex;
  }
}

// Valid tag keys
const VALID_TAGS = ['trade', 'knowledge', 'helpful', 'funny', 'creative', 'warning'];

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

/**
 * GET /reviews?npub={npub}&limit={n}&before={cursor}
 * Full reviews for a profile with cursor-based pagination
 *
 * Pagination:
 *   - Default 50 reviews per request, max 200
 *   - Pass `before` from the previous response's `nextCursor` to get the next page
 *   - `hasMore: true` means there are more reviews to fetch
 *   - `hasMore: false` means you've reached the end
 *
 * Example:
 *   GET /reviews?npub=npub1...              → first 50 reviews
 *   GET /reviews?npub=npub1...&before=1741200000  → next 50 reviews
 */
app.get('/reviews', (req, res) => {
  const { npub, limit: limitStr = '50', before: beforeStr } = req.query;
  const pubkey = npubToHex(npub);
  if (!pubkey) {
    return res.status(400).json({ error: 'Invalid or missing npub parameter' });
  }

  const limit = Math.min(Math.max(parseInt(limitStr, 10) || 50, 1), 200);
  const before = beforeStr ? parseInt(beforeStr, 10) : null;

  if (beforeStr && isNaN(before)) {
    return res.status(400).json({ error: 'Invalid before cursor — must be a Unix timestamp' });
  }

  const reviews = getReviewsForPubkey(pubkey, limit + 1, before);
  const hasMore = reviews.length > limit;
  const page = hasMore ? reviews.slice(0, limit) : reviews;
  const nextCursor = hasMore ? page[page.length - 1].created_at : null;

  const score = getScoreForPubkey(pubkey);

  res.json({
    npub,
    avgRating: score.avgRating || 0,
    count: score.count || 0,
    limit,
    hasMore,
    nextCursor,
    reviews: page.map(r => ({
      reviewer: hexToNpub(r.reviewer_pubkey),
      reviewerHex: r.reviewer_pubkey,
      rating: r.rating,
      content: r.content,
      categories: r.categories ? JSON.parse(r.categories) : [],
      created_at: r.created_at
    }))
  });
});

/**
 * GET /reviews/recent?npub={npub}&since={timestamp}&limit={n}
 * Recent validated reviews — for notifications and activity feeds
 *
 * Parameters:
 *   - npub    (optional) — filter to reviews targeting this profile
 *   - since   (optional) — only return reviews newer than this Unix timestamp
 *   - limit   (optional) — max results, default 20, max 100
 *
 * Without npub: returns the most recent reviews across all profiles (global feed)
 * With npub: returns recent reviews for that specific profile (notifications)
 *
 * Examples:
 *   GET /reviews/recent                          → latest 20 reviews globally
 *   GET /reviews/recent?npub=npub1...            → latest reviews for a profile
 *   GET /reviews/recent?npub=npub1...&since=1741200000  → new reviews since timestamp
 *   GET /reviews/recent?limit=5                  → latest 5 reviews globally
 */
app.get('/reviews/recent', (req, res) => {
  const { npub, since: sinceStr, limit: limitStr = '20' } = req.query;
  const limit = Math.min(Math.max(parseInt(limitStr, 10) || 20, 1), 100);
  const since = sinceStr ? parseInt(sinceStr, 10) : null;

  if (sinceStr && isNaN(since)) {
    return res.status(400).json({ error: 'Invalid since parameter — must be a Unix timestamp' });
  }

  let pubkey = null;
  if (npub) {
    pubkey = npubToHex(npub);
    if (!pubkey) {
      return res.status(400).json({ error: 'Invalid npub parameter' });
    }
  }

  const reviews = getRecentReviews(pubkey, since, limit);

  res.json({
    count: reviews.length,
    since: since || null,
    reviews: reviews.map(r => ({
      subject: hexToNpub(r.subject_pubkey),
      subjectHex: r.subject_pubkey,
      reviewer: hexToNpub(r.reviewer_pubkey),
      reviewerHex: r.reviewer_pubkey,
      rating: r.rating,
      content: r.content,
      categories: r.categories ? JSON.parse(r.categories) : [],
      created_at: r.created_at
    }))
  });
});

/**
 * GET /reviews/by?npub={npub}
 * Reviews written BY a given npub (as a reviewer)
 *
 * Example:
 *   GET /reviews/by?npub=npub1...  → all reviews this person has written
 */
app.get('/reviews/by', (req, res) => {
  const { npub } = req.query;
  const pubkey = npubToHex(npub);
  if (!pubkey) {
    return res.status(400).json({ error: 'Invalid or missing npub parameter' });
  }

  const reviews = getReviewsByAuthor(pubkey);

  res.json({
    npub,
    count: reviews.length,
    reviews: reviews.map(r => ({
      id: r.id,
      subject: hexToNpub(r.reviewed_pubkey),
      subjectHex: r.reviewed_pubkey,
      reviewer: hexToNpub(r.reviewer_pubkey),
      reviewerHex: r.reviewer_pubkey,
      rating: r.rating,
      content: r.content,
      categories: r.categories ? JSON.parse(r.categories) : [],
      created_at: r.created_at
    }))
  });
});

/**
 * GET /score?npub={npub}
 * Lightweight score only
 */
app.get('/score', (req, res) => {
  const { npub } = req.query;
  const pubkey = npubToHex(npub);
  if (!pubkey) {
    return res.status(400).json({ error: 'Invalid or missing npub parameter' });
  }

  const score = getScoreForPubkey(pubkey);
  res.json({
    npub,
    avgRating: score.avgRating || 0,
    count: score.count || 0
  });
});

/**
 * GET /scores?npubs={npub1,npub2,...}
 * Batch scores for Fren Finder
 */
app.get('/scores', (req, res) => {
  const { npubs } = req.query;
  if (!npubs) {
    return res.status(400).json({ error: 'Missing npubs parameter' });
  }

  const npubList = npubs.split(',').map(s => s.trim()).filter(Boolean);

  if (npubList.length > 200) {
    return res.status(400).json({ error: 'Max 200 npubs per request' });
  }

  const mapping = {};
  const hexKeys = [];
  const invalid = [];

  for (const npub of npubList) {
    const hex = npubToHex(npub);
    if (hex) {
      mapping[hex] = npub;
      hexKeys.push(hex);
    } else {
      invalid.push(npub);
    }
  }

  const hexScores = getScoresForPubkeys(hexKeys);

  const scores = {};
  for (const [hex, score] of Object.entries(hexScores)) {
    const npub = mapping[hex] || hexToNpub(hex);
    scores[npub] = score;
  }

  for (const npub of invalid) {
    scores[npub] = { avgRating: 0, count: 0 };
  }

  res.json({ scores });
});

/**
 * GET /leaderboard?window={all|week|month}&limit={n}
 * Top rated profiles for PubScore featured section
 */
app.get('/leaderboard', (req, res) => {
  const { window: win = 'all', limit: limitStr = '50' } = req.query;
  const limit = Math.min(Math.max(parseInt(limitStr, 10) || 50, 1), 1000);

  let results;
  if (win === '24h' || win === 'day') {
    const since = Math.floor(Date.now() / 1000) - 86400;
    results = getLeaderboardSince(since, 1, limit);
  } else if (win === 'week') {
    const since = Math.floor(Date.now() / 1000) - 7 * 86400;
    results = getLeaderboardSince(since, 1, limit);
  } else if (win === 'month') {
    const since = Math.floor(Date.now() / 1000) - 30 * 86400;
    results = getLeaderboardSince(since, 1, limit);
  } else {
    results = getLeaderboard(1, limit);
  }

  res.json({
    window: win,
    profiles: results.map(r => ({
      npub: hexToNpub(r.pubkey),
      pubkey: r.pubkey,
      avgRating: r.avgRating,
      count: r.count
    }))
  });
});

/**
 * GET /leaderboard/tag?tag={tag}&window={all|week|month}
 * All profiles tagged with a specific category
 */
app.get('/leaderboard/tag', (req, res) => {
  const { tag, window: win = 'all' } = req.query;

  if (!tag || !VALID_TAGS.includes(tag)) {
    return res.status(400).json({ error: `Invalid tag. Must be one of: ${VALID_TAGS.join(', ')}` });
  }

  let results;
  if (win === '24h' || win === 'day') {
    const since = Math.floor(Date.now() / 1000) - 86400;
    results = getLeaderboardByTagSince(tag, since, 1, 1000);
  } else if (win === 'week') {
    const since = Math.floor(Date.now() / 1000) - 7 * 86400;
    results = getLeaderboardByTagSince(tag, since, 1, 1000);
  } else if (win === 'month') {
    const since = Math.floor(Date.now() / 1000) - 30 * 86400;
    results = getLeaderboardByTagSince(tag, since, 1, 1000);
  } else {
    results = getLeaderboardByTag(tag, 1, 1000);
  }

  res.json({
    tag,
    window: win,
    profiles: results.map(r => ({
      npub: hexToNpub(r.pubkey),
      pubkey: r.pubkey,
      count: r.count
    }))
  });
});

/**
 * GET /health
 * Health check + basic stats
 */
app.get('/health', (req, res) => {
  const ingester = getIngesterStats();
  const followerChecker = getFollowerCheckerStats();
  res.json({
    status: 'ok',
    uptime: Math.floor(process.uptime()),
    reviews: getTotalReviewCount(),
    profiles: getDistinctReviewedCount(),
    pending: getPendingCount(),
    ingester,
    followerChecker
  });
});

/**
 * GET /stats
 * Public stats for dashboards
 */
app.get('/stats', (req, res) => {
  res.json({
    totalReviews: getTotalReviewCount(),
    totalProfiles: getDistinctReviewedCount()
  });
});

// 404 catch-all
app.use((req, res) => {
  res.status(404).json({ error: 'Not found' });
});

// Error handler
app.use((err, req, res, next) => {
  console.error('[Server] Error:', err);
  res.status(500).json({ error: 'Internal server error' });
});

// ---------------------------------------------------------------------------
// Startup
// ---------------------------------------------------------------------------

async function main() {
  console.log('[Server] Initializing database...');
  initDB();

  console.log('[Server] Starting ingester...');
  await startIngester();

  console.log('[Server] Starting follower checker...');
  await startFollowerChecker();

  app.listen(PORT, () => {
    console.log(`[Server] PubScore API running on port ${PORT}`);
    console.log(`[Server] Endpoints:`);
    console.log(`  GET /reviews?npub=...`);
    console.log(`  GET /reviews?npub=...&limit=50&before={cursor}`);
    console.log(`  GET /reviews/recent`);
    console.log(`  GET /reviews/recent?npub=...&since={timestamp}`);
    console.log(`  GET /reviews/by?npub=...`);
    console.log(`  GET /score?npub=...`);
    console.log(`  GET /scores?npubs=...,...`);
    console.log(`  GET /leaderboard?window=all|week|month`);
    console.log(`  GET /leaderboard/tag?tag=funny&window=all`);
    console.log(`  GET /health`);
    console.log(`  GET /stats`);
  });
}

main().catch(err => {
  console.error('[Server] Fatal error:', err);
  process.exit(1);
});