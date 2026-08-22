// Hybrid Logical Clock. Every event carries an HLC so all replicas order events
// identically (causal order + deterministic tie-break), independent of arrival
// order or wall-clock skew. The wall component is for ordering ONLY — never money.
//
// HLC = { wall, ctr, dev }
//   wall — max observed wall-clock ms (monotonic, never goes backwards)
//   ctr  — same-millisecond counter to order events within one ms
//   dev  — authoring device id; the final, globally-unique tie-break

/** @typedef {{ wall:number, ctr:number, dev:string }} HLC */

/**
 * A per-device clock. Call `send()` when authoring a local event, `receive(h)`
 * when ingesting a remote event, to keep this device's clock ahead of causes.
 */
export class Clock {
  /** @param {string} dev device id  @param {() => number} now ms source (injectable for tests) */
  constructor(dev, now = () => Date.now()) {
    this.dev = dev;
    this.now = now;
    this.wall = 0;
    this.ctr = 0;
  }

  /** Stamp a new local event. */
  send() {
    const t = this.now();
    if (t > this.wall) {
      this.wall = t;
      this.ctr = 0;
    } else {
      this.ctr += 1; // clock hasn't advanced (or went back) — bump the counter
    }
    return { wall: this.wall, ctr: this.ctr, dev: this.dev };
  }

  /**
   * Prime from an existing log at boot/join so the next `send()` sorts AFTER
   * every event already held — without the per-event `+1` bump `receive()`
   * applies (which would inflate ctr across a whole log). Observe-only: take the
   * max (wall, ctr). Call once after loading the persisted log, and on join.
   * @param {Array<{hlc?:HLC}>} log
   */
  primeFrom(log) {
    for (const e of log || []) {
      const h = e && e.hlc;
      if (!h) continue;
      if (h.wall > this.wall) { this.wall = h.wall; this.ctr = h.ctr; }
      else if (h.wall === this.wall && h.ctr > this.ctr) { this.ctr = h.ctr; }
    }
    return this;
  }

  /** Merge a received event's HLC into this clock before authoring anything after it. */
  receive(remote) {
    const t = this.now();
    const wall = Math.max(t, this.wall, remote.wall);
    if (wall === this.wall && wall === remote.wall) {
      this.ctr = Math.max(this.ctr, remote.ctr) + 1;
    } else if (wall === this.wall) {
      this.ctr += 1;
    } else if (wall === remote.wall) {
      this.ctr = remote.ctr + 1;
    } else {
      this.ctr = 0;
    }
    this.wall = wall;
    return { wall: this.wall, ctr: this.ctr, dev: this.dev };
  }
}

/**
 * Total order over HLCs: wall, then ctr, then dev (lexicographic). Deterministic
 * on every replica. Returns <0, 0, or >0.
 * @param {HLC} a @param {HLC} b
 */
export function compareHlc(a, b) {
  if (a.wall !== b.wall) return a.wall - b.wall;
  if (a.ctr !== b.ctr) return a.ctr - b.ctr;
  return a.dev < b.dev ? -1 : a.dev > b.dev ? 1 : 0;
}
