// Hybrid Logical Clock — now SOURCED FROM loam-sync (single source of truth), not a
// kym copy. loam-sync's Clock is a superset: an injectable time source (ctor, default
// Date.now) makes send() argless-capable, and primeFrom(log) seeds from the persisted
// log on boot — so kym's existing call sites (new Clock(dev[, now]), c.send(),
// clock.primeFrom(log), clock.receive(hlc)) work unchanged. receive() is observe-only;
// send() owns the counter bump (ADR 0013 data-loss safety is preserved via the bump).
export { Clock, compareHlc } from "loam-sync";

/** @typedef {{ wall:number, ctr:number, dev:string }} HLC */
