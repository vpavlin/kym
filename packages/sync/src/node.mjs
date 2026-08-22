// SyncNode — a household peer, independent of the physical transport. It owns
// the event log, seals locally-authored events for publishing, and ingests
// peers' sealed events (decrypt → dedup → merge). A transport adapter
// (delivery_module in the module, liblogosdelivery on mobile) just calls
// .seal()/.ingest() and moves bytes; all the safety lives here + in @kym/engine.
import { mergeEvents, computeState, checkInvariant } from "@kym/engine";
import { Clock } from "@kym/contract";
import { deriveIdentity, topicFor, seal, open } from "./crypto.mjs";
import { encodeEvent, decodeEvent } from "./wire.mjs";

export class SyncNode {
  constructor(secret, { device = "node", log = [] } = {}) {
    this.id = deriveIdentity(secret);
    this.topic = topicFor(this.id);          // the household content topic to sub/pub on
    this.log = mergeEvents(log);
    this.clock = new Clock(device);
    for (const e of this.log) this.clock.receive(e.hlc);
    this._ids = new Set(this.log.map((e) => e.id));
  }

  state(opts) { return computeState(this.log, opts); }
  invariant(opts) { return checkInvariant(this.state(opts)); }

  /** Add a locally-authored event and return its sealed wire message to publish. */
  append(event) {
    if (!this._ids.has(event.id)) {
      this.log = mergeEvents([...this.log, event]);
      this._ids.add(event.id);
    }
    return seal(this.id, event.id, encodeEvent(event), this.topic);
  }

  /** Ingest one sealed message from the transport. Returns true if it was new.
   *  Throws if the message can't be opened (wrong household key / tampered). */
  ingest(sealed) {
    const event = decodeEvent(open(this.id, sealed, this.topic));
    if (this._ids.has(event.id)) return false;   // idempotent — Waku Store will redeliver
    this.log = mergeEvents([...this.log, event]);
    this._ids.add(event.id);
    this.clock.receive(event.hlc);
    return true;
  }

  /** Re-seal the whole log — module-side backfill for a peer that just joined
   *  (liblogosdelivery exposes no Store; the desktop hub re-serves on demand). */
  backfill() {
    return this.log.map((e) => seal(this.id, e.id, encodeEvent(e), this.topic));
  }
}
