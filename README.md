# access-conformance

**One runnable instrument across an assistive-input stack.** Drives the timing
layer, the input layer and the consent layer in a single instrumented session,
then emits a measurement report with conformance checks over it.

```bash
npx access-conformance          # a session, and its report
npx access-conformance --json   # the same, machine-readable
```

---

## What this is for

Three packages built to compose are worth less than **one run that shows them
composing.** Timing, input and consent were built as separate layers with
separate READMEs, and the thing they form together — an assistive session where
a misfire rate falls out of the run, under a consent gate, with the read position
measured — was invisible to anyone outside the project.

This is that thing. It is also the only artifact here a stranger can **cite**: a
lab can run it, a clinician can be trained on it, a reader can audit the report.

## What it measures

The number, first, because that is what the run is for (this is real output):

```
$ npx access-conformance                      # observed exposure
false activations   WITHHELD — exposure too short for a per-hour rate
  exposure          0.007h (floor is 0.25h).

$ npx access-conformance --active-ms 900000   # declared exposure
false activations   0 / armed hour
  denominator       0.5h armed · 0.25h active (0/h)
  exposure source   DECLARED by the caller, not measured from the run.
                    Actual session length: 26.9s.
                    The rate above is extrapolated 67.0x from that run,
                    so it describes the declared window, not this session.
  outcomes          4 total — 2 true · 2 ambiguous · 0 false
  NOTE              2 ambiguous activation(s) are reported ON THEIR OWN LINE.
```

**Exposure is reported with its provenance.** Every report states whether the
denominator was `observed` from the run or `declared` by the caller, and the CLI
prints the extrapolation factor when a declared window is much longer than the
session that produced it. A rate over an assumed window is not the same artifact
as a rate over a measured one, and the numbers alone cannot tell them apart.

Note what the output does and does not say. A dwell session **cannot** produce a
`false` outcome — a completed dwell cannot fire in under `lockOnMs + dwellMs`, so
every undone dwell classifies as *ambiguous* (see below). So `0 false` is a
property of the access method, not evidence of a flawless device.

**An absent or too-short exposure reports `null`, never `0`.** A rate of 0 reads
as "no misfires"; the truth is "no measurement". A device nobody measured must
not look like a perfect one — so below a 15-minute floor the rate is withheld
and the CLI says why rather than printing a number.

**The ambiguous middle is reported separately, never folded in.** An activation
that crossed threshold with nothing confirming intent is either a false
activation or an abandoned attempt, and the signal alone does not say which.
Counting an abandoned attempt as a device misfire makes the rate track the
user's decision-making instead of the hardware.

**`witnessed` says whether any independent evidence backed the verdicts.** False
means every classification came from a threshold we chose, so the rate measures
that parameter as much as the device. The CLI warns when it is false.

## What it checks

Eleven conformance checks, each written against a **reachable** failure — every
one corresponds to a defect this stack actually shipped or nearly shipped. The
comments say which. A few:

| Check | The defect it exists to catch |
|---|---|
| `measure.ratio-sound` | A rate of 0 with no exposure reads as a perfect device |
| `input.gate-holds` | A consent layer that records a decision but does not prevent processing |
| `consent.handling-declared` | A library asserting what its *host* does with a signal |
| `timing.one-clock` | The two-timebase defect that made a test fail 4 of 12 runs under load |
| `measure.witnessed-disclosed` | Presenting a parameterised guess as a measurement |

Exit code is 0 when no check failed, 1 otherwise — so it gates CI rather than
appearing in a passing log.

## The honest boundary

`read-along`'s main entry defines a custom element at module top level and
throws in Node — verified, not assumed. So this run drives the **`ExternalEngine`**,
which is precisely the engine a BCI/AT layer uses: a host process supplies word
timings and ticks a clock. That is not a workaround; it is the integration path
being exercised. The DOM component and its screen-reader behaviour are covered
by `read-along`'s own suite and its NVDA verification.

`requestAnimationFrame` is shimmed to a no-op in Node. That is correct rather
than convenient: `ExternalEngine`'s rAF loop is a liveness re-check — when the
host is ticking it calls `_advance(this._clock)`, the same value `tick()` already
delivered — so it is not the mechanism that advances the read. The
`timing.one-clock` check proves the read advanced instead of assuming it.

