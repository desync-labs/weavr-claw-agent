/**
 * The Prometheus text exposition format, written out here.
 *
 * A client library is a supply chain and this format is one page of code, so
 * it lives here for the same reason the router does (server.js §1). Node
 * runtime numbers are deliberately absent: cAdvisor and kube-state-metrics
 * already answer "how much CPU, how much memory, how many restarts" for the
 * pod, and a second answer that disagrees with theirs is worse than one.
 */

/**
 * A metric that grows a series per label value is how a scrape target takes
 * Prometheus down, and every label in metrics.js is bounded by construction —
 * route templates, a fixed tool list, registered partner names. This cap is
 * here for the label a later change adds without noticing, so the failure is
 * a missing series rather than an OOM on the monitoring side.
 */
export const MAX_SERIES = 2000;

export const CONTENT_TYPE = 'text/plain; version=0.0.4; charset=utf-8';

/** Label values are arbitrary text; the format asks for exactly these three. */
const escape = (value) => String(value)
  .replace(/\\/g, '\\\\')
  .replace(/"/g, '\\"')
  .replace(/\n/g, '\\n');

/** JSON quoting makes the joined values injective: two label sets cannot share a key. */
const keyOf = (names, labels) => JSON.stringify(names.map((name) => String(labels[name] ?? '')));

function renderLabels(names, values, extra) {
  const pairs = names.map((name, index) => `${name}="${escape(values[index])}"`);
  if (extra) pairs.push(extra);
  return pairs.length ? `{${pairs.join(',')}}` : '';
}

class Metric {
  constructor({ name, help, labelNames = [] }) {
    this.name = name;
    this.help = help;
    this.labelNames = labelNames;
    this.series = new Map();
    this.dropped = 0;
  }

  /** The series for these labels, created on first write, or null at the cap. */
  at(labels, create) {
    const key = keyOf(this.labelNames, labels);
    const found = this.series.get(key);
    if (found) return found;
    if (this.series.size >= MAX_SERIES) {
      this.dropped += 1;
      return null;
    }
    const fresh = { values: this.labelNames.map((name) => String(labels[name] ?? '')), ...create() };
    this.series.set(key, fresh);
    return fresh;
  }

  *header(type) {
    yield `# HELP ${this.name} ${this.help}`;
    yield `# TYPE ${this.name} ${type}`;
  }

  /**
   * Clears the series a refresh is about to rewrite. `dropped` survives on
   * purpose: it is reported as a counter, and the gauges that reset themselves
   * every cycle would otherwise drive it back to zero on each pass.
   */
  reset() {
    this.series.clear();
  }
}

export class Counter extends Metric {
  inc(labels = {}, by = 1) {
    const series = this.at(labels, () => ({ value: 0 }));
    if (series) series.value += by;
  }

  *render() {
    yield* this.header('counter');
    for (const { values, value } of this.series.values()) {
      yield `${this.name}${renderLabels(this.labelNames, values)} ${value}`;
    }
  }
}

export class Gauge extends Metric {
  set(labels = {}, value) {
    const series = this.at(labels, () => ({ value: 0 }));
    if (series) series.value = value;
  }

  inc(labels = {}, by = 1) {
    const series = this.at(labels, () => ({ value: 0 }));
    if (series) series.value += by;
  }

  dec(labels = {}, by = 1) {
    this.inc(labels, -by);
  }

  *render() {
    yield* this.header('gauge');
    for (const { values, value } of this.series.values()) {
      yield `${this.name}${renderLabels(this.labelNames, values)} ${value}`;
    }
  }
}

export class Histogram extends Metric {
  constructor({ buckets, ...rest }) {
    super(rest);
    this.buckets = [...buckets].sort((a, b) => a - b);
  }

  /**
   * Every bucket at or above the observation is incremented, so the stored
   * counts are already the cumulative ones the format wants.
   */
  observe(labels = {}, value) {
    const series = this.at(labels, () => ({
      counts: new Array(this.buckets.length).fill(0),
      sum: 0,
      count: 0,
    }));
    if (!series) return;
    series.sum += value;
    series.count += 1;
    for (let index = 0; index < this.buckets.length; index += 1) {
      if (value <= this.buckets[index]) series.counts[index] += 1;
    }
  }

  *render() {
    yield* this.header('histogram');
    for (const { values, counts, sum, count } of this.series.values()) {
      for (let index = 0; index < this.buckets.length; index += 1) {
        yield `${this.name}_bucket${renderLabels(this.labelNames, values, `le="${this.buckets[index]}"`)} ${counts[index]}`;
      }
      yield `${this.name}_bucket${renderLabels(this.labelNames, values, 'le="+Inf"')} ${count}`;
      yield `${this.name}_sum${renderLabels(this.labelNames, values)} ${sum}`;
      yield `${this.name}_count${renderLabels(this.labelNames, values)} ${count}`;
    }
  }
}

export class Registry {
  constructor({ droppedName = 'metrics_series_dropped_total' } = {}) {
    this.metrics = [];
    this.droppedName = droppedName;
  }

  register(metric) {
    this.metrics.push(metric);
    return metric;
  }

  reset() {
    for (const metric of this.metrics) metric.reset();
  }

  render() {
    const lines = [];
    let dropped = 0;
    for (const metric of this.metrics) {
      lines.push(...metric.render());
      dropped += metric.dropped;
    }
    // Self-reported, because a series lost to the cap is invisible otherwise.
    lines.push(`# HELP ${this.droppedName} Writes refused because a metric was already at the series cap.`);
    lines.push(`# TYPE ${this.droppedName} counter`);
    lines.push(`${this.droppedName} ${dropped}`);
    return `${lines.join('\n')}\n`;
  }
}
