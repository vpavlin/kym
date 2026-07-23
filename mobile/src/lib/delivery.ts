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
import { loadRegistry } from "./budgets";
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

// The fleet node this light client uses for its client protocols. filternode /
// lightpushnode / storenode each take a SINGLE peer multiaddr (unlike entryNodes,
// which is a discovery list) — the Edge node connected to the fleet for discovery
// but selected no filter/lightpush peer on its own ("filter 0"), so we name one.
// do-ams3 is the closest fleet region; it is also in BOOTSTRAP for discovery.
const SERVICE_NODE =
  "/dns4/delivery-01.do-ams3.logos.dev.status.im/tcp/30303/p2p/16Uiu2HAmTUbnxLGT9JvV6mu9oPyDjqHK4Phs1VDJNUgESgNSkuby";

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

// ONE Waku light node, but N routes — one per budget/household (each its own key +
// derived topic). We subscribe every budget's topic and route an incoming message
// to whichever budget's key authenticates it (open() throws on the wrong key). This
// mirrors kym_core: bootstrapDelivery subscribes all topics; ingestRaw routes by
// contentTopic → budgetForTopic. Sends seal with the target budget's key/topic.
interface Route { budgetId: string; id: Identity; topic: string }
let node: { ctx: string } | null = null;
let didSetup = false;   // LogosMessaging.setup() is process-wide — run it only once
let routes: Route[] = [];
let starting: Promise<{ ctx: string }> | null = null;
let emitter: NativeEventEmitter | null = null;

// Which fleet node we pin as the filter service. "filter 0" = the pinned node
// isn't serving our subscription (region down / at capacity), so we can rotate
// through the fleet's regions until one serves us. rotateFilternode() advances the
// choice; the caller restarts the node to apply it.
let filterIdx = 0;
export function activeFilternode(): string { return BOOTSTRAP[filterIdx % BOOTSTRAP.length]; }
export function rotateFilternode(): void { filterIdx++; }
export function filternodeCount(): number { return BOOTSTRAP.length; }
// A short region label for the diagnostics line (e.g. "do-ams3").
export function activeFilterRegion(): string {
  const m = activeFilternode().match(/delivery-\d+\.([a-z0-9-]+)\.logos/i);
  return m ? m[1] : "unknown";
}

// Build a route per budget that HAS a household secret (paired or self-hosted).
async function buildRoutes(): Promise<Route[]> {
  const reg = await loadRegistry();
  const out: Route[] = [];
  for (const b of reg.budgets) {
    const id = await loadIdentity(b.id);
    if (id) out.push({ budgetId: b.id, id, topic: topicFor(id) });
  }
  return out;
}
// Filter subscriptions are leased by the service node and expire
// (filterSubscriptionTimeout). Re-subscribe periodically or the phone silently
// stops receiving. Idempotent: re-subscribing the same content topic just
// refreshes the lease. Cleared in stopNode.
let renewTimer: ReturnType<typeof setInterval> | null = null;
const FILTER_RENEW_MS = 60000;

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
    routes = await buildRoutes();
    if (routes.length === 0) throw new Error(NOT_PAIRED);
    onStatus?.("Starting node…");
    // setup() initialises the native lib process-wide; call it ONCE. Re-running it
    // on every reconnect (e.g. a retry) can crash the native layer.
    if (!didSetup) { await LogosMessaging.setup(); didSetup = true; }
    // LIGHT CLIENT (Edge). We briefly tried relay (mode:"Core", relay:true) but the
    // native lib REJECTS that config (waku_new returns null → "offline") — a mobile
    // relay needs shard/pubsub config the light build doesn't supply. So we're a
    // Waku light client against the logos.dev fleet: lightpush to publish, filter to
    // receive (a service node pushes matching messages to us), store for later
    // backfill. The known weak spot is filter: if no service node serves our
    // subscription the phone connects but RECEIVES nothing ("filter 0"). We pin a
    // service node for each client protocol and try SEVERAL filternodes below.
    const config = {
      mode: "Edge",
      preset: "logos.dev",
      relay: false,
      lightpush: true,
      filter: true,
      store: true,
      entryNodes: BOOTSTRAP,
      filternode: activeFilternode(),   // rotated on persistent "filter 0"
      lightpushnode: SERVICE_NODE,
      storenode: SERVICE_NODE,
    };
    const c: string = await LogosMessaging.new(config);
    onStatus?.("Connecting to logos.dev…");
    await LogosMessaging.start(c);
    // Subscribe by CONTENT topic — logosdelivery_subscribe auto-shards it and,
    // with relay off + filter on, routes through FILTER (recv_service) rather
    // than relay. relaySubscribe() is the low-level pubsub-topic call and is only
    // a fallback for an older bridge.
    // Subscribe EVERY budget's content topic (one filter subscription each).
    const sub = (LogosMessaging as any).subscribeContentTopic;
    for (const r of routes) {
      if (typeof sub === "function") await sub(c, r.topic);
      else await LogosMessaging.relaySubscribe(c, r.topic);
    }
    onStatus?.("Connecting to service node…");
    await new Promise((r) => setTimeout(r, SETTLE_MS));
    const n = { ctx: c };
    node = n;
    // Keep every budget's filter lease alive (see FILTER_RENEW_MS). Re-subscribe
    // all topics on a timer so a dropped/expired lease self-heals.
    if (renewTimer) clearInterval(renewTimer);
    if (typeof sub === "function") {
      renewTimer = setInterval(() => {
        for (const r of routes) {
          sub(n.ctx, r.topic).catch(() => {
            /* transient — the next tick retries; node stays up */
          });
        }
      }, FILTER_RENEW_MS);
    }
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
export async function sendEnvelope(event: KymEvent, budgetId: string): Promise<void> {
  await ensureNode();
  const r = routes.find((x) => x.budgetId === budgetId);
  if (!r) return; // this budget has no household key on this device — nothing to send
  const envelope = { v: 1, type: "EVENT", event };
  const sealed = seal(r.id, utf8Bytes(JSON.stringify(envelope)), r.topic);
  const messageJson = JSON.stringify({
    contentTopic: r.topic,
    payload: fromByteArray(sealed),
    ephemeral: false,
  });
  await LogosMessaging.send(node!.ctx, messageJson);
}

