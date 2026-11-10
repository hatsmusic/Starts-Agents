// A tiny in-memory fixed-window rate limiter (v0.14 batch 2).
// One Map of key -> { start, count, windowMs }; windows reset lazily
// on the next hit for that key, and an opportunistic sweep drops
// expired buckets once the map grows past a few thousand entries, so
// memory stays bounded without a timer. Deliberately NOT persisted:
// a restart resets the counters, which is the forgiving direction
// for the endpoints this guards (worst case, an attacker gets one
// fresh window per restart — the per-account limits in auth.js,
// which ARE the enumeration-sensitive ones, live elsewhere).
const buckets = new Map();
const SWEEP_AT = 5000;

export function rateHit(key, { limit, windowMs }, now = Date.now()) {
  if (!limit || limit <= 0) return { ok: true, retryAfter: 0 };
  let b = buckets.get(key);
  if (!b || now - b.start >= windowMs) {
    b = { start: now, count: 0, windowMs };
    buckets.set(key, b);
  }
  b.count += 1;
  if (buckets.size > SWEEP_AT) {
    for (const [k, v] of buckets) if (now - v.start >= v.windowMs) buckets.delete(k);
  }
  return {
    ok: b.count <= limit,
    retryAfter: Math.max(1, Math.ceil((b.start + windowMs - now) / 1000)),
  };
}
