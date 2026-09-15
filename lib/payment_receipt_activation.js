/**
 * Pure activation helpers for bank-transfer receipt OCR flow.
 * Used by Node tests; mirror logic in verify-payment-receipt edge function.
 */

const PLANS = Object.freeze({
  monthly: { amountSar: 299, days: 30, planCode: 'monthly' },
  quarterly: { amountSar: 899, days: 90, planCode: 'quarterly' },
});

const ALLOWED_AMOUNTS = new Set([299, 899]);

function normalizeReference(raw) {
  return String(raw || '')
    .trim()
    .replace(/\s+/g, '')
    .toUpperCase();
}

function planFromAmount(amountSar) {
  const amount = Number(amountSar);
  if (amount === 299) return { ...PLANS.monthly };
  if (amount === 899) return { ...PLANS.quarterly };
  return null;
}

/**
 * Validate OCR extraction before activation.
 * @returns {{ ok: true, plan, reference } | { ok: false, code, message }}
 */
function validateReceiptActivation({ amountSar, reference, existingReferences = [] }) {
  const ref = normalizeReference(reference);
  if (!ref || ref.length < 4) {
    return { ok: false, code: 'invalid_reference', message: 'مرجع التحويل غير صالح' };
  }
  const amount = Number(amountSar);
  if (!ALLOWED_AMOUNTS.has(amount)) {
    return {
      ok: false,
      code: 'wrong_amount',
      message: `المبلغ غير مطابق (المتوقع 299 أو 899، المستخرج ${amountSar})`,
    };
  }
  const existing = new Set(
    (existingReferences || []).map((r) => normalizeReference(r)).filter(Boolean),
  );
  if (existing.has(ref)) {
    return { ok: false, code: 'duplicate_reference', message: 'مرجع التحويل مستخدم مسبقاً' };
  }
  const plan = planFromAmount(amount);
  return { ok: true, plan, reference: ref, amountSar: amount };
}

/**
 * Compute new expires_at from current expiry (or now) + plan days.
 */
function computeExpiresAt(currentExpiresAt, days, now = new Date()) {
  const baseMs = currentExpiresAt ? new Date(currentExpiresAt).getTime() : 0;
  const start = Math.max(baseMs || 0, now.getTime());
  return new Date(start + Number(days) * 86400000).toISOString();
}

/**
 * Build profile patch after successful validation.
 */
function buildActivationPatch({ amountSar, reference, existingReferences, currentExpiresAt, now }) {
  const validated = validateReceiptActivation({ amountSar, reference, existingReferences });
  if (!validated.ok) return validated;
  const expiresAt = computeExpiresAt(currentExpiresAt, validated.plan.days, now || new Date());
  return {
    ok: true,
    plan: validated.plan,
    reference: validated.reference,
    amountSar: validated.amountSar,
    profilePatch: {
      subscription_status: 'active',
      expires_at: expiresAt,
      trial_end: expiresAt,
      approved: true,
    },
  };
}

module.exports = {
  PLANS,
  ALLOWED_AMOUNTS,
  normalizeReference,
  planFromAmount,
  validateReceiptActivation,
  computeExpiresAt,
  buildActivationPatch,
};