/**
 * Re-derive the routes and subscribe any newly-added budget's topic on the live
 * node (after creating or pairing a budget) — so a new household starts syncing
 * without a full node restart. No-op if the node isn't up yet (ensureNode will
 * build fresh routes when it starts).
 */
export async function refreshRoutes(): Promise<void> {
  if (!node) return;
  routes = await buildRoutes();
  const sub = (LogosMessaging as any).subscribeContentTopic;
  if (typeof sub === "function") {
    for (const r of routes) await sub(node.ctx, r.topic).catch(() => {});
  }
}

/**
 * Ask the household to re-serve everything we're missing (the pull half of
 * sync). Mirrors KymCoreImpl::sendSyncReq: the envelope is
 * {v:1,type:"SYNC_REQ",from:<deviceId>} sealed with the household key, AAD=topic.
 * Peers answer by re-sending their whole log; ingest dedups by event id, so
 * asking repeatedly is harmless. `from` lets peers skip their own request.
 *
 * liblogosdelivery exposes no Store, so this request/re-serve pair is the ONLY
 * way a device gets state created before it joined.
 */
export async function sendSyncReq(deviceId: string): Promise<void> {
  await ensureNode();
  // Ask on EVERY budget's topic — each household re-serves its own log.
  for (const r of routes) {
    const envelope = { v: 1, type: "SYNC_REQ", from: deviceId };
    const sealed = seal(r.id, utf8Bytes(JSON.stringify(envelope)), r.topic);
    const messageJson = JSON.stringify({
      contentTopic: r.topic,
      payload: fromByteArray(sealed),
      ephemeral: false,
    });
    await LogosMessaging.send(node!.ctx, messageJson).catch(() => {});
  }
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
export function startReceiving(
  onEvent: (budgetId: string, event: KymEvent) => void,
  onSyncReq?: (budgetId: string, from: string) => void
): () => void {
  if (!LogosMessaging) return () => {};
  if (!emitter) emitter = new NativeEventEmitter(LogosMessaging);
  const sub = emitter.addListener("logosMessage", (evt: { wakuPtr?: string; event?: string }) => {
    if (!node) return; // node not up yet — nothing to decrypt against
    try {
      const raw = evt?.event;
      if (!raw) return;
      const ffi = JSON.parse(raw);
      const payloadB64 = findPayload(ffi);
      if (!payloadB64) return;
      const sealed = toByteArray(payloadB64);
      // Route by decryption: try each budget's key. open() is AAD-bound to that
      // budget's topic and authenticated, so exactly the owning budget decrypts;
      // everything else (foreign traffic, other households) throws and we skip it.
      for (const r of routes) {
        let plaintext: Uint8Array;
        try {
          plaintext = open(r.id, sealed, r.topic);
        } catch {
          continue; // not this budget's message
        }
        const env = JSON.parse(utf8Decode(plaintext));
        if (env && env.type === "EVENT" && env.event) {
          onEvent(r.budgetId, env.event as KymEvent);
        } else if (env && env.type === "SYNC_REQ") {
          onSyncReq?.(r.budgetId, typeof env.from === "string" ? env.from : "");
        }
        return; // matched the owning budget — done
      }
    } catch {
      // Drop anything we can't decrypt/parse. Safety net for foreign traffic and
      // an uncertain FFI event shape — never throw here.
    }
  });
  return () => sub.remove();
}

/**
 * Live connectivity, parsed from the node's Prometheus metrics. As a LIGHT node
 * there is no gossip mesh (relay is off), so the mesh gauge is always 0 and would
 * be misleading. What matters instead is whether we have a FILTER service peer —
 * that is the node pushing messages to us; with 0 filter peers we receive nothing.
 *   libp2p_peers      - transport peers (connections to the fleet)
 *   waku_filter_peers - service nodes serving our filter subscription
 * `filter` is the light-node health signal, the way `mesh` was for a relay node.
 * Returns null when unavailable (older bridge, no node) so callers can hide it.
 */
export async function getPeerCount(): Promise<{ peers: number; filter: number } | null> {
  if (!LogosMessaging || !node) return null;
  if (typeof (LogosMessaging as any).getNodeInfo !== "function") return null; // pre-0.8 bridge
  try {
    const metrics: string = await (LogosMessaging as any).getNodeInfo(node.ctx, "Metrics");
    if (typeof metrics !== "string" || !metrics) return null;
    let peers = -1;
    let filter = 0;
    for (const raw of metrics.split("\n")) {
      const line = raw.trim();
      if (!line || line.startsWith("#")) continue;
      const value = Number(line.slice(line.lastIndexOf(" ") + 1));
      if (!Number.isFinite(value)) continue;
      if (line.startsWith("libp2p_peers ")) peers = Math.trunc(value);
      else if (line.startsWith("waku_filter_peers")) filter += Math.trunc(value);
    }
    return peers < 0 ? null : { peers, filter };
  } catch {
    return null; // node down / metrics unavailable — not worth surfacing as an error
  }
}

/** Stop the node (best-effort). */
export async function stopNode(): Promise<void> {
  if (renewTimer) { clearInterval(renewTimer); renewTimer = null; }
  routes = [];
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
