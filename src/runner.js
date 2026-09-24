/**
 * runner.js — one instrumented session across the whole stack.
 *
 * WHY THIS EXISTS RATHER THAN THREE PACKAGES. read-along, access-input and
 * neural-consent were built as composable layers, and they compose — but the
 * composition is invisible to anyone outside the project. Three repositories
 * ask three separate "why would I use this?" questions, and a reader has no way
 * to see the thing they actually form together: an instrumented assistive
 * session where the timing layer, the input layer and the consent layer are all
 * observable at once, and a misfire rate falls out of the run.
 *
 * That composite is what this file is. It is also the only artifact here that a
 * stranger can CITIFY: a lab can run it, a clinician can be trained on it, a
 * reader can audit the report. See docs/MEASUREMENT-PROTOCOL.md.
 *
 * THE HONEST BOUNDARY. read-along's main entry defines a custom element at
 * module top level and therefore throws in Node — verified, not assumed. So the
 * headless run drives the **ExternalEngine**, which is precisely the engine a
 * BCI/AT layer uses: a host process supplies word timings and ticks a clock.
 * That is not a workaround for the test; it is the integration path being
 * exercised. The DOM component and the DOM path are covered by read-along's own
 * suite and its screen-reader verification.
 *
 * EVERY TIMESTAMP COMES FROM ONE CLOCK. This is the defect that cost this
 * project a load-dependent test failure: a source stamping its own clock while
 * the engine ticked another makes `elapsed` negative and a dwell can never
 * complete. AccessOutcomeCounter, DwellEngine, ActivationDetector and the
 * ExternalEngine are all driven from the single `clock` object below.
 */

import { DwellEngine, SignalBridge, ExternalSource, AccessOutcomeCounter, DENOMINATORS } from 'access-input';
import { ConsentManager, PURPOSES, noticeVersion, SIGNAL_HANDLING, DERIVED_METADATA_HANDLING } from 'neural-consent';
import { ExternalEngine } from '@designesy/read-along/engines/external.js';
import { wordTimingsFromChunk, toEngineManifest } from '@designesy/read-along/timings.js';
import { tokenize, chunkTokens } from '@designesy/read-along/tokenizer.js';

import { runChecks } from './checks.js';

/**
 * A single shared clock. Everything in the session reads from this.
 *
 * `advance()` moves it and returns the new value, so a driver loop reads
 * naturally and cannot accidentally pass a different timebase — the failure
 * mode that produced a two-clock bug in this codebase once already.
 */
export class SessionClock {
  constructor(start = 0) { this.t = start; }
  now() { return this.t; }
  advance(ms) { this.t += ms; return this.t; }
  to(ms) { this.t = ms; return this.t; }
}

/**
 * A synthetic but honest session: a person reading, driving the reader with a
 * switch, under a consent gate, with the misfire rate measured.
 *
 * @param {object} [options]
 * @param {string} [options.sessionId]
 * @param {number} [options.dwellMs=600]
 * @param {number} [options.wordCount=40]
 * @param {number} [options.wordsPerMinute=180]
 * @param {boolean} [options.grantConsent=true]
 * @param {number} [options.armedMs]  declared armed exposure. Omit to use the
 *   session's OBSERVED length — see the exposure-resolution note before the report
 * @param {number} [options.activeMs]  declared time actually working at selection.
 *   Omit to derive from the observed session. Declaring activeMs alone does NOT
 *   invent an armed window; the CLI pairs them when only --active-ms is passed
 * @param {Array<object>} [options.events] scripted activations, if a caller
 *   wants to inject specific outcomes rather than the default scenario
 * @returns {object} the report
 */
