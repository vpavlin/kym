// Native Logos Delivery (embedded Waku node) bridge — the phone runs its OWN
// liblogosdelivery.so node via the LogosMessaging JNI module, publishes household
// budget events on the pair's derived content topic, and RECEIVES the events the
// Basecamp (desktop) side publishes on the same topic. Two-way sync.
//
// The native module is arm64-only (no x86_64 build), so on the emulator
// `deliveryAvailable()` is true (the JS module is registered) but `ensureNode()`
// rejects when setup() can't load the .so — callers surface that as "offline".
//
// Adapted from Perun's mobile/src/lib/delivery.ts. The one net-new piece is
// startReceiving(): Perun wired send + a bare onMessage passthrough but never
// decoded/decrypted the inbound FFI events. That decode lives here.
import { NativeModules, NativeEventEmitter } from "react-native";
import { fromByteArray, toByteArray } from "base64-js";
import { loadIdentity } from "./identityStore";
import { seal, open, topicFor, Identity } from "./identity";
import type { KymEvent } from "./engine";

const { LogosMessaging } = NativeModules as { LogosMessaging: any };

// Time to let the freshly-started node dial logos.dev + form the pubsub mesh
// before the first publish. Only paid once, on initial node bring-up.
const SETTLE_MS = 10000;

// logos.dev bootstrap peers — copied verbatim from Perun's delivery.ts; the same
// set the desktop Basecamp delivery module dials.
const BOOTSTRAP = [
  "/dns4/delivery-01.do-ams3.logos.dev.status.im/tcp/30303/p2p/16Uiu2HAmTUbnxLGT9JvV6mu9oPyDjqHK4Phs1VDJNUgESgNSkuby",
  "/dns4/delivery-02.do-ams3.logos.dev.status.im/tcp/30303/p2p/16Uiu2HAmMK7PYygBtKUQ8EHp7EfaD3bCEsJrkFooK8RQ2PVpJprH",
  "/dns4/delivery-01.gc-us-central1-a.logos.dev.status.im/tcp/30303/p2p/16Uiu2HAm4S1JYkuzDKLKQvwgAhZKs9otxXqt8SCGtB4hoJP1S397",
  "/dns4/delivery-02.gc-us-central1-a.logos.dev.status.im/tcp/30303/p2p/16Uiu2HAm8Y9kgBNtjxvCnf1X6gnZJW5EGE4UwwCL3CCm55TwqBiH",
  "/dns4/delivery-01.ac-cn-hongkong-c.logos.dev.status.im/tcp/30303/p2p/16Uiu2HAm8YokiNun9BkeA1ZRmhLbtNUvcwRr64F69tYj9fkGyuEP",
  "/dns4/delivery-02.ac-cn-hongkong-c.logos.dev.status.im/tcp/30303/p2p/16Uiu2HAkvwhGHKNry6LACrB8TmEFoCJKEX29XR5dDUzk3UT3UNSE",
];

/** True if the native module is present in this build at all. */
export function deliveryAvailable(): boolean {
  return !!LogosMessaging;
}

// UTF-8 <-> bytes, hand-rolled: no TextEncoder/TextDecoder guaranteed on Hermes,
// and no escape/unescape (legacy Annex-B globals). Matches identity.ts's `enc`.
function utf8Bytes(s: string): Uint8Array {
  const out: number[] = [];
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x80) {
      out.push(c);
    } else if (c < 0x800) {
      out.push(0xc0 | (c >> 6), 0x80 | (c & 0x3f));
    } else if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) {
      const c2 = s.charCodeAt(i + 1);
      if (c2 >= 0xdc00 && c2 <= 0xdfff) {
        const cp = 0x10000 + ((c - 0xd800) << 10) + (c2 - 0xdc00);
        out.push(0xf0 | (cp >> 18), 0x80 | ((cp >> 12) & 0x3f), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f));
        i++;
      } else {
        out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f));
      }
    } else {
      out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f));
    }
  }
  return new Uint8Array(out);
}

function utf8Decode(bytes: Uint8Array): string {
  let s = "";
  let i = 0;
  while (i < bytes.length) {
    const b0 = bytes[i++];
    if (b0 < 0x80) {
      s += String.fromCharCode(b0);
    } else if (b0 >= 0xc0 && b0 < 0xe0) {
      const b1 = bytes[i++] & 0x3f;
      s += String.fromCharCode(((b0 & 0x1f) << 6) | b1);
    } else if (b0 >= 0xe0 && b0 < 0xf0) {
      const b1 = bytes[i++] & 0x3f;
      const b2 = bytes[i++] & 0x3f;
      s += String.fromCharCode(((b0 & 0x0f) << 12) | (b1 << 6) | b2);
    } else {
      const b1 = bytes[i++] & 0x3f;
      const b2 = bytes[i++] & 0x3f;
      const b3 = bytes[i++] & 0x3f;
      let cp = ((b0 & 0x07) << 18) | (b1 << 12) | (b2 << 6) | b3;
      cp -= 0x10000;
      s += String.fromCharCode(0xd800 + (cp >> 10), 0xdc00 + (cp & 0x3ff));
    }
  }
  return s;
}

// The running node's context handle plus the paired identity + derived topic it
// was brought up for. Bound together so a send always uses the topic we joined.
interface Node { ctx: string; id: Identity; topic: string }
let node: Node | null = null;
let starting: Promise<Node> | null = null;
let emitter: NativeEventEmitter | null = null;

