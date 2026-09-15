const assert = require('assert');
const {
  validateReceiptActivation,
  buildActivationPatch,
  computeExpiresAt,
  PLANS,
} = require('../lib/payment_receipt_activation');

function test(name, fn) {
  try {
    fn();
    console.log(`PASS  ${name}`);
  } catch (err) {
    console.error(`FAIL  ${name}`);
    console.error(err);
    process.exitCode = 1;
  }
}

test('rejects duplicate reference', () => {
  const r = validateReceiptActivation({
    amountSar: 299,
    reference: 'ABC12345',
    existingReferences: ['abc12345'],
  });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.code, 'duplicate_reference');
});

test('rejects wrong amount', () => {
  const r = validateReceiptActivation({
    amountSar: 499,
    reference: 'REF99999',
    existingReferences: [],
  });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.code, 'wrong_amount');
});

test('accepts 299 SAR → 30 days', () => {
  const now = new Date('2026-09-15T12:00:00.000Z');
  const r = buildActivationPatch({
    amountSar: 299,
    reference: 'TXN299AAA',
    existingReferences: [],
    currentExpiresAt: null,
    now,
  });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.plan.days, 30);
  assert.strictEqual(r.plan.planCode, 'monthly');
  assert.strictEqual(r.profilePatch.subscription_status, 'active');
  const exp = new Date(r.profilePatch.expires_at);
  assert.strictEqual(Math.round((exp - now) / 86400000), 30);
});

test('accepts 899 SAR → 90 days', () => {
  const now = new Date('2026-09-15T12:00:00.000Z');
  const r = buildActivationPatch({
    amountSar: 899,
    reference: 'TXN899BBB',
    existingReferences: [],
    currentExpiresAt: null,
    now,
  });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.plan.days, 90);
  assert.strictEqual(r.plan.planCode, 'quarterly');
  assert.strictEqual(Math.round((new Date(r.profilePatch.expires_at) - now) / 86400000), 90);
});

test('extends from existing unexpired trial_end/expires_at', () => {
  const now = new Date('2026-09-15T12:00:00.000Z');
  const current = '2026-09-25T12:00:00.000Z';
  const exp = computeExpiresAt(current, PLANS.monthly.days, now);
  assert.strictEqual(exp, '2026-10-25T12:00:00.000Z');
});

test('rejects short reference', () => {
  const r = validateReceiptActivation({ amountSar: 299, reference: 'AB' });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.code, 'invalid_reference');
});

if (!process.exitCode) console.log('\nAll payment receipt activation tests passed.');
