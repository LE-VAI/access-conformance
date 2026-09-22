#!/usr/bin/env node
/**
 * cli.js — run a conformance session and print the report.
 *
 * `npx access-conformance` should print something a person can read, and
 * `--json` should print something a machine can. The human output leads with
 * the number and its denominator, because that is the thing the run exists to
 * produce — not a wall of check ids.
 *
 * Exit code is 0 when no check failed, 1 otherwise, so it can gate CI: a
 * device whose gate does not hold, or whose chain does not verify, should stop
 * a pipeline rather than appear in a passing log.
 */

import { runSession } from './runner.js';

const args = process.argv.slice(2);
const asJson = args.includes('--json');
const quiet = args.includes('--quiet');

function num(v, fallback) {
  const i = args.findIndex((a) => a === `--${v}`);
  if (i === -1) return fallback;
  const parsed = Number(args[i + 1]);
  return Number.isFinite(parsed) ? parsed : fallback;
}

const report = runSession({
  sessionId: args.find((a) => a.startsWith('--session='))?.split('=')[1] ?? 'cli',
  dwellMs: num('dwell-ms', 600),
  wordCount: num('words', 40),
  wordsPerMinute: num('wpm', 180),
  activeMs: num('active-ms', 900000),
  intentionalHoldMs: num('intentional-hold-ms', 400),
});

if (asJson) {
  process.stdout.write(JSON.stringify(report, null, 2) + '\n');
  process.exit(report.ok ? 0 : 1);
}

const { measurement, timing, input, consent } = report;
const m = measurement.armed;

const rule = (s) => s.repeat(66);

if (!quiet) {
  console.log(`access-conformance — session "${report.sessionId}"`);
  console.log(rule('─'));
  console.log(`timing      ${timing.tokensEmitted} token(s) over ${timing.words} word(s)` +
              ` @ ${timing.wordsPerMinute} wpm, engine ${timing.engine}`);
  console.log(`input       ${input.activations} activation(s), mode ${input.mode},` +
              ` dwell ${input.dwellMs}ms`);
  console.log(`consent     epoch ${consent.epoch}, chain ${consent.chainIntact ? 'intact' : 'BROKEN'},` +
              ` handling ${consent.handlingStated ? 'declared' : 'UNSTATED'}`);
  console.log();
}

// The number and its denominator, together and first.
if (m.rateWithheld) {
  // Refuse to print a per-hour figure rather than extrapolating one from a
  // session too short to mean anything. The counts still print — the
  // observations happened — but the RATE is not claimed.
  console.log('false activations   WITHHELD — exposure too short for a per-hour rate');
  console.log(`  exposure          ${m.denominatorHours}h (floor is ${(m.minExposureMs / 3600000).toFixed(2)}h).`);
  console.log('                    A rate extrapolated from a short session is not a');
  console.log('                    measurement, and printing one in the same units as a');
  console.log('                    real one invites a reader to compare an untested');
  console.log('                    device against a tested one.');
  console.log('                    Pass --active-ms / a longer session to earn a rate.');
} else {
  console.log(`false activations   ${m.falsePerHour} / armed hour`);
  console.log(`  denominator       ${m.denominatorHours}h armed` +
              (measurement.active.denominatorHours
                ? ` · ${measurement.active.denominatorHours}h active (${measurement.active.falsePerHour}/h)`
                : ''));
}

const c = m.counts;
console.log(`  outcomes          ${c.total} total — ${c.true} true · ${c.ambiguous} ambiguous · ${c.false} false`);
if (c.ambiguous > 0) {
  console.log(`  NOTE              ${c.ambiguous} ambiguous activation(s) are reported ON THEIR OWN LINE.`);
  console.log('                    An ambiguous activation is either a false activation or an');
  console.log('                    abandoned attempt, and the signal alone does not say which.');
  console.log('                    Folding it into either column would corrupt the rate.');
}
if (!m.witnessed) {
  console.log('  WARNING           no independent witness backed these verdicts, so the rate');
  console.log(`                    measures intentionalHoldMs (${m.parameters.intentionalHoldMs}ms)`);
  console.log('                    as much as the device.');
}
console.log();

if (!quiet) {
  console.log('checks');
  for (const chk of report.checks) {
    const mark = chk.status === 'pass' ? 'ok  ' : chk.status === 'fail' ? 'FAIL' : chk.status === 'warn' ? 'warn' : 'n/a ';
    console.log(`  ${mark} ${chk.id}`);
    if (chk.status !== 'pass' || args.includes('--verbose')) {
      console.log(`        ${chk.detail}`);
    }
  }
  console.log();
}

const failed = report.checks.filter((x) => x.status === 'fail');
console.log(report.ok
  ? `RESULT  no check failed (${report.checks.length} checks)`
  : `RESULT  ${failed.length} CHECK(S) FAILED: ${failed.map((f) => f.id).join(', ')}`);

process.exit(report.ok ? 0 : 1);