export function runSession(options = {}) {
  const sessionId = options.sessionId ?? 'conformance-1';
  const dwellMs = options.dwellMs ?? 600;
  const wordCount = options.wordCount ?? 40;
  const wpm = options.wordsPerMinute ?? 180;
  const grantConsent = options.grantConsent !== false;

  const clock = new SessionClock(0);

  // ---------------------------------------------------------------------
  // Layer 1 — CONSENT. The gate every other layer asks before acting.
  //
  // The declaration is supplied by THIS host, not by the library: a library
  // cannot truthfully state what its host does with a signal, and this package
  // is the host. That is the whole point of neural-consent's declaration model,
  // and a conformance run that skipped it would be ignoring the layer's design.
  // ---------------------------------------------------------------------
  const consent = new ConsentManager({
    now: () => clock.now(),
    validDays: 365,
    declaration: {
      signal: SIGNAL_HANDLING.LOCAL_ONLY,
      derivedMetadata: DERIVED_METADATA_HANDLING.NONE,
      declaredBy: 'access-conformance',
    },
  });

  if (grantConsent) {
    consent.grant(PURPOSES.ACQUIRE_SIGNAL.id, { noticeVersion: noticeVersion() });
    consent.grant(PURPOSES.PROCESS_LOCALLY.id, { noticeVersion: noticeVersion() });
  }

  // ---------------------------------------------------------------------
  // Layer 2 — TIMING. The read-along engine, driven externally.
  //
  // The timings come from read-along's own tokenizer and timing derivation, not
  // from hand-written numbers — so this exercises the real path (tokenize →
  // chunk → derive spans from a duration) rather than a fixture that merely
  // looks like its output. The synthetic audio buffer is the one concession:
  // its duration is what sets the speaking rate, and it stands in for a real
  // synthesized clip because this run has no audio device. The derivation from
  // it is real, which is the part under test.
  //
  // requestAnimationFrame: ExternalEngine arms a rAF loop, which Node lacks.
  // A no-op shim is CORRECT here rather than a workaround, and the engine's own
  // code is the evidence: when the host is ticking, that loop calls
  // `_advance(this._clock)` — the same clock value tick() already delivered —
  // so it is a liveness re-check, not the thing that advances the read. The
  // host owns the clock; `tick()` does the work. A rAF that never fires cannot
  // lose a token, and the "one clock" conformance check proves the read
  // advanced rather than assuming it.
  // ---------------------------------------------------------------------
  installRafShim();

  const text = Array.from({ length: wordCount }, (_, i) => `word${i + 1}`).join(' ');
  const tokens = tokenize(text);
  const chunks = chunkTokens(tokens);
  const msPerWord = Math.round(60000 / wpm);
  const totalMs = tokens.length * msPerWord;
  const sampleRate = 24000;

  // One timing set per chunk, from that chunk's own span duration.
  //
  // THE OFFSET IS NOT OPTIONAL. `wordTimingsFromChunk` derives spans from the
  // chunk's own audio duration, so every chunk's timings begin at 0. The engines
  // expect ONE session-absolute manifest, so concatenating the per-chunk results
  // without a cumulative offset produces a sequence whose start times reset —
  // chunk 0 spans 0..4329ms and chunk 1 also starts at 0. The consequence is not
  // an error but a silent one: `ExternalEngine` emits tokens in manifest order
  // and interleaves the two chunks (13,14,2,15,3,...), so the read position jumps
  // backwards 11 times in a 40-word read and the first two tokens never fire at
  // all. The highlight layer would visibly jerk back and forth.
  //
  // Found by making `timing.monotonic` compare the actual emission sequence
  // instead of asserting `tokensEmitted > 0` — the check could not see this,
  // and the report could not either, because the sequence was never emitted.
  const timings = [];
  let chunkOffsetMs = 0;
  for (const chunk of chunks) {
    const chunkMs = Math.max(chunk.tokens.length, 1) * msPerWord;
    const audio = {
      sampleRate,
      samples: { length: Math.round((chunkMs / 1000) * sampleRate) },
    };
    const chunkTimings = wordTimingsFromChunk(chunk, audio);
    for (const t of chunkTimings) {
      timings.push({
        ...t,
        startMs: t.startMs + chunkOffsetMs,
        endMs: t.endMs + chunkOffsetMs,
      });
    }
    chunkOffsetMs += chunkMs;
  }
  // Convert to the tuple manifest the engines require. This is the seam that
  // was broken until 0.2.3 — the producer returned objects, the consumer wants
  // tuples, and the header claimed they matched.
  const manifest = toEngineManifest(timings);

  const readEngine = new ExternalEngine({ words: manifest });
  const tokensSeen = [];
  readEngine.onToken = (i) => { tokensSeen.push(i); };

  // ---------------------------------------------------------------------
  // Layer 3 — INPUT. A switch drives the reader. Dwell is what turns a
  // continuous signal into a selection, so the session uses the dwell path.
  // ---------------------------------------------------------------------
  const source = new ExternalSource({ now: () => clock.now() });
  const dwell = new DwellEngine({ dwellMs, lockOnMs: 150, graceMs: 140 });
  const activations = [];
  const bridge = new SignalBridge({
    source,
    dwell,
    mode: 'dwell',
    // The engine's clock, explicitly — see the single-clock contract above.
    now: () => clock.now(),
    consent,                       // the gate, duck-typed, from layer 1
    consentPurpose: PURPOSES.ACQUIRE_SIGNAL.id,
    onActivate: (id, meta) => activations.push({ id, ...meta }),
  });

  // ---------------------------------------------------------------------
  // Layer 4 — MEASUREMENT. The three-outcome classifier.
  // ---------------------------------------------------------------------
  const counter = new AccessOutcomeCounter({
    sessionId,
    intentionalHoldMs: options.intentionalHoldMs ?? 400,
  });
  // The session's exposure.
  //
  // DEFAULTS NOW COME FROM THE OBSERVED SESSION, NOT FROM A DECLARATION. This
  // block previously defaulted to a literal 30min armed / 15min active, which
  // meant a 27-second scripted scenario reported `0.507h armed` — a 68x
  // extrapolation, and the 15-minute floor could never fire because it was
  // tested against the declared figure rather than the observed run. The
  // withheld-rate path was therefore unreachable in practice while the README
  // presented it as a defining property.
  //
  // Ordering constraint: the counters arm at t=0 (`counter.armed(clock.to(0))`
  // below), so the exposure cannot be finalised until the scenario has run. The
  // observed end time is captured here and the real denominators are applied just
  // before the report is built. An explicit armedMs/activeMs still overrides —
  // a caller measuring a real session knows its exposure better than the clock.
  const declaredArmedMs = options.armedMs;
  const declaredActiveMs = options.activeMs;
  const armedMs = declaredArmedMs ?? null;
  const activeMs = declaredActiveMs ?? null;
  counter.armed(clock.to(0));

  // ---------------------------------------------------------------------
  // The session. A scripted scenario with known outcomes, so the report can be
  // checked against ground truth rather than merely printed.
  // ---------------------------------------------------------------------

  /**
   * Advance the session clock, calling `engine.tick()` on every frame.
   *
   * THE CONTRACT THIS ENCODES. ExternalEngine decides whether the host is alive
   * from REAL time: `tick()` stamps `this._lastTickAt = performance.now()`, and
   * if more than HOST_SILENT_MS (250ms) of wall clock passes between ticks it
   * concludes the host went silent and starts advancing the read on its OWN
   * real-time base.
   *
   * So a driver that jumps the virtual clock without ticking — which is what a
   * naive scenario loop does between steps — makes the engine take over and run
   * the read past its own end. Observed: 10 of 40 tokens emitted, and the
   * timing check still passed because it only asserted "some tokens fired".
   * Dense ticking emits all 40.
   *
   * This is the same one-clock class as the ExternalSource defect: the engine
   * needs a heartbeat on ITS notion of liveness, and a host that owns a virtual
   * clock must supply one continuously rather than only while a dwell is
   * running.
   */
  const tickUntil = (targetMs, extra) => {
    while (clock.now() < targetMs) {
      clock.advance(16);
      readEngine.tick(clock.now());
      extra?.();
    }
  };

  const script = options.events ?? defaultScenario(dwellMs, 150);
  const steps = [];

  source.start();
  readEngine.speak([]);

  for (const step of script) {
    // A consent refusal must actually stop the signal, not merely be recorded.
    //
    // Only withdraw when there is a grant to withdraw: `withdraw()` throws for a
    // purpose with no record, which is correct (a host withdrawing something
    // nobody consented to has a bug) but means a gated step must not assume its
    // own precondition when a caller runs the session with consent disabled.
    // The source is stopped either way — "never granted" and "withdrawn" must
    // produce the same observable behaviour, or the gate's meaning depends on
    // which route the user took to refusing.
    if (step.gated) {
      if (consent.record.purposes[PURPOSES.ACQUIRE_SIGNAL.id]) {
        consent.withdraw(PURPOSES.ACQUIRE_SIGNAL.id);
      }
      source.stop();
    } else if (step.regrant) {
      consent.grant(PURPOSES.ACQUIRE_SIGNAL.id, { noticeVersion: noticeVersion() });
      source.start();
    } else if (consent.isGranted(PURPOSES.ACQUIRE_SIGNAL.id)) {
      source.start();
    }

    // Idle gap before this step. HEARTBEATED, not merely advanced.
    //
    // `dwell.hold()` is the engine's heartbeat, and it must keep arriving while
    // the signal is away — not only during a hold. A host that ticks the engine
    // solely while a dwell is in flight leaves `_lastHeartbeatAt` stale, and the
    // FIRST hold of the next step then looks like a multi-second host stall, so
    // the clock-gap guard abandons a dwell that had only just started. The
    // symptom is silent: the step reports `phase: dwell, progress: 0` and never
    // fires. Verified by reproducing w2 with and without the gap heartbeat.
    //
    // This is the third instance of one lesson in this codebase: an engine that
    // tracks liveness needs a continuous heartbeat, and a host driving a virtual
    // clock must supply one on every frame rather than around the events it
    // happens to care about.
    tickUntil(clock.now() + (step.advanceMs ?? 0), () => dwell.hold(clock.now()));

    source.focus(step.target, clock.now());
    const activationsBefore = activations.length;

    // The hold, then the departure. The departure keeps heartbeating so the
    // grace window can expire AND the baseline stays fresh.
    tickUntil(clock.now() + (step.holdMs ?? 0), () => dwell.hold(clock.now()));

    source.focus(null, clock.now());
    tickUntil(clock.now() + (step.gapMs ?? 200), () => { dwell.hold(clock.now()); dwell.tick(clock.now()); });

    // Did THIS step activate? Snapshot before, compare after — the previous
    // version compared the running total against a count of prior steps that
    // fired, which silently reported "no" for any step following a step that
    // also did not fire. That is how the scenario's misfire never reached the
    // measurement: w2 did not fire, so w3's detection was off by one, and the
    // undo intended for w2 was applied to w3 instead.
    const firedThisStep = activations.length > activationsBefore;
    steps.push({
      target: step.target,
      gated: !!step.gated,
      fired: firedThisStep,
      outcome: step.outcome ?? null,
    });

    // Record the activation with the evidence the host observed.
    if (firedThisStep) {
      counter.activation({
        tMs: clock.now(),
        heldMs: step.holdMs,
        witness: step.outcome?.witness,
        undoAtMs: step.outcome?.witness === 'undone' ? clock.now() + (step.outcome.undoAfterMs ?? 100) : undefined,
      });
    }
  }

  source.focus(null, clock.now());
  // Exposure resolution.
  //
  // `disarm(tMs, {activeMs})` does NOT set a duration — it accrues
  // `tMs - _armedSince` onto this.armedMs and adds `activeMs` onto this.activeMs.
  // So passing `clock.now() + window` double-counted: the observed span was added
  // first, then the window on top, yielding 2x the session for an observed run.
  // Both values must therefore be passed as DURATIONS.
  //
  // When the caller declared the exposure, honour the declaration — they are
  // measuring a real session and know its window better than the clock does.
  // Otherwise the session's OBSERVED length is the exposure, so the headline rate
  // is a real rate over a real window and the 15-minute floor can actually fire
  // on a short run (which is what makes the withheld-rate path reachable).
  const observedMs = clock.now();
  // armedMs accrues from the arm point (t=0) to now, so disarming at `now` gives
  // the observed span for free. A declared armed window replaces it by disarming
  // at the declared instant instead.
  const disarmAtMs = armedMs === null ? observedMs : armedMs;
  const finalActiveMs = activeMs === null ? Math.round(observedMs / 2) : activeMs;
  const exposureSource = armedMs === null ? 'observed' : 'declared';
  counter.disarm(disarmAtMs, { activeMs: finalActiveMs });

  // ---------------------------------------------------------------------
  // The report — everything, from one run.
  // ---------------------------------------------------------------------
  const measure = counter.report({ denominator: DENOMINATORS.ARMED });
  const measureActive = counter.report({ denominator: DENOMINATORS.ACTIVE });

  const report = {
    schema: 'access-conformance/1',
    sessionId,
    clock: { endMs: clock.now() },
    timing: {
      engine: 'ExternalEngine',
      words: tokens.length,
      wordsPerMinute: wpm,
      tokensEmitted: tokensSeen.length,
      lastToken: tokensSeen.length ? tokensSeen[tokensSeen.length - 1] : null,
      // The emission ORDER, not just the count. Without it a monotonicity check
      // has nothing to compare and can only assert "something was emitted" —
      // which is what timing.monotonic did before this field existed.
      tokenSequence: tokensSeen.slice(),
      msPerWord,
    },
    input: {
      mode: 'dwell',
      dwellMs,
      activations: activations.length,
      targets: activations.map((a) => a.id),
    },
    consent: {
      granted: consent.granted(),
      epoch: consent.record.consentEpoch,
      chainIntact: consent.record.verifyChain().ok,
      handlingStated: consent.record.handling.stated,
      declaration: consent.declarationText(),
    },
    measurement: {
      armed: measure,
      active: measureActive,
      // Whether the exposure behind the rate was OBSERVED from the run or
      // DECLARED by the caller. A rate over a declared window is not the same
      // artifact as a rate over a measured one, and a reader cannot tell them
      // apart from the numbers alone.
      exposureSource,
      observedMs,
    },
    steps,
    checks: [],
  };

  report.checks = runChecks(report);
  report.ok = report.checks.every((c) => c.status !== 'fail');

  return report;
}