## Three things this run taught the stack

Each of these was found by building it, and each was a real defect rather than a
scenario quirk:

1. **`read-along`'s `tokenizer.js` shipped but could not be imported** — not in
   the `exports` map, while the README called it a host contract and its sibling
   `timings.js` *was* exported. Fixed in 0.2.2.
2. **`wordTimingsFromChunk` promised engine manifests and returned the wrong
   shape** — objects, while both engines require tuples. A host following the
   docstring crashed. Fixed in 0.2.3, with the first test to cross that seam.
3. **A completed dwell can never be "brief"** — it cannot fire in under
   `lockOnMs + dwellMs`, so every undone dwell is *ambiguous*, never *false*.
   That is correct, not a limitation: a dwell that fired means the user rested
   on a target for 750ms, which is real evidence of intent that a sub-threshold
   twitch does not carry. Recorded in `measure.js` so it is not re-filed as a bug.

## Usage

```js
import { runSession, runChecks } from 'access-conformance';

const report = runSession({ sessionId: 'day-1', dwellMs: 600, wordsPerMinute: 180 });
console.log(report.measurement.armed.falsePerHour);
console.log(report.checks.filter((c) => c.status !== 'pass'));
```

Script your own session rather than the default scenario:

```js
runSession({
  events: [
    { advanceMs: 0,    target: 'a', holdMs: 1400, outcome: { witness: 'confirmed' } },
    { advanceMs: 5000, target: 'b', holdMs: 780,  outcome: { witness: 'undone', undoAfterMs: 80 } },
  ],
});
```

CLI flags: `--json`, `--quiet`, `--verbose`, `--session=NAME`, `--dwell-ms=N`,
`--words=N`, `--wpm=N`, `--armed-ms=N`, `--active-ms=N`, `--intentional-hold-ms=N`.

Omit `--armed-ms`/`--active-ms` to measure the observed session (recommended for
real use). Passing `--active-ms` declares the exposure pair — the armed window
defaults to twice the active one, the historical ratio — and the report will say
so, along with how far the printed rate extrapolates from the actual run.

## What this is not

Not a validated instrument. The metric it computes is **specified, not
established**. The parameters are engineering values, stated and echoed in every
report.

**The gap this addresses, stated precisely.** There is no standardised per-hour or
per-session false-activation benchmark for assistive switch access — not for single
switches, not for sip-and-puff, not for EMG switches, not for head pointers, not
for eye gaze. Per-*trial* measurement is established and reusable (SITbench computes
FPR = FP/(FP+TN) per trial; Koester's rule of thumb revises scanning at >25% error),
and per-hour false-positive rates are conventional in adjacent fields such as fall
detection. What is absent is a rate over *time* for switch access, and the field has
named the problem without closing it (Eddy et al. list false activation as one of
five unresolved categories in EMG-based HCI).

Say it that precisely, because the looser version — "no benchmark exists anywhere" —
is false. The full literature review, including the searches that returned nothing
(which is the evidence) and the corrections applied to this project's own earlier
citations, is in `access-input`'s `docs/MEASUREMENT-PROTOCOL.md` §6.

The 15-minute exposure floor before a rate is reported is modelled on recognized
statistical-unreliability suppression (NCHS suppresses rates under 20 events; SEER
under 10). Note that those conventions threshold on **event count**, not elapsed
time — an event-count floor would be both more defensible and more citable than the
duration floor used here.

Not a conformance authority. Automated checks cannot establish conformance: W3C WAI
states that "no tool alone can determine if a site meets accessibility standards,"
and established tools in the CI-gating role (axe-core, Pa11y, Lighthouse CI) define
pass/fail without claiming it. This package inherits the name; it does not inherit
the authority. A CI log from this tool says *these 11 properties held in this
session* — not that anything conforms. The regulatory shape to avoid is documented:
the FTC's January 2025 action required a vendor to pay $1M for advertising
automated checks as compliance.

The method is in `access-input`'s `docs/MEASUREMENT-PROTOCOL.md` — 395 lines
covering the four metrics and their units, the mandatory three-outcome split, the
four measurement conditions (including a fatigue repeat), the labelling procedure,
and an explicit "what this protocol cannot do" section. It is a protocol, not a
study: nobody has run it yet.

## License

MIT. Zero dependencies beyond the three sibling packages.
