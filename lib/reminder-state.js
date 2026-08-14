'use strict';

const DEFAULT_TTL_MS = 48 * 60 * 60 * 1000;

function createDeliveryTracker(ttlMs = DEFAULT_TTL_MS) {
  const entries = new Map();

  function prune(now = Date.now()) {
    for (const [key, expiresAt] of entries) {
      if (expiresAt <= now) entries.delete(key);
    }
  }

  function has(key, now = Date.now()) {
    const expiresAt = entries.get(key);
    if (!expiresAt || expiresAt <= now) {
      entries.delete(key);
      return false;
    }
    return true;
  }

  function mark(key, now = Date.now()) {
    entries.set(key, now + ttlMs);
  }

  return { has, mark, prune, clear: () => entries.clear(), get size() { return entries.size; } };
}

module.exports = { DEFAULT_TTL_MS, createDeliveryTracker };