/**
 * The default scenario: a reading session with a known mix of outcomes.
 *
 * Deliberately includes the cases that matter — a clean activation, a misfire
 * undone immediately, an abandoned attempt undone late, a gated attempt that
 * must not fire at all — because a scenario that only produces successes would
 * produce a report that only demonstrates the happy path.
 */
/**
 * Install a no-op requestAnimationFrame when the host environment lacks one.
 *
 * See the note at the call site: ExternalEngine's rAF loop is a liveness
 * re-check, not the mechanism that advances the read, so a shim that never
 * fires cannot lose a token in a host-driven run. Installed only when absent,
 * so a browser host is untouched.
 */
function installRafShim() {
  if (typeof globalThis.requestAnimationFrame === 'function') return false;
  globalThis.requestAnimationFrame = () => 0;
  globalThis.cancelAnimationFrame = () => {};
  return true;
}

function defaultScenario(dwellMs, lockOnMs = 150) {
  /**
   * A hold must clear BOTH gates: lock-on, then the dwell itself.
   *
   * `lockOnMs + dwellMs` is the real requirement, and the first version of this
   * scenario used `dwellMs + delta` — so every step was short by the lock-on and
   * three of the five never fired. The engine was correct; the fixture was wrong,
   * and the symptom was a plausible-looking `phase: dwell, progress: 0` rather
   * than an error. A scenario is test data, and test data that silently fails to
   * exercise its own cases is worth less than no scenario at all.
   */
  const need = lockOnMs + dwellMs;
  return [
    // A clean, intended activation.
    { advanceMs: 0, target: 'w1', holdMs: need + 300, outcome: { witness: 'confirmed' } },
    // A misfire: completed, then undone immediately. NOTE ON DURATION — a
    // dwell CANNOT complete in under `lockOnMs + dwellMs` (750ms here), so a
    // completed dwell misfire is never "brief" in the sense the classifier's
    // spuriousHoldMs threshold means. The duration split discriminates spurious
    // from abandoned for DIRECT sources (where an activation can be short); for
    // dwell it can only produce AMBIGUOUS, and the scenario says so rather than
    // pretending otherwise. See the note in measure.js.
    { advanceMs: 5000, target: 'w2', holdMs: need + 20, outcome: { witness: 'undone', undoAfterMs: 80 } },
    // A long hold the user thought better of — AMBIGUOUS, not false.
    { advanceMs: 5000, target: 'w3', holdMs: need + 600, outcome: { witness: 'undone', undoAfterMs: 120 } },
    // Gated: consent withdrawn, so this must not fire at all.
    { advanceMs: 5000, target: 'w4', holdMs: need + 300, gated: true },
    // Consent re-granted and acquisition deliberately resumed, then a clean
    // activation with no witness — credited by duration.
    { advanceMs: 5000, target: 'w5', holdMs: need + 800, regrant: true },
  ];
}
