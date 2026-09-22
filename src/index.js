/**
 * access-conformance — one runnable instrument across the assistive-input stack.
 *
 * Drives the timing layer (read-along), the input layer (access-input) and the
 * consent layer (neural-consent) in a single instrumented session, then emits a
 * measurement report with conformance checks over it.
 *
 * The composition is the artifact. Three packages built to compose are worth
 * less than one run that shows them composing — see README.
 */

export { runSession, SessionClock } from './runner.js';
export { runChecks } from './checks.js';
