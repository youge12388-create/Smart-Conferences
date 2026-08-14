'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createDeliveryTracker } = require('../lib/reminder-state');

test('delivery tracker expires and prunes old reminder keys', () => {
  const tracker = createDeliveryTracker(100);
  tracker.mark('m1', 1000);
  assert.equal(tracker.has('m1', 1050), true);
  assert.equal(tracker.has('m1', 1100), false);
  tracker.mark('m2', 1000);
  tracker.prune(1101);
  assert.equal(tracker.size, 0);
});