/** Error thrown when a sync is attempted before pairing. Surfaced to the user. */
export const NOT_PAIRED = "NOT_PAIRED: pair this device with your household first";

/**
 * Bring the node up once (idempotent): load identity (must be paired) → setup →
 * new(logos.dev) → start → relaySubscribe(derived topic) → settle. Concurrent
 * callers share the same in-flight startup. Rejects with NOT_PAIRED if unpaired.
 */
export async function ensureNode(onStatus?: (s: string) => void): Promise<string> {
  if (!LogosMessaging) throw new Error("Logos Delivery native module not present in this build");
  if (node) return node.ctx;
  if (starting) return (await starting).ctx;
  starting = (async () => {
    const id = await loadIdentity();
    if (!id) throw new Error(NOT_PAIRED);
    const topic = topicFor(id);
    onStatus?.("Starting node…");
    await LogosMessaging.setup();
    const config = { mode: "Core", preset: "logos.dev", relay: true, entryNodes: BOOTSTRAP };
    const c: string = await LogosMessaging.new(config);
    onStatus?.("Connecting to logos.dev…");
    await LogosMessaging.start(c);
    // Subscribe by CONTENT topic so this node both publishes AND receives on the
    // household topic (the receive half is what makes sync two-way).
    await LogosMessaging.relaySubscribe(c, topic);
    onStatus?.("Joining mesh…");
    await new Promise((r) => setTimeout(r, SETTLE_MS));
    const n: Node = { ctx: c, id, topic };
    node = n;
    onStatus?.("Connected");
    return n;
  })();
  try {
    return (await starting).ctx;
  } catch (e) {
    node = null;
    throw e;
  } finally {
    starting = null;
  }
}

/**
 * Publish one KYM event on the pair's derived topic. The wire envelope
 * {v:1,type:"EVENT",event} (matches packages/sync/src/wire.mjs) is sealed
 * (ChaCha20-Poly1305, AAD=topic) with the household key, base64'd, and handed to
 * liblogosdelivery as {contentTopic, payload, ephemeral}. No pairing → no send.
 */
export async function sendEnvelope(event: KymEvent): Promise<void> {
  await ensureNode();
  const n = node!;
  const envelope = { v: 1, type: "EVENT", event };
  const sealed = seal(n.id, utf8Bytes(JSON.stringify(envelope)), n.topic);
  const messageJson = JSON.stringify({
    contentTopic: n.topic,
    payload: fromByteArray(sealed),
    ephemeral: false,
  });
  await LogosMessaging.send(n.ctx, messageJson);
}

// Recursively hunt for the first plausible base64 payload string in the FFI event
// object. The exact liblogosdelivery event schema is uncertain and may nest the
// message under wakuMessage/message/etc., so we search rather than assume a path.
// A payload is a non-trivial base64-ish string under a key named "payload".
function findPayload(obj: any, depth = 0): string | null {
  if (obj == null || depth > 6) return null;
  if (typeof obj === "object") {
    // Prefer an explicit `payload` field at this level.
    const p = (obj as any).payload;
    if (typeof p === "string" && p.length > 0) return p;
    for (const k of Object.keys(obj)) {
      const found = findPayload((obj as any)[k], depth + 1);
      if (found) return found;
    }
  }
  return null;
}

/**
 * THE RECEIVE PATH (net-new vs Perun). Subscribe to the native `logosMessage`
 * event stream. Each emission is {wakuPtr, event} where `event` is the
 * liblogosdelivery FFI event as a JSON *string*. We parse it defensively, locate
 * the base64 payload, decrypt+authenticate it with the household key (open()
 * throws on wrong key/topic/tamper — that throw is our safety net for a
 * mis-parsed shape: we simply drop the message), decode the wire envelope, and
 * for EVENT envelopes hand the inner event to onEvent (which appends+dedups+folds).
 *
 * Requires ensureNode() to have succeeded (needs the node's id + topic). Returns
 * an unsubscribe function.
 */
export function startReceiving(onEvent: (event: KymEvent) => void): () => void {
  if (!LogosMessaging) return () => {};
  if (!emitter) emitter = new NativeEventEmitter(LogosMessaging);
  const sub = emitter.addListener("logosMessage", (evt: { wakuPtr?: string; event?: string }) => {
    const n = node;
    if (!n) return; // node not up yet — nothing to decrypt against
    try {
      const raw = evt?.event;
      if (!raw) return;
      const ffi = JSON.parse(raw);
      const payloadB64 = findPayload(ffi);
      if (!payloadB64) return;
      const sealed = toByteArray(payloadB64);
      // open() is AAD-bound to our derived topic and authenticated — a payload
      // that isn't ours (wrong key/topic) or a mis-identified field throws here.
      const plaintext = open(n.id, sealed, n.topic);
      const env = JSON.parse(utf8Decode(plaintext));
      if (env && env.type === "EVENT" && env.event) {
        onEvent(env.event as KymEvent);
      }
    } catch {
      // Drop anything we can't decrypt/parse. This is the safety net for both
      // foreign traffic and an uncertain FFI event shape — never throw here.
    }
  });
  return () => sub.remove();
}

/** Stop the node (best-effort). */
export async function stopNode(): Promise<void> {
  if (node && LogosMessaging) {
    const c = node.ctx;
    node = null;
    try {
      await LogosMessaging.stop(c);
    } catch {
      /* ignore */
    }
  }
}
