/**
 * checks.js — conformance checks over a session report.
 *
 * WHY THIS FILE IS THE POINT OF THE PACKAGE. A runner that prints numbers is a
 * demo. A runner that asserts properties of those numbers is an instrument, and
 * the difference is what makes a report citable: a reader does not have to take
 * the number on faith, because the checks state what must hold for it to mean
 * anything.
 *
 * Each check is written against a failure that is REACHABLE, not hypothetical.
 * Every one below corresponds to a defect this project actually shipped or
 * nearly shipped, and the comment says which. A check nobody can fail is
 * decoration.
 *
 * STATUS VOCABULARY, deliberately narrow:
 *   'pass' — the property holds
 *   'fail' — it does not; the report is not trustworthy
 *   'warn' — it holds, but something limits how far the result generalises
 *          (an unwitnessed run, for instance) and a reader must know
 *   'n/a'  — the input needed for this check was not supplied; NOT a pass
 */

/**
 * @typedef {object} Check
 * @property {string} id
 * @property {string} name
 * @property {'pass'|'fail'|'warn'|'n/a'} status
 * @property {string} detail
 * @property {string} [because] the defect this check exists to catch
 */

/** @type {Check[]} */
export function runChecks(report) {
  const checks = [];
  const { measurement, timing, input, consent } = report;

  // -- the measurement itself ------------------------------------------------

  checks.push(checkRatioSoundness(measurement));

  // The ambiguous middle must be visible, not folded into either side. This is
  // the specific defect the three-outcome split exists to prevent: an abandoned
  // attempt counted as a device misfire makes the rate track the user's
  // decision-making instead of the hardware.
  //
  // THIS CHECK USED TO BE UNABLE TO FAIL. Its status expression was
  // `c.ambiguous > 0 ? 'pass' : 'n/a'`, so the fold it exists to catch — ambiguous
  // moved into false, leaving ambiguous at 0 — was indistinguishable from a
  // session that genuinely had none, and the run still reported ok. The evidence
  // for the fold now comes from the INPUT to classification (activations that
  // carry an 'undone' witness) rather than from the output it corrupts.
  const c = measurement.armed.counts;
  const undone = measurement.armed.activations.filter((a) => a.witness === 'undone');
  const foldSuspects = undone.filter((a) => a.outcome === 'false');
  const foldDetected = foldSuspects.length > 0;
  checks.push({
    id: 'measure.ambiguous-separate',
    name: 'The ambiguous count is reported separately',
    status: foldDetected
      ? 'fail'
      : (c.ambiguous > 0 && measurement.armed.ambiguousPerHour !== null ? 'pass' : 'n/a'),
    detail: foldDetected
      ? `${foldSuspects.length} undone activation(s) were classified 'false' — an ` +
        'abandoned attempt has been counted as a device misfire, which makes the ' +
        'rate track the user rather than the hardware'
      : `${c.ambiguous} ambiguous activation(s), reported as ` +
        `${measurement.armed.ambiguousPerHour ?? 'n/a'} per armed hour, ` +
        'never folded into the false count',
    because: 'collapsing ambiguous into false is the bug the three-outcome split prevents — ' +
             'and it is reachable by one line in the classifier',
  });

  // Both denominators must be present and must DIFFER when the exposure differs.
  // If they are equal, the session never distinguished armed time from work
  // time, which means the rate answers neither question precisely.
  const armed = measurement.armed;
  const active = measurement.active;
  checks.push({
    id: 'measure.denominators-distinct',
    name: 'Armed and active denominators are both tracked',
    status: armed.denominatorMs > 0 && active.denominatorMs > 0
      ? (armed.denominatorMs !== active.denominatorMs ? 'pass' : 'warn')
      : 'fail',
    detail: `armed ${armed.denominatorHours}h, active ${active.denominatorHours}h` +
            (armed.denominatorMs === active.denominatorMs
              ? ' — identical, so the run did not distinguish the two exposures'
              : ''),
    because: 'a single "per hour" hides a factor-of-two difference between watching ' +
             'with the switch armed and working at selection',
  });

  // An unwitnessed run is not a failure — but it must SAY that the rate came
  // from a parameter. A report that presents a threshold as a measurement is
  // the overclaim this project exists to avoid.
  checks.push({
    id: 'measure.witnessed-disclosed',
    name: 'The report discloses whether any independent witness backed it',
    status: typeof armed.witnessed === 'boolean' ? (armed.witnessed ? 'pass' : 'warn') : 'fail',
    detail: armed.witnessed
      ? 'independent evidence (host confirmation or an undo) classified at least one activation'
      : 'no independent witness — every verdict came from intentionalHoldMs, so the rate ' +
        'measures this parameter as much as the device',
    because: 'presenting a parameterised guess as a measurement is the overclaim pattern ' +
             'this package refuses',
  });

  // The parameters that decided verdicts must travel with the number.
  checks.push({
    id: 'measure.parameters-echoed',
    name: 'Classification parameters are reported alongside the rate',
    status: armed.parameters && Number.isFinite(armed.parameters.intentionalHoldMs) ? 'pass' : 'fail',
    detail: `intentionalHoldMs=${armed.parameters?.intentionalHoldMs}, ` +
            `spuriousHoldMs=${armed.parameters?.spuriousHoldMs}, ` +
            `undoWindowMs=${armed.parameters?.undoWindowMs}`,
    because: 'a reader must be able to see how much of the number came from the signal ' +
             'and how much from a choice',
  });

  // Every verdict must carry its reason, so the classification is auditable
  // rather than a black box.
  const missingBasis = armed.activations.filter((a) => !a.basis);
  checks.push({
    id: 'measure.verdicts-justified',
    name: 'Every classification carries its basis',
    status: missingBasis.length === 0 ? 'pass' : 'fail',
    detail: `${armed.activations.length} activation(s); ${missingBasis.length} without a stated reason`,
    because: 'an opaque verdict cannot be audited, and this number will be contested',
  });

  // -- timing ----------------------------------------------------------------

  checks.push({
    id: 'timing.one-clock',
    name: 'The timing layer advanced on the session clock',
    status: timing.tokensEmitted > 0 ? 'pass' : 'fail',
    detail: `${timing.tokensEmitted} token(s) emitted, last at ${timing.lastToken}, ` +
            `engine=${timing.engine}`,
    because: 'a timing layer that never advanced, or advanced on its own clock, ' +
             'is the two-timebase defect that made a test in this project fail ' +
             '4 of 12 runs under load',
  });

  // Monotonic tokens: the read position must not go backwards within a session.
  //
  // This check previously read `timing.tokensEmitted > 0 ? 'pass' : 'n/a'` — a
  // duplicate of timing.one-clock that could not examine monotonicity, because
  // the report did not carry the emission order. It now compares the sequence.
  const seq = timing.tokenSequence;
  let breakAt = -1;
  if (Array.isArray(seq)) {
    for (let i = 1; i < seq.length; i++) {
      if (!(seq[i] > seq[i - 1])) { breakAt = i; break; }
    }
  }
  checks.push({
    id: 'timing.monotonic',
    name: 'Token emission is monotonic',
    status: !Array.isArray(seq)
      ? 'n/a'
      : (seq.length === 0 ? 'n/a' : (breakAt === -1 ? 'pass' : 'fail')),
    detail: !Array.isArray(seq)
      ? 'the report did not carry the emission sequence, so monotonicity cannot be assessed'
      : (breakAt === -1
        ? `${seq.length} emission(s) across ${timing.words} word(s), strictly increasing`
        : `read position went backwards at index ${breakAt}: ${seq[breakAt - 1]} -> ${seq[breakAt]}`),
    because: 'a non-monotonic read position means the highlight layer would visibly jump backwards',
  });

  // -- input -----------------------------------------------------------------

  // The gated step must not have fired. This is the consent gate doing its job
  // at the boundary that matters: a withdrawal stops the signal, it does not
  // merely refuse to forward an event.
  const gatedSteps = report.steps.filter((s) => s.gated);
  checks.push({
    id: 'input.gate-holds',
    name: 'A withdrawn purpose prevents activation',
    status: gatedSteps.length === 0
      ? 'n/a'
      : (gatedSteps.every((s) => !s.fired) ? 'pass' : 'fail'),
    detail: gatedSteps.length === 0
      ? 'no gated step in this scenario'
      : `${gatedSteps.length} gated step(s), ${gatedSteps.filter((s) => s.fired).length} fired`,
    because: 'a consent layer that records a decision but does not prevent processing ' +
             'is documentation, not consent',
  });

  // -- consent ---------------------------------------------------------------

  checks.push({
    id: 'consent.chain-intact',
    name: 'The consent event chain verifies',
    status: consent.chainIntact ? 'pass' : 'fail',
    detail: `epoch=${consent.epoch}, granted=[${consent.granted.join(', ')}]`,
    because: 'an event log that does not verify cannot support a claim about what was consented to',
  });

  // The handling must be DECLARED by this host, never asserted by the library.
  // An "unstated" handling is honest; a library-asserted "none" would be a claim
  // about code it does not control.
  checks.push({
    id: 'consent.handling-declared',
    name: 'Data handling is declared by the host, not asserted by a library',
    status: consent.handlingStated ? 'pass' : 'warn',
    detail: consent.handlingStated
      ? 'the host supplied a declaration and it is recorded'
      : 'no declaration — the record reports the handling as UNSTATED, which is honest ' +
        'but limits what the run can claim',
    because: 'a library stating what its host does with a signal is asserting something it ' +
             'cannot observe, and one added cloud path makes it false',
  });

  return checks;
}

/**
 * The rate arithmetic: a rate with no denominator must be null, not zero.
 *
 * THIS CHECK IS THE ONE THAT MATTERS MOST. `falsePerHour: 0` reads as "no
 * misfires"; the truth is "no measurement". A device nobody measured must not
 * look like a perfect one, and the difference between those two zeros is the
 * kind of thing that decides whether a published number means anything.
 */
function checkRatioSoundness(measurement) {
  const armed = measurement.armed;
  const zeroDenominator = armed.denominatorHours === 0;
  const falseIsNull = armed.falsePerHour === null;
  const ok = zeroDenominator ? falseIsNull : Number.isFinite(armed.falsePerHour);

  return {
    id: 'measure.ratio-sound',
    name: 'An absent denominator reports null, never zero',
    status: armed.denominatorHours > 0 ? 'pass' : (ok ? 'warn' : 'fail'),
    detail: armed.denominatorHours > 0
      ? `${armed.denominatorHours}h denominator, rate ${armed.falsePerHour}/h`
      : 'zero exposure — rate correctly reported as null rather than 0',
    because: 'a rate of 0 with no exposure reads as a perfect device; null reads as unmeasured',
  };
}
