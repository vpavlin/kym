// Emit a deterministic crypto fixture from the TS reference (@kym/sync) for the
// C++ parity test to reproduce. The nonce is DERIVED from the event id (ADR 0011),
// so seal() is deterministic without an explicit nonce.
//   node crypto_fixture.mjs   ->  key/value hex lines on stdout
import { deriveIdentity, topicFor, seal } from "@kym/sync/crypto";

const hex = (b) => Buffer.from(b).toString("hex");
const secret = new Uint8Array(Array.from({ length: 32 }, (_, i) => i));      // 00..1f
const eventId = "x";                                                          // drives the deterministic nonce
const plaintext = new TextEncoder().encode('{"v":1,"type":"EVENT","event":{"id":"x","type":"assign","amount":5000}}');

const id = deriveIdentity(secret);
const topic = topicFor(id);
const sealed = seal(id, eventId, plaintext, topic);

process.stdout.write(
  [
    `secret ${hex(secret)}`,
    `eventId ${eventId}`,
    `K ${hex(id.K)}`,
    `Ke ${hex(id.Ke)}`,
    `topic ${topic}`,
    `plaintext ${hex(plaintext)}`,
    `sealed ${hex(sealed)}`,
  ].join("\n") + "\n"
);
