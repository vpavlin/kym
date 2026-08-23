// RBSR reconciliation — now SOURCED FROM loam-sync (single source), not a kym copy.
// loam-sync's reconcile/toItems/fingerprintIds are byte-identical to kym's originals
// (loam-sync's reconciler was in fact lifted from kym's), verified equal over 2000
// random trials + the fingerprint anchor 03e804547dd32e9b71f0d2c78a1279a6.
export { reconcile, toItems, fingerprintIds } from "loam-sync";

/** Convenience (app helper): the events A must receive from B so both converge (union). */
export function eventsToSend(fromEvents, needIds) {
  const need = new Set(needIds);
  return fromEvents.filter((e) => need.has(e.id));
}
