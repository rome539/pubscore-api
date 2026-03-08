// db.js — SQLite database layer for PubScore API
import Database from 'better-sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = path.join(__dirname, 'data', 'pubscore.db');

let db;

export function initDB() {
  db = new Database(DB_PATH);

  // Performance pragmas
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('foreign_keys = ON');

  // Create tables
  db.exec(`
    CREATE TABLE IF NOT EXISTS reviews (
      id TEXT PRIMARY KEY,
      reviewer_pubkey TEXT NOT NULL,
      reviewed_pubkey TEXT NOT NULL,
      rating INTEGER NOT NULL CHECK(rating >= 1 AND rating <= 5),
      content TEXT,
      categories TEXT,
      created_at INTEGER NOT NULL,
      ingested_at INTEGER NOT NULL,
      event_json TEXT NOT NULL
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_reviews_pair
      ON reviews(reviewer_pubkey, reviewed_pubkey);

    CREATE INDEX IF NOT EXISTS idx_reviews_reviewed
      ON reviews(reviewed_pubkey);

    CREATE INDEX IF NOT EXISTS idx_reviews_reviewer
      ON reviews(reviewer_pubkey);

    CREATE TABLE IF NOT EXISTS reviewer_stats (
      pubkey TEXT PRIMARY KEY,
      follower_count INTEGER DEFAULT 0,
      oldest_event INTEGER DEFAULT 0,
      last_checked INTEGER DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS pending_reviews (
      id TEXT PRIMARY KEY,
      reviewer_pubkey TEXT NOT NULL,
      reviewed_pubkey TEXT NOT NULL,
      rating INTEGER NOT NULL,
      content TEXT,
      categories TEXT,
      created_at INTEGER NOT NULL,
      queued_at INTEGER NOT NULL,
      retries INTEGER DEFAULT 0,
      event_json TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_pending_reviewer
      ON pending_reviews(reviewer_pubkey);

    CREATE TABLE IF NOT EXISTS ingestion_state (
      key TEXT PRIMARY KEY,
      value TEXT
    );
  `);

  console.log('[DB] Initialized at', DB_PATH);
  return db;
}

export function getDB() {
  if (!db) throw new Error('Database not initialized — call initDB() first');
  return db;
}

// ---------------------------------------------------------------------------
// Review CRUD
// ---------------------------------------------------------------------------

/** Upsert a review — keeps newest by created_at per (reviewer, reviewed) pair */
export function upsertReview(review) {
  const stmt = getDB().prepare(`
    INSERT INTO reviews (id, reviewer_pubkey, reviewed_pubkey, rating, content, categories, created_at, ingested_at, event_json)
    VALUES (@id, @reviewer_pubkey, @reviewed_pubkey, @rating, @content, @categories, @created_at, @ingested_at, @event_json)
    ON CONFLICT(reviewer_pubkey, reviewed_pubkey) DO UPDATE SET
      id = CASE WHEN @created_at > reviews.created_at THEN @id ELSE reviews.id END,
      rating = CASE WHEN @created_at > reviews.created_at THEN @rating ELSE reviews.rating END,
      content = CASE WHEN @created_at > reviews.created_at THEN @content ELSE reviews.content END,
      categories = CASE WHEN @created_at > reviews.created_at THEN @categories ELSE reviews.categories END,
      created_at = CASE WHEN @created_at > reviews.created_at THEN @created_at ELSE reviews.created_at END,
      event_json = CASE WHEN @created_at > reviews.created_at THEN @event_json ELSE reviews.event_json END,
      ingested_at = @ingested_at
  `);
  return stmt.run(review);
}

/** Bulk upsert inside a transaction */
export function upsertReviewsBatch(reviews) {
  const tx = getDB().transaction((items) => {
    for (const r of items) {
      upsertReview(r);
    }
  });
  tx(reviews);
}

/** Get all reviews for a reviewed pubkey, ordered newest first */
export function getReviewsForPubkey(reviewedPubkey) {
  return getDB().prepare(`
    SELECT id, reviewer_pubkey, reviewed_pubkey, rating, content, categories, created_at
    FROM reviews
    WHERE reviewed_pubkey = ?
    ORDER BY created_at DESC
  `).all(reviewedPubkey);
}

/** Get score summary for a reviewed pubkey */
export function getScoreForPubkey(reviewedPubkey) {
  return getDB().prepare(`
    SELECT
      COUNT(*) as count,
      ROUND(AVG(CAST(rating AS REAL)), 2) as avgRating
    FROM reviews
    WHERE reviewed_pubkey = ?
  `).get(reviewedPubkey);
}

/** Get scores for multiple pubkeys at once */
export function getScoresForPubkeys(pubkeys) {
  if (!pubkeys.length) return {};
  // Use a temp approach since SQLite doesn't do array params well
  const placeholders = pubkeys.map(() => '?').join(',');
  const rows = getDB().prepare(`
    SELECT
      reviewed_pubkey,
      COUNT(*) as count,
      ROUND(AVG(CAST(rating AS REAL)), 2) as avgRating
    FROM reviews
    WHERE reviewed_pubkey IN (${placeholders})
    GROUP BY reviewed_pubkey
  `).all(...pubkeys);

  const result = {};
  for (const pk of pubkeys) {
    result[pk] = { avgRating: 0, count: 0 };
  }
  for (const row of rows) {
    result[row.reviewed_pubkey] = {
      avgRating: row.avgRating,
      count: row.count
    };
  }
  return result;
}

/** Count reviews by a reviewer in the last 24 hours */
export function countRecentReviewsByReviewer(reviewerPubkey) {
  const since = Math.floor(Date.now() / 1000) - 86400;
  return getDB().prepare(`
    SELECT COUNT(*) as count FROM reviews
    WHERE reviewer_pubkey = ? AND created_at > ?
  `).get(reviewerPubkey, since).count;
}

