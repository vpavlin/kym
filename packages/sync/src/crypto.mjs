// KYM household crypto — now a thin wrapper over the shared loam-sync seal (ADR 0010/0011).
// Domain="kym" reproduces the exact legacy key schedule (K/Ke/topic byte-identical), and the
// nonce is DERIVED from the event id (deterministic) — a re-sealed immutable event is
// byte-identical, so the fleet store dedups it (fixes store bloat + cold-start truncation).
import * as L from "loam-sync/src/crypto.ts";
import { randomBytes as nodeRandomBytes } from "node:crypto";

const DOMAIN = "kym";
export function newSecret(rng = nodeRandomBytes) { return Uint8Array.from(rng(32)); }
export const deriveIdentity = (secret) => L.deriveIdentity(secret, DOMAIN);
export const topicFor = (id, epoch = 0) => L.topicFor(id, DOMAIN, epoch);
/** seal(id, eventId, plaintext, topic) — eventId drives the deterministic nonce. */
export const seal = (id, eventId, plaintext, topic) => L.seal(id, DOMAIN, eventId, plaintext, topic);
export const open = (id, sealed, topic) => L.open(id, sealed, topic);
