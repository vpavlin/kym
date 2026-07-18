// Emit a sync fixture from the TS side: a household secret, a stream of SEALED
// EVENT messages (the §9 two-device scenario), and the expected folded state.
// The C++ ingest parity test opens each message, folds via kym_engine, and must
// reproduce the same budget — proving the module's receive path end to end.
import { ev, Clock, AccountType } from "@kym/contract";
import { computeState, checkInvariant } from "@kym/engine";
import { deriveIdentity, topicFor, seal } from "@kym/sync/crypto";
import { encodeEvent } from "@kym/sync/wire";

const hex = (b) => Buffer.from(b).toString("hex");
const M = "2026-07";
const d = `${M}-15T12:00:00Z`;

let t = 1000;
const c = new Clock("A", () => t++);
const events = [
  ev.accountCreate(c.send(), { accountId: "chk", name: "Checking", accountType: AccountType.CHECKING, startingBalance: 100000, startDate: d, currency: "CZK" }),
  ev.categoryCreate(c.send(), { categoryId: "groc", groupId: "g1", name: "Groceries" }),
  ev.categoryCreate(c.send(), { categoryId: "dine", groupId: "g1", name: "Dining" }),
  ev.assign(c.send(), { categoryId: "groc", month: M, amount: 60000 }),
  ev.txnCreate(c.send(), { txnId: "A1", accountId: "chk", amount: -25000, date: d, categoryId: "groc" }),
  ev.assign(c.send(), { categoryId: "dine", month: M, amount: 40000 }),
  ev.txnCreate(c.send(), { txnId: "B1", accountId: "chk", amount: -30000, date: d, categoryId: "dine" }),
  ev.move(c.send(), { fromCategoryId: "groc", toCategoryId: "dine", month: M, amount: 10000 }),
];

const secret = new Uint8Array(Array.from({ length: 32 }, (_, i) => (i * 7 + 3) & 0xff));
const id = deriveIdentity(secret);
const topic = topicFor(id);
let nonceCtr = 0;
const lines = [`secret ${hex(secret)}`, `topic ${topic}`];
for (const e of events) {
  const nonce = new Uint8Array(12); // deterministic per-message nonce (distinct)
  nonce[0] = nonceCtr++;
  lines.push(`msg ${hex(seal(id, encodeEvent(e), topic, nonce))}`);
}
const st = computeState(events);
lines.push(`expect chk ${st.balances.chk}`);
lines.push(`expect groc ${st.categoryAvailable.groc}`);
lines.push(`expect dine ${st.categoryAvailable.dine}`);
lines.push(`expect rta ${st.readyToAssign}`);
lines.push(`expect inv ${checkInvariant(st).ok ? 1 : 0}`);
process.stdout.write(lines.join("\n") + "\n");
