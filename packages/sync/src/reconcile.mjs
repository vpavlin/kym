// Range-Based Set Reconciliation for the KYM event log — the bandwidth-efficient
// replacement for "resend the whole log" backfill (see docs/research-reliability.md,
// ADR #17). Two peers exchange small *fingerprints* over sorted ranges of their
// event-id set, recursively splitting only where the fingerprints disagree, until
// each side learns the EXACT set of event-ids it's missing. Only those events are
// then transferred — instead of the whole log.
//
// This is the algorithm layer only: pure functions of two event sets, testable
// without any transport (the wire envelopes + session state machine that carry
// these messages over Delivery are a separate, later step — they ride the same
// send()/messageReceived() the current SYNC_REQ already uses). Algorithm-aligned
// with Negentropy / RBSR (the approach Waku itself chose); NOT yet NIP-77
// wire-compatible — that's future work.
import { sha256 } from "@noble/hashes/sha2.js";

const enc = new TextEncoder();

// Reconciliation key: events are ordered by (hlc.wall, id) — exactly the
// (timestamp, id) tuple RBSR orders on. id (a UUID) breaks wall-clock ties, so the
// order is total and identical on every device.
function keyCmp(a, b) {
  if (a.wall !== b.wall) return a.wall - b.wall;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** Sort events into the canonical reconciliation order. */
export function toItems(events) {
  return events.map((e) => ({ wall: e.hlc.wall, id: e.id })).sort(keyCmp);
}

// Order-independent fingerprint of a set of ids: XOR of each id's SHA-256 (so
// order never matters), folded with the count. 16 bytes, hex-encoded. Two peers
// holding the same id-set in a range always produce the same fingerprint.
function fingerprint(items) {
  const acc = new Uint8Array(32);
  for (const it of items) {
    const h = sha256(enc.encode(it.id));
    for (let i = 0; i < 32; i++) acc[i] ^= h[i];
  }
  const countBuf = new Uint8Array(4);
  new DataView(countBuf.buffer).setUint32(0, items.length);
  const fp = sha256(new Uint8Array([...acc, ...countBuf])).slice(0, 16);
  return Buffer.from(fp).toString("hex");
}

// Items whose key falls in [lo, hi) — half-open bounds are {wall, id} tuples, or
// null for ±infinity. Both peers apply the SAME bounds, so every item lands in
// exactly one bucket on each side (bucket membership is transport-independent).
function inRange(items, lo, hi) {
  return items.filter((it) => {
    if (lo && keyCmp(it, lo) < 0) return false;
    if (hi && keyCmp(it, hi) >= 0) return false;
    return true;
  });
}

/**
 * Reconcile two event sets. Returns the EXACT symmetric difference plus the
 * control-plane cost, without moving any event payloads:
 *   { aNeeds:[id], bNeeds:[id], rounds, comparisons, controlBytes }
 * aNeeds = ids A lacks (B has); bNeeds = ids B lacks (A has). A caller then
 * transfers only those events. `controlBytes` is the fingerprint/id-list overhead
 * exchanged (the metric to compare against resend-all's full-log bytes).
 *
 * @param threshold ranges with ≤ this many items on the larger side send an id
 *   list directly (the base case); larger ranges split into `buckets` sub-ranges.
 */
export function reconcile(eventsA, eventsB, { threshold = 8, buckets = 16 } = {}) {
  const A = toItems(eventsA);
  const B = toItems(eventsB);
  const aNeeds = new Set();
  const bNeeds = new Set();
  let rounds = 0;
  let comparisons = 0;
  let controlBytes = 0;

  // A "frame" is a range still being reconciled. We process breadth-first so
  // `rounds` reflects the recursion depth (≈ the number of network round trips).
  let frontier = [{ lo: null, hi: null }];
  while (frontier.length) {
    rounds++;
    const next = [];
    for (const { lo, hi } of frontier) {
      const ia = inRange(A, lo, hi);
      const ib = inRange(B, lo, hi);
      comparisons++;
      controlBytes += 16 * 2; // both sides put a 16-byte fingerprint on the wire
      if (fingerprint(ia) === fingerprint(ib)) continue; // range agrees → done

      const larger = ia.length >= ib.length ? ia : ib;
      if (larger.length <= threshold) {
        // Base case: exchange id lists; each side keeps what the other lacks.
        const aSet = new Set(ia.map((x) => x.id));
        const bSet = new Set(ib.map((x) => x.id));
        for (const x of ib) if (!aSet.has(x.id)) aNeeds.add(x.id);
        for (const x of ia) if (!bSet.has(x.id)) bNeeds.add(x.id);
        controlBytes += (ia.length + ib.length) * 36; // ~36 bytes per uuid on the wire
        continue;
      }
      // Split [lo,hi) into `buckets` sub-ranges by the larger side's item keys.
      // Bounds are keys (not indices), so both sides re-bucket identically.
      const step = Math.ceil(larger.length / buckets);
      let subLo = lo;
      for (let i = 0; i < larger.length; i += step) {
        const nextItem = larger[i + step];
        const subHi = nextItem ? { wall: nextItem.wall, id: nextItem.id } : hi;
        next.push({ lo: subLo, hi: subHi });
        subLo = subHi;
      }
    }
    frontier = next;
  }
  return { aNeeds: [...aNeeds], bNeeds: [...bNeeds], rounds, comparisons, controlBytes };
}

/** Convenience: the events A must receive from B so both converge (union). */
export function eventsToSend(fromEvents, needIds) {
  const need = new Set(needIds);
  return fromEvents.filter((e) => need.has(e.id));
}

/** The range fingerprint of a set of event ids — exposed so the C++ mirror
 *  (module/src/kym_reconcile_std.hpp) can be parity-checked byte-for-byte. */
export function fingerprintIds(ids) {
  return fingerprint(ids.map((id) => ({ id })));
}
