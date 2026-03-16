// validator.js — Review validation rules for PubScore
import { verifyEvent } from 'nostr-tools';
import { countRecentReviewsByReviewer, getReviewerStats } from './db.js';

const REVIEW_KIND = 38100;
const LEGACY_KIND = 38383;
const VALID_KINDS = [REVIEW_KIND, LEGACY_KIND];
const MIN_REVIEWER_FOLLOWERS = 30;

/**
 * Validate a Nostr review event.
 * Returns:
 *   { valid: true, review }           — passes all checks, store immediately
 *   { valid: false, pending: true, review, reason }  — needs follower check, queue it
 *   { valid: false, reason }           — hard reject
 */
export function validateReview(event) {

  // 1. Must be correct kind
  if (!VALID_KINDS.includes(event.kind)) {
    return { valid: false, reason: `Wrong kind: ${event.kind}` };
  }

  // 2. Valid Nostr event signature
  try {
    if (!verifyEvent(event)) {
      return { valid: false, reason: 'Invalid event signature' };
    }
  } catch (e) {
    return { valid: false, reason: `Signature verification failed: ${e.message}` };
  }

  // 3. Extract reviewed pubkey from 'p' tag
  const pTag = event.tags.find(t => t[0] === 'p');
  if (!pTag || !pTag[1]) {
    return { valid: false, reason: 'Missing p tag (reviewed pubkey)' };
  }
  const reviewedPubkey = pTag[1];

  // 4. Can't review yourself
  if (event.pubkey === reviewedPubkey) {
    return { valid: false, reason: 'Self-review not allowed' };
  }

  // 5. Extract and validate rating (trusted / neutral / avoid)
  const VALID_RATINGS = ['trusted', 'neutral', 'avoid'];
  const ratingTag = event.tags.find(t => t[0] === 'rating');
  if (!ratingTag || !ratingTag[1]) {
    return { valid: false, reason: 'Missing rating tag' };
  }
  const rating = ratingTag[1].toLowerCase();
  if (!VALID_RATINGS.includes(rating)) {
    return { valid: false, reason: `Invalid rating: ${ratingTag[1]} (must be trusted, neutral, or avoid)` };
  }

  // 6. Rate limit: max 50 reviews per pubkey per day
  const recentCount = countRecentReviewsByReviewer(event.pubkey);
  if (recentCount >= 50) {
    return { valid: false, reason: 'Rate limit exceeded (50/day)' };
  }

  // 7. Extract categories from 't' tags
  const categories = event.tags
    .filter(t => t[0] === 't')
    .map(t => t[1])
    .filter(Boolean);

  const review = {
    id: event.id,
    reviewer_pubkey: event.pubkey,
    reviewed_pubkey: reviewedPubkey,
    rating,
    content: event.content || null,
    categories: categories.length ? JSON.stringify(categories) : null,
    created_at: event.created_at,
    ingested_at: Math.floor(Date.now() / 1000),
    event_json: JSON.stringify(event)
  };

  // 8. Follower check — reviewer must have ≥30 followers
  const stats = getReviewerStats(event.pubkey);

  if (!stats || stats.last_checked === 0) {
    // No stats yet — queue for later verification
    return {
      valid: false,
      pending: true,
      review,
      reason: `No follower data yet for ${event.pubkey.slice(0, 8)}...`
    };
  }

  // Stats are stale (>24h old) — accept if they previously qualified, otherwise queue
  const statsAge = Math.floor(Date.now() / 1000) - stats.last_checked;
  if (statsAge > 86400) {
    if (stats.follower_count >= MIN_REVIEWER_FOLLOWERS) {
      // Previously qualified, accept but flag for refresh
      return { valid: true, review, needsRefresh: true };
    }
    return {
      valid: false,
      pending: true,
      review,
      reason: `Stale stats for ${event.pubkey.slice(0, 8)}... (${stats.follower_count} followers, last checked ${Math.floor(statsAge / 3600)}h ago)`
    };
  }

  // Fresh stats — enforce the rule
  if (stats.follower_count < MIN_REVIEWER_FOLLOWERS) {
    return {
      valid: false,
      reason: `Reviewer has ${stats.follower_count} followers (need ${MIN_REVIEWER_FOLLOWERS})`
    };
  }

  return { valid: true, review };
}

export { MIN_REVIEWER_FOLLOWERS };