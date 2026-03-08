// follower-checker.js — Looks up follower counts and processes the pending review queue
import 'websocket-polyfill';
import { Relay } from 'nostr-tools/relay';
import {
  upsertReviewerStats, getReviewerStats,
  getPendingReviews, getPendingReviewerPubkeys,
  promotePendingReview, incrementPendingRetry, deletePendingReview,
  getPendingCount, getTotalReviewCount
} from './db.js';
import { MIN_REVIEWER_FOLLOWERS } from './validator.js';

const RELAYS = [
  'wss://relay.damus.io',
  'wss://relay.primal.net',
  'wss://nos.lol',
];

// How often to process the pending queue
const PROCESS_INTERVAL_MS = 30000; // 30 seconds
// How often to refresh stale stats
const REFRESH_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6 hours
// Max concurrent follower lookups
const CONCURRENCY = 3;

let stats = { lookups: 0, promoted: 0, rejected: 0, errors: 0 };

/**
 * Look up follower count for a pubkey by querying kind:3 events that tag them.
 * Returns the count, or -1 on failure.
 */
async function fetchFollowerCount(pubkey) {
  for (const url of RELAYS) {
    let relay;
    try {
      relay = await Relay.connect(url);

      const followers = new Set();
      let done = false;

      await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          done = true;
          resolve();
        }, 10000); // 10s timeout per relay

        relay.subscribe(
          [{ kinds: [3], '#p': [pubkey], limit: 100 }],
          {
            onevent(event) {
              if (!done) followers.add(event.pubkey);
            },
            oneose() {
              clearTimeout(timeout);
              done = true;
              resolve();
            },
          }
        );
      });

      relay.close();

      if (followers.size > 0 || done) {
        return followers.size;
      }
    } catch (e) {
      if (relay) try { relay.close(); } catch {}
      continue; // try next relay
    }
  }
  return -1; // all relays failed
}

/**
 * Look up and cache follower count for a pubkey.
 * Returns the follower count or -1 on failure.
 */
async function checkAndCacheFollowers(pubkey) {
  stats.lookups++;
  const count = await fetchFollowerCount(pubkey);

  if (count >= 0) {
    upsertReviewerStats(pubkey, count, 0);
    console.log(`[FollowerCheck] ${pubkey.slice(0, 8)}... has ${count} followers`);
    return count;
  }

  stats.errors++;
  console.warn(`[FollowerCheck] Failed to look up ${pubkey.slice(0, 8)}...`);
  return -1;
}

/**
 * Process the pending review queue.
 * Looks up follower counts for reviewers, promotes or rejects reviews.
 */
async function processPendingQueue() {
  const pending = getPendingReviews(50);
  if (pending.length === 0) return;

  console.log(`[FollowerCheck] Processing ${pending.length} pending reviews...`);

  // Get unique reviewer pubkeys
  const reviewerPubkeys = [...new Set(pending.map(r => r.reviewer_pubkey))];

  // Look up follower counts with concurrency limit
  const followerCounts = new Map();
  for (let i = 0; i < reviewerPubkeys.length; i += CONCURRENCY) {
    const batch = reviewerPubkeys.slice(i, i + CONCURRENCY);
    const results = await Promise.allSettled(
      batch.map(async pk => {
        // Check if we have recent stats first
        const existing = getReviewerStats(pk);
        if (existing && (Math.floor(Date.now() / 1000) - existing.last_checked) < 3600) {
          // Stats are less than 1 hour old, reuse
          return { pubkey: pk, count: existing.follower_count };
        }
        const count = await checkAndCacheFollowers(pk);
        return { pubkey: pk, count };
      })
    );

    for (const result of results) {
      if (result.status === 'fulfilled' && result.value.count >= 0) {
        followerCounts.set(result.value.pubkey, result.value.count);
      }
    }
  }

  // Now process each pending review
  for (const review of pending) {
    const count = followerCounts.get(review.reviewer_pubkey);

    if (count === undefined || count < 0) {
      // Still can't check — increment retry
      incrementPendingRetry(review.id);
      if (review.retries >= 4) {
        // Max retries reached, drop it
        deletePendingReview(review.id);
        stats.rejected++;
        console.log(`[FollowerCheck] Dropped ${review.id.slice(0, 8)}... after max retries`);
      }
      continue;
    }

    if (count >= MIN_REVIEWER_FOLLOWERS) {
      // Promote to main reviews table
      promotePendingReview(review.id);
      stats.promoted++;
      console.log(`[FollowerCheck] Promoted review ${review.id.slice(0, 8)}... (reviewer has ${count} followers)`);
    } else {
      // Reviewer doesn't have enough followers — reject
      deletePendingReview(review.id);
      stats.rejected++;
      console.log(`[FollowerCheck] Rejected review ${review.id.slice(0, 8)}... (reviewer has ${count} followers, need ${MIN_REVIEWER_FOLLOWERS})`);
    }
  }

  console.log(`[FollowerCheck] Queue done. Promoted: ${stats.promoted}, Rejected: ${stats.rejected}, Pending remaining: ${getPendingCount()}`);
}

/**
 * Start the follower checker background worker.
 */
export async function startFollowerChecker() {
  console.log(`[FollowerCheck] Starting. Min followers required: ${MIN_REVIEWER_FOLLOWERS}`);

  // Process pending queue periodically
  setInterval(async () => {
    try {
      await processPendingQueue();
    } catch (e) {
      console.error('[FollowerCheck] Queue processing error:', e.message);
    }
  }, PROCESS_INTERVAL_MS);

  // Do an initial run after a short delay (let ingester populate first)
  setTimeout(() => {
    processPendingQueue().catch(e =>
      console.error('[FollowerCheck] Initial run error:', e.message)
    );
  }, 15000);

  console.log(`[FollowerCheck] Running. Queue check every ${PROCESS_INTERVAL_MS / 1000}s.`);
}

/** Get follower checker stats */
export function getFollowerCheckerStats() {
  return {
    ...stats,
    pendingCount: getPendingCount()
  };
}
