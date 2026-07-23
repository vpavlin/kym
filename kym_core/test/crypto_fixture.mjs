// Emit a deterministic crypto fixture from the TS reference (@kym/sync) for the
// C++ parity test to reproduce. Fixed secret + nonce so seal() is deterministic.
//   node crypto_fixture.mjs   ->  key/value hex lines on stdout
import { deriveIdentity, topicFor, seal } from "@kym/sync/crypto";

const hex = (b) => Buffer.from(b).toString("hex");
const secret = new Uint8Array(Array.from({ length: 32 }, (_, i) => i));      // 00..1f
const nonce = new Uint8Array(Array.from({ length: 12 }, (_, i) => 0x20 + i)); // 20..2b
const plaintext = new TextEncoder().encode('{"v":1,"type":"EVENT","event":{"id":"x","type":"assign","amount":5000}}');

const id = deriveIdentity(secret);
const topic = topicFor(id);
const sealed = seal(id, plaintext, topic, nonce);

process.stdout.write(
  [
    `secret ${hex(secret)}`,
    `nonce ${hex(nonce)}`,
    `K ${hex(id.K)}`,
    `Ke ${hex(id.Ke)}`,
    `topic ${topic}`,
    `plaintext ${hex(plaintext)}`,
    `sealed ${hex(sealed)}`,
  ].join("\n") + "\n"
);
