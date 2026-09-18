/**
 * The metrics every service shares: one registry, the listener that serves it,
 * and the loop trio.
 *
 * This lives in `chain` because all four services already depend on it and
 * none depends on `api`. The registry is a single module-level default rather
 * than one per service: a process is scraped as a whole, and chain-level
 * instrumentation (the RPC wrapper in chain.js) has to reach the same registry
 * as the service's own metrics without being handed one.
 *
 * Imported through the `@composable-portfolios/chain/metrics` subpath rather
 * than the package barrel, because `counter`, `gauge` and `histogram` are
 * names a barrel has no business claiming.
 */
import { createServer } from 'node:http';
import { CONTENT_TYPE, Counter, Gauge, Histogram, Registry } from './prometheus.js';

export { CONTENT_TYPE, Counter, Gauge, Histogram, Registry } from './prometheus.js';

export const registry = new Registry({ droppedName: 'weavr_metrics_series_dropped_total' });

export const counter = (name, help, labelNames = []) =>
  registry.register(new Counter({ name, help, labelNames }));
export const gauge = (name, help, labelNames = []) =>
  registry.register(new Gauge({ name, help, labelNames }));
export const histogram = (name, help, labelNames, buckets) =>
  registry.register(new Histogram({ name, help, labelNames, buckets }));

/** Sub-second to half a minute: request-shaped work. */
export const LATENCY_BUCKETS = [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30];

/**
 * Seconds to ten minutes: loop-shaped work. A keeper tick sends one
 * transaction per action serially, so the tail is minutes, not seconds.
 */
export const LOOP_BUCKETS = [1, 5, 10, 30, 60, 120, 300, 600];

/**
 * Every long-running loop in this system answers the same three questions, so
 * they are one set of metrics with a `loop` label rather than a bespoke trio
 * per service. `loop` is a closed set: the loops are named in code, and there
 * are eight of them.
 */
export const loopLastSuccess = gauge(
  'weavr_loop_last_success_timestamp_seconds',
  'When a loop last completed an iteration without throwing.',
  ['loop'],
);
export const loopDuration = histogram(
  'weavr_loop_duration_seconds',
  'How long one iteration of a loop took; the count also gives its rate and failure share.',
  ['loop', 'outcome'],
  LOOP_BUCKETS,
);
export const loopBackoff = gauge(
  'weavr_loop_backoff_seconds',
  'The retry delay a loop is currently using; above its configured interval means it is in a failure streak.',
  ['loop'],
);

/**
 * One iteration, recorded. Heartbeat freshness cannot answer "is it stuck":
 * the services write a heartbeat on the failure path too, and the cloud
 * forwarder in deploy/start.mjs overwrites `at` with the time it forwarded,
 * so the age never grows while the supervisor is alive. A flat line here,
 * with a live scrape target, is the only honest answer.
 */
export function observeLoop(loop, { startedMs, ok, backoffSecs, now = Date.now }) {
  const at = now();
  loopDuration.observe({ loop, outcome: ok ? 'ok' : 'failed' }, Math.max(0, (at - startedMs) / 1000));
  if (ok) loopLastSuccess.set({ loop }, at / 1000);
  if (Number.isFinite(backoffSecs)) loopBackoff.set({ loop }, backoffSecs);
}

export const rpcRequests = counter(
  'weavr_rpc_requests_total',
  'Chain RPC calls, after the retry wrapper has finished with them.',
  ['method', 'outcome'],
);
export const rpcDuration = histogram(
  'weavr_rpc_request_duration_seconds',
  'Time for a chain RPC call including any retries it needed.',
  ['method'],
  LATENCY_BUCKETS,
);

/**
 * Wraps one RPC call. `method` is closed by the WRAPPED_RPC list in chain.js.
 * The timing spans the whole retry sequence rather than a single attempt —
 * which is the number that matters to a caller, and is why a throttled
 * provider shows up here as latency rather than as failures.
 */
export async function observeRpc(method, run, { now = Date.now } = {}) {
  const started = now();
  try {
    const answer = await run();
    rpcRequests.inc({ method, outcome: 'ok' });
    return answer;
  } catch (error) {
    rpcRequests.inc({ method, outcome: /429|Too Many Requests/i.test(error?.message ?? '') ? 'busy' : 'failed' });
    throw error;
  } finally {
    rpcDuration.observe({ method }, Math.max(0, (now() - started) / 1000));
  }
}

/** The scrape target. Only `GET /metrics`; everything else is a 404. */
export function createMetricsServer({ register = registry } = {}) {
  return createServer((request, response) => {
    const path = (request.url ?? '').split('?')[0];
    if (request.method !== 'GET' || path !== '/metrics') {
      response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      return response.end('try GET /metrics\n');
    }
    response.writeHead(200, { 'content-type': CONTENT_TYPE });
    response.end(register.render());
  });
}

/**
 * Start the listener unless `METRICS_PORT` is 0. Returns a stop function, so a
 * service's teardown does not have to care whether one was started.
 */
export function startMetricsServer({
  port = Number(process.env.METRICS_PORT ?? 9090),
  label = 'metrics',
  // Named so the message points at the variable the operator actually set;
  // a process with two listeners does not read them from the same one.
  envName = 'METRICS_PORT',
} = {}) {
  if (port === 0) return () => {};
  // `listen` validates the port SYNCHRONOUSLY and throws ERR_SOCKET_BAD_PORT
  // for a non-integer or out-of-range one, which the error handler below never
  // sees. A typo there must not be the thing that stops a service.
  if (!Number.isInteger(port) || port < 0 || port >= 65536) {
    console.error(`${label} not listening: ${envName}=${process.env[envName]} is not a usable port`);
    return () => {};
  }
  const server = createMetricsServer();
  // A bind failure arrives as an event, not a rejection, so without this the
  // process dies of an uncaught EADDRINUSE. Losing the scrape target is bad;
  // losing the keeper because something else held the port is far worse — and
  // under the supervisor a persistent conflict would be a respawn loop. The
  // oracle runs two processes from one image, so this is not hypothetical.
  server.on('error', (error) => {
    console.error(`${label} not listening on :${port}: ${error.message}`);
  });
  server.listen(port, () => console.log(`${label} listening on :${port}/metrics`));
  return () => server.close();
}
