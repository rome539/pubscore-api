// ingester.js — Continuous relay listener for PubScore review events
import 'websocket-polyfill';
import { Relay } from 'nostr-tools/relay';
import { validateReview } from './validator.js';
import { upsertReviewsBatch, addPendingReview, getIngestionState, setIngestionState, getTotalReviewCount, getPendingCount, getDB } from './db.js';

const REVIEW_KIND = 38383;

const RELAYS = [
  'wss://relay.damus.io',
  'wss://relay.mostr.pub',
  'wss://relay.nostrplebs.com',
  'wss://relay.primal.net',
  'wss://nos.lol',
  'wss://relay.snort.social',
];

// How far back to look on first run (90 days)
const INITIAL_LOOKBACK = 90 * 24 * 60 * 60;
// How often to flush the buffer to DB
const FLUSH_INTERVAL_MS = 5000;
// How often to run the authors backfill (every 6 hours)
const BACKFILL_INTERVAL_MS = 6 * 60 * 60 * 1000;

let buffer = [];
let seenEventIds = new Set();
let stats = { received: 0, valid: 0, invalid: 0, pending: 0, duplicates: 0 };
let connectedRelays = [];

/** Flush buffered reviews to database */
function flushBuffer() {
  if (buffer.length === 0) return;
  const batch = buffer.splice(0);
  try {
    upsertReviewsBatch(batch);
    console.log(`[Ingester] Flushed ${batch.length} reviews to DB (total: ${getTotalReviewCount()}, pending: ${getPendingCount()})`);
  } catch (e) {
    console.error('[Ingester] Flush error:', e.message);
    buffer.unshift(...batch);
  }
}

/** Process a single incoming event — deduplicated */
function processEvent(event) {
  if (seenEventIds.has(event.id)) {
    stats.duplicates++;
    return;
  }
  seenEventIds.add(event.id);
  // Keep seen set from growing unbounded
  if (seenEventIds.size > 50000) {
    const arr = [...seenEventIds];
    seenEventIds = new Set(arr.slice(arr.length - 25000));
  }

  stats.received++;
  const result = validateReview(event);
  if (result.valid) {
    stats.valid++;
    buffer.push(result.review);
  } else if (result.pending) {
    stats.pending++;
    try {
      addPendingReview(result.review);
    } catch (e) {
      console.error('[Ingester] Failed to queue pending review:', e.message);
    }
  } else {
    stats.invalid++;
    if (!result.reason.includes('Wrong kind') && !result.reason.includes('Missing p tag')) {
      console.log(`[Ingester] Rejected: ${result.reason} (event ${event.id?.slice(0, 8)})`);
    }
  }
}

/** Connect to a single relay and subscribe */
async function connectToRelay(url, sinceTimestamp) {
  try {
    const relay = await Relay.connect(url);
    console.log(`[Ingester] Connected to ${url}`);

    relay.subscribe(
      [{ kinds: [REVIEW_KIND], since: sinceTimestamp }],
      {
        onevent(event) {
          processEvent(event);
        },
        oneose() {
          console.log(`[Ingester] EOSE from ${url}. Stats so far: received=${stats.received} valid=${stats.valid}`);
        },
      }
    );

    connectedRelays.push(relay);

    relay.onclose = () => {
      console.warn(`[Ingester] Disconnected from ${url}, reconnecting in 15s...`);
      connectedRelays = connectedRelays.filter(r => r !== relay);
      setTimeout(() => {
        const since = parseInt(getIngestionState('last_event_time') || '0', 10) || sinceTimestamp;
        connectToRelay(url, since).catch(e =>
          console.error(`[Ingester] Reconnect failed for ${url}:`, e.message)
        );
      }, 15000);
    };

    return relay;
  } catch (e) {
    console.error(`[Ingester] Failed to connect to ${url}:`, e.message);
    setTimeout(() => {
      connectToRelay(url, sinceTimestamp).catch(() => {});
    }, 30000);
    return null;
  }
}

/** Get all known reviewer pubkeys from the DB */
function getKnownReviewerPubkeys() {
  try {
    return getDB().prepare('SELECT DISTINCT reviewer_pubkey FROM reviews').all().map(r => r.reviewer_pubkey);
  } catch (e) {
    console.error('[Ingester] Failed to get reviewer pubkeys:', e.message);
    return [];
  }
}

/**
 * Backfill pass — queries relays by authors filter for all known reviewers.
 * This catches reviews that relays don't return via #p tag indexing.
 */
async function runAuthorsBackfill() {
  const reviewers = getKnownReviewerPubkeys();
  if (!reviewers.length) return;

  console.log(`[Ingester] Starting authors backfill for ${reviewers.length} known reviewers...`);
  const since = Math.floor(Date.now() / 1000) - INITIAL_LOOKBACK;
  let found = 0;

  // Batch into groups of 50 to avoid oversized filters
  const BATCH_SIZE = 50;
  for (let i = 0; i < reviewers.length; i += BATCH_SIZE) {
    const batch = reviewers.slice(i, i + BATCH_SIZE);

    for (const url of RELAYS) {
      let relay;
      try {
        relay = await Relay.connect(url);
        await new Promise(res => {
          relay.subscribe(
            [{ kinds: [REVIEW_KIND], authors: batch, since }],
            {
              onevent(event) {
                processEvent(event);
                found++;
              },
              oneose() { res(); },
            }
          );
          setTimeout(res, 8000);
        });
        relay.close();
      } catch (e) {
        if (relay) try { relay.close(); } catch {}
      }
    }
  }

  // Flush anything found
  flushBuffer();
  console.log(`[Ingester] Authors backfill complete. Found ${found} events.`);
}

/** Track the latest event timestamp for bookmarking */
function updateBookmark() {
  if (buffer.length === 0) return;
  const maxTime = Math.max(...buffer.map(r => r.created_at));
  if (maxTime > 0) {
    setIngestionState('last_event_time', String(maxTime));
  }
}

/** Main entry: start the ingester */
export async function startIngester() {
  const savedTime = getIngestionState('last_event_time');
  const sinceTimestamp = savedTime
    ? parseInt(savedTime, 10)
    : Math.floor(Date.now() / 1000) - INITIAL_LOOKBACK;

  console.log(`[Ingester] Starting up. DB has ${getTotalReviewCount()} reviews.`);
  console.log(`[Ingester] Subscribing since ${new Date(sinceTimestamp * 1000).toISOString()}`);

  await Promise.allSettled(
    RELAYS.map(url => connectToRelay(url, sinceTimestamp))
  );

  console.log(`[Ingester] Connected to ${connectedRelays.length}/${RELAYS.length} relays.`);

  setInterval(() => {
    updateBookmark();
    flushBuffer();
  }, FLUSH_INTERVAL_MS);

  // Run authors backfill on startup after a short delay, then every 6 hours
  setTimeout(async () => {
    await runAuthorsBackfill();
    setInterval(runAuthorsBackfill, BACKFILL_INTERVAL_MS);
  }, 30000);

  console.log('[Ingester] Running. Flush every 5s. Authors backfill every 6h.');
}

/** Get ingester stats */
export function getIngesterStats() {
  return {
    ...stats,
    bufferSize: buffer.length,
    connectedRelays: connectedRelays.length
  };
}
