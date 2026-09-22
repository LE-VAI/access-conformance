/**
 * conformance.test.mjs — the cross-package session and its checks.
 *
 * The rules that matter:
 *   - a run reports the composite: timing advanced, input activated, consent
 *     verified, rate computed
 *   - a WITHDRAWN purpose actually prevents activation (not merely records it)
 *   - the three-outcome split survives the trip across package boundaries
 *   - the checks can FAIL — a suite that only ever passes is decoration
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { runSession, SessionClock } from '../src/runner.js';
import { runChecks } from '../src/checks.js';

// -- the composite ----------------------------------------------------------

test('a default session drives all three layers', () => {
  const r = runSession({ sessionId: 'test-1' });
  assert.equal(r.schema, 'access-conformance/1');
  assert.ok(r.timing.tokensEmitted > 0, 'the timing layer advanced');
  assert.ok(r.input.activations > 0, 'the input layer activated');
  assert.ok(r.consent.chainIntact, 'the consent chain verified');
  assert.ok(r.measurement.armed.denominatorMs > 0, 'a denominator was tracked');
  assert.equal(r.ok, true, 'and no check failed');
});

test('every check carries a reason it exists', () => {
  const r = runSession();
  for (const c of r.checks) {
    assert.ok(c.id, 'a check without an id cannot be referenced');
    assert.ok(c.name);
    assert.ok(c.detail, `${c.id} must say what it observed`);
    assert.ok(c.because, `${c.id} must say which defect it exists to catch`);
  }
});

test('the timing layer emits the tokens the scenario spans', () => {
  const r = runSession({ wordCount: 20, wordsPerMinute: 200 });
  assert.ok(r.timing.tokensEmitted > 0);
  assert.equal(r.timing.words, 20, 'the report names the word count it timed');
  assert.ok(r.timing.msPerWord > 0);
});

// -- consent actually gates -------------------------------------------------

test('CRITICAL: a withdrawn purpose prevents activation', () => {
  // The scenario's fourth step withdraws consent and holds a dwell. It must not
  // fire. This is consent doing its job at the boundary that matters — a
  // recorded decision that does not prevent processing is documentation.
  const r = runSession();
  const gated = r.steps.filter((s) => s.gated);
  assert.ok(gated.length > 0, 'the scenario must include a gated step');
  assert.ok(gated.every((s) => !s.fired), 'a gated step must not activate');
  const gateCheck = r.checks.find((c) => c.id === 'input.gate-holds');
  assert.equal(gateCheck.status, 'pass');
});

test('the source resumes only on a deliberate re-grant', () => {
  const r = runSession();
  // The scenario withdraws, then re-grants before its final step. Both facts
  // must be visible: an epoch recording the withdrawal, and the grant present.
  assert.equal(r.consent.epoch, 1, 'one withdrawal is recorded');
  assert.ok(r.consent.granted.includes('acquire_signal'), 'acquisition was re-granted');
  assert.ok(r.consent.chainIntact, 'and the chain still verifies across both events');
});

test('CRITICAL: starting without consent means nothing activates until it is granted', () => {
  // `grantConsent: false` is "start without", not "never" — the scenario's
  // regrant step legitimately grants acquisition partway through, which is a
  // stronger demonstration than a run that simply refuses throughout: it shows
  // the gate opening as well as closing.
  //
  // What must hold: nothing activates while there is no grant, and the ONLY
  // activation in the run comes after the grant.
  const r = runSession({ grantConsent: false });
  assert.equal(r.consent.epoch, 0, 'no withdrawal happened — there was nothing to withdraw');

  const beforeGrant = r.steps.filter((s) => !s.gated && s.target !== 'w5');
  assert.ok(
    beforeGrant.every((s) => !s.fired),
    'no step before the re-grant may activate — the gate had nothing to permit',
  );
  assert.equal(r.measurement.armed.counts.total, 1,
    'exactly one activation, and it is the post-grant one');
  assert.equal(r.steps[r.steps.length - 1].target, 'w5', 'which is the final step');
  assert.ok(r.consent.granted.includes('acquire_signal'), 'the grant is recorded');
});

test('a wholly ungated run activates nothing at all', () => {
  // A scenario with no regrant, run without consent, is the pure refusal case.
  const r = runSession({
    grantConsent: false,
    events: [
      { advanceMs: 0, target: 'a', holdMs: 1400, outcome: { witness: 'confirmed' } },
    ],
  });
  assert.deepEqual(r.consent.granted, [], 'nothing was ever granted');
  assert.equal(r.input.activations, 0, 'and nothing could activate');
  assert.equal(r.measurement.armed.counts.total, 0);
});

// -- the measurement crosses the package boundary intact --------------------

test('CRITICAL: the three-outcome split survives the trip across packages', () => {
  // The classifier lives in access-input; the report is assembled here. The
  // ambiguous category must still be reported SEPARATELY after that trip — it is
  // the thing most likely to be silently folded into a total.
  const r = runSession();
  const counts = r.measurement.armed.counts;
  assert.ok(counts.total > 0, 'activations were classified');
  assert.equal(
    counts.true + counts.ambiguous + counts.false, counts.total,
    'the three outcomes partition the total — nothing was dropped or double-counted',
  );
  assert.ok(r.measurement.armed.ambiguousPerHour !== undefined,
    'the ambiguous rate is reported on its own line');
});

test('a completed dwell misfire is AMBIGUOUS, not false — and that is correct', () => {
  // A dwell cannot complete in under lockOnMs + dwellMs, so a completed dwell is
  // never "brief" enough for the spurious threshold. Every undone dwell lands in
  // ambiguous. Found by building this scenario; recorded so it is not re-filed as
  // a bug.
  const r = runSession();
  const undone = r.measurement.armed.activations.filter((a) => a.witness === 'undone');
  assert.ok(undone.length > 0, 'the scenario includes undone activations');
  for (const a of undone) {
    assert.equal(a.outcome, 'ambiguous', `${a.heldMs}ms hold must be ambiguous`);
    assert.ok(a.heldMs >= 750, 'and it cleared lock-on plus the dwell');
  }
  assert.equal(r.measurement.armed.counts.false, 0);
});

test('the report discloses witnessed state honestly', () => {
  const r = runSession();
  assert.equal(r.measurement.armed.witnessed, true,
    'the scenario supplies witnesses, so the rate is not purely parameterised');
});

test('both denominators are tracked and differ', () => {
  const r = runSession({ activeMs: 900000 });
  assert.notEqual(
    r.measurement.armed.denominatorMs,
    r.measurement.active.denominatorMs,
    'the run distinguishes armed exposure from work exposure',
  );
});

// -- the checks must be able to fail ----------------------------------------

test('CRITICAL: the gate check FAILS when a gated step fires', () => {
  // A check that cannot fail is decoration. This drives runChecks with a report
  // whose gated step fired, and requires the check to say so.
  const r = runSession();
  const sabotaged = structuredClone(r);
  const gated = sabotaged.steps.find((s) => s.gated);
  gated.fired = true;                     // the failure being simulated
  const checks = runChecks(sabotaged);
  const gate = checks.find((c) => c.id === 'input.gate-holds');
  assert.equal(gate.status, 'fail', 'a gated step that fired must fail the check');
});

test('CRITICAL: a zero denominator reports null, never zero', () => {
  // The single most important arithmetic property: 0 reads as "no misfires",
  // null reads as "unmeasured". An unmeasured device must not look perfect.
  const r = runSession();
  const sabotaged = structuredClone(r);
  sabotaged.measurement.armed.denominatorMs = 0;
  sabotaged.measurement.armed.denominatorHours = 0;
  sabotaged.measurement.armed.falsePerHour = 0;   // the bug being simulated
  const checks = runChecks(sabotaged);
  const ratio = checks.find((c) => c.id === 'measure.ratio-sound');
  assert.equal(ratio.status, 'fail', 'a zero rate with zero exposure must fail');
});

test('CRITICAL: an unwitnessed run warns rather than passing silently', () => {
  const r = runSession();
  const sabotaged = structuredClone(r);
  sabotaged.measurement.armed.witnessed = false;
  const checks = runChecks(sabotaged);
  const w = checks.find((c) => c.id === 'measure.witnessed-disclosed');
  assert.equal(w.status, 'warn',
    'an unwitnessed rate is not a failure, but it must not read as a clean pass');
});

test('a verdict with no stated basis fails the audit check', () => {
  const r = runSession();
  const sabotaged = structuredClone(r);
  sabotaged.measurement.armed.activations[0].basis = '';
  const checks = runChecks(sabotaged);
  assert.equal(checks.find((c) => c.id === 'measure.verdicts-justified').status, 'fail');
});

// -- the clock --------------------------------------------------------------

test('the session clock is monotonic', () => {
  const c = new SessionClock(0);
  const a = c.advance(16);
  const b = c.advance(16);
  assert.ok(b > a, 'time moves forward');
  assert.equal(c.to(500), 500, 'to() sets an absolute position');
  assert.ok(c.now() >= b);
});

test('a caller can script its own events instead of the default scenario', () => {
  const r = runSession({
    events: [
      { advanceMs: 0, target: 'a', holdMs: 1400, outcome: { witness: 'confirmed' } },
    ],
  });
  assert.equal(r.steps.length, 1);
  assert.equal(r.input.targets[0], 'a');
  assert.equal(r.measurement.armed.counts.total, 1);
});