/** Delete a review by event ID (for kind 5 deletions) */
export function deleteReviewByEventId(eventId) {
  return getDB().prepare('DELETE FROM reviews WHERE id = ?').run(eventId);
}

/** Get total review count */
export function getTotalReviewCount() {
  return getDB().prepare('SELECT COUNT(*) as count FROM reviews').get().count;
}

/** Get distinct reviewed pubkey count */
export function getDistinctReviewedCount() {
  return getDB().prepare('SELECT COUNT(DISTINCT reviewed_pubkey) as count FROM reviews').get().count;
}

// ---------------------------------------------------------------------------
// Reviewer Stats
// ---------------------------------------------------------------------------

export function upsertReviewerStats(pubkey, followerCount, oldestEvent) {
  getDB().prepare(`
    INSERT INTO reviewer_stats (pubkey, follower_count, oldest_event, last_checked)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(pubkey) DO UPDATE SET
      follower_count = ?,
      oldest_event = CASE WHEN ? < reviewer_stats.oldest_event OR reviewer_stats.oldest_event = 0 THEN ? ELSE reviewer_stats.oldest_event END,
      last_checked = ?
  `).run(
    pubkey, followerCount, oldestEvent, Math.floor(Date.now() / 1000),
    followerCount, oldestEvent, oldestEvent, Math.floor(Date.now() / 1000)
  );
}

export function getReviewerStats(pubkey) {
  return getDB().prepare('SELECT * FROM reviewer_stats WHERE pubkey = ?').get(pubkey);
}

// ---------------------------------------------------------------------------
// Ingestion State (bookmarks for relay sync)
// ---------------------------------------------------------------------------

export function getIngestionState(key) {
  const row = getDB().prepare('SELECT value FROM ingestion_state WHERE key = ?').get(key);
  return row ? row.value : null;
}

export function setIngestionState(key, value) {
  getDB().prepare(`
    INSERT INTO ingestion_state (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = ?
  `).run(key, value, value);
}

// ---------------------------------------------------------------------------
// Pending Reviews Queue
// ---------------------------------------------------------------------------

/** Add a review to the pending queue */
export function addPendingReview(review) {
  getDB().prepare(`
    INSERT OR REPLACE INTO pending_reviews
      (id, reviewer_pubkey, reviewed_pubkey, rating, content, categories, created_at, queued_at, retries, event_json)
    VALUES (@id, @reviewer_pubkey, @reviewed_pubkey, @rating, @content, @categories, @created_at, @queued_at, 0, @event_json)
  `).run({ ...review, queued_at: Math.floor(Date.now() / 1000) });
}

/** Get all pending reviews, optionally filtered by reviewer */
export function getPendingReviews(limit = 100) {
  return getDB().prepare(`
    SELECT * FROM pending_reviews
    WHERE retries < 5
    ORDER BY queued_at ASC
    LIMIT ?
  `).all(limit);
}

/** Get distinct reviewer pubkeys from pending queue */
export function getPendingReviewerPubkeys() {
  return getDB().prepare(`
    SELECT DISTINCT reviewer_pubkey FROM pending_reviews WHERE retries < 5
  `).all().map(r => r.reviewer_pubkey);
}

/** Promote a pending review to the main reviews table */
export function promotePendingReview(id) {
  const pending = getDB().prepare('SELECT * FROM pending_reviews WHERE id = ?').get(id);
  if (!pending) return;

  upsertReview({
    id: pending.id,
    reviewer_pubkey: pending.reviewer_pubkey,
    reviewed_pubkey: pending.reviewed_pubkey,
    rating: pending.rating,
    content: pending.content,
    categories: pending.categories,
    created_at: pending.created_at,
    ingested_at: Math.floor(Date.now() / 1000),
    event_json: pending.event_json
  });

  getDB().prepare('DELETE FROM pending_reviews WHERE id = ?').run(id);
}

/** Increment retry count for a pending review */
export function incrementPendingRetry(id) {
  getDB().prepare('UPDATE pending_reviews SET retries = retries + 1 WHERE id = ?').run(id);
}

/** Delete a pending review (max retries exceeded) */
export function deletePendingReview(id) {
  getDB().prepare('DELETE FROM pending_reviews WHERE id = ?').run(id);
}

/** Get count of pending reviews */
export function getPendingCount() {
  return getDB().prepare('SELECT COUNT(*) as count FROM pending_reviews').get().count;
}

// ---------------------------------------------------------------------------
// Leaderboard
// ---------------------------------------------------------------------------

/** Get top rated profiles with minimum review count */
export function getLeaderboard(minReviews = 1, limit = 50) {
  return getDB().prepare(`
    SELECT
      reviewed_pubkey as pubkey,
      COUNT(*) as count,
      ROUND(AVG(CAST(rating AS REAL)), 2) as avgRating
    FROM reviews
    GROUP BY reviewed_pubkey
    HAVING count >= ?
    ORDER BY avgRating DESC, count DESC
    LIMIT ?
  `).all(minReviews, limit);
}

/** Get leaderboard filtered by time window */
export function getLeaderboardSince(sinceTs, minReviews = 1, limit = 50) {
  return getDB().prepare(`
    SELECT
      reviewed_pubkey as pubkey,
      COUNT(*) as count,
      ROUND(AVG(CAST(rating AS REAL)), 2) as avgRating
    FROM reviews
    WHERE created_at >= ?
    GROUP BY reviewed_pubkey
    HAVING count >= ?
    ORDER BY avgRating DESC, count DESC
    LIMIT ?
  `).all(sinceTs, minReviews, limit);
}
