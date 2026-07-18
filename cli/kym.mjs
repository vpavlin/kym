#!/usr/bin/env node
// kym — a real, persistent, command-line KYM budget. Drives the same @kym/engine
// the Basecamp module will mirror. The budget is stored as an append-only event
// log (JSON) — the exact wire format that syncs over Delivery. `kym sync` merges
// another device's log to demonstrate local-first convergence for real.
//
//   kym init --device laptop
//   kym income 2500 --account Checking
//   kym account add Checking --type checking --balance 100
//   kym category add Groceries --group Everyday
//   kym assign Groceries 400
//   kym spend 25.40 --account Checking --category Groceries --payee "Corner Shop"
//   kym budget
//   kym sync ../phone/budget.json

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { ev, Clock, toMilli, fromMilli, formatMoney, DEFAULT_CURRENCY, monthOf, AccountType, RTA_INFLOW } from "@kym/contract";
import { computeState, checkInvariant, mergeEvents } from "@kym/engine";
import { parseExport, fingerprint } from "./importers.mjs";
import { readFileSync as fsRead } from "node:fs";

// Flags that take a value (consume the next token). Everything else after the
// command is a positional. Flags may appear anywhere (before or after the command).
const VALUE_FLAGS = new Set(["--file", "--device", "--type", "--balance", "--group",
  "--account", "--category", "--payee", "--memo", "--date", "--month", "--currency",
  "--format", "--delimiter", "--date-col", "--amount-col", "--payee-col", "--by"]);
const BOOL_FLAGS = new Set(["--off-budget", "--set", "--dry-run"]);

const RAW = process.argv.slice(2);
const FLAGS = {};
const POS = [];
for (let i = 0; i < RAW.length; i++) {
  const a = RAW[i];
  if (VALUE_FLAGS.has(a)) { FLAGS[a] = RAW[++i]; }
  else if (BOOL_FLAGS.has(a)) { FLAGS[a] = true; }
  else if (a.startsWith("--")) { FLAGS[a] = RAW[i + 1] && !RAW[i + 1].startsWith("--") ? RAW[++i] : true; }
  else POS.push(a);
}
const FILE = FLAGS["--file"] || process.env.KYM_FILE || "budget.json";

function argValue(flag) { return FLAGS[flag]; }
function positionals() { return POS.slice(1); } // drop the command itself
function load() {
  if (!existsSync(FILE)) die(`no budget at ${FILE} — run: kym init`);
  return JSON.parse(readFileSync(FILE, "utf8"));
}
function save(doc) { writeFileSync(FILE, JSON.stringify(doc, null, 2) + "\n"); }
function die(msg) { console.error(`kym: ${msg}`); process.exit(1); }

// A clock primed off the existing log so new events sort strictly after them.
function clockFor(doc) {
  const c = new Clock(doc.device);
  for (const e of doc.events) c.receive(e.hlc);
  return c;
}
function stateOf(doc, opts) { return computeState(doc.events, opts); }

// Resolve a user-typed account/category name to its id (case-insensitive).
function findAccount(state, name) {
  const a = state.accounts.find((x) => x.name.toLowerCase() === String(name).toLowerCase());
  if (!a) die(`unknown account "${name}" — see: kym accounts`);
  return a;
}
function findCategory(state, name) {
  if (name === RTA_INFLOW) return { id: RTA_INFLOW, name: "Ready to Assign" };
  const c = state.categories.find((x) => x.name.toLowerCase() === String(name).toLowerCase());
  if (!c) die(`unknown category "${name}" — see: kym budget`);
  return c;
}
function slug(name) { return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "") || randomUUID().slice(0, 8); }

const cmd = POS[0];
const M = argValue("--month");

switch (cmd) {
  case "init": {
    if (existsSync(FILE)) die(`${FILE} already exists`);
    const device = argValue("--device") || `dev-${randomUUID().slice(0, 6)}`;
    const currency = (argValue("--currency") || DEFAULT_CURRENCY).toUpperCase();
    save({ v: 1, device, deviceId: randomUUID(), currency, events: [] });
    console.log(`Initialized KYM budget at ${FILE} (device: ${device}, currency: ${currency})`);
    break;
  }

  case "account": {
    const sub = positionals()[0];
    const doc = load();
    if (sub !== "add") die("usage: kym account add <name> --type <checking|savings|cash|creditCard|lineOfCredit|tracking> [--balance N]");
    const name = positionals()[1] || die("account name required");
    const type = argValue("--type") || AccountType.CHECKING;
    if (!Object.values(AccountType).includes(type)) die(`bad --type ${type}`);
    const balance = toMilli(argValue("--balance") || "0");
    const onBudget = argValue("--off-budget") ? false : type !== AccountType.TRACKING;
    const budgetCcy = doc.currency || DEFAULT_CURRENCY;
    // Foreign accounts must be off-budget tracking (one budget currency; no in-budget FX).
    const currency = (argValue("--currency") || budgetCcy).toUpperCase();
    if (onBudget && currency !== budgetCcy) {
      die(`on-budget accounts must be in the budget currency (${budgetCcy}); use --type tracking for a ${currency} account`);
    }
    const c = clockFor(doc);
    doc.events.push(ev.accountCreate(c.send(), {
      accountId: `acct:${slug(name)}`, name, accountType: type, onBudget,
      startingBalance: balance, startDate: new Date().toISOString(), currency,
    }));
    save(doc);
    console.log(`+ account "${name}" (${type}${onBudget ? "" : ", off-budget"}, ${currency}) starting ${formatMoney(balance, currency)}`);
    break;
  }

  case "category": {
    const sub = positionals()[0];
    const doc = load();
    if (sub !== "add") die("usage: kym category add <name> [--group <group>]");
    const name = positionals()[1] || die("category name required");
    const groupName = argValue("--group") || "General";
    const state = stateOf(doc);
    const c = clockFor(doc);
    let group = state.groups.find((g) => g.name.toLowerCase() === groupName.toLowerCase());
    if (!group) {
      const gid = `grp:${slug(groupName)}`;
      doc.events.push(ev.groupCreate(c.send(), { groupId: gid, name: groupName }));
      group = { id: gid, name: groupName };
    }
    doc.events.push(ev.categoryCreate(c.send(), { categoryId: `cat:${slug(name)}`, groupId: group.id, name }));
    save(doc);
    console.log(`+ category "${name}" in ${group.name}`);
    break;
  }

  case "income": {
    const doc = load();
    const amount = toMilli(positionals()[0] || die("amount required"));
    const state = stateOf(doc);
    const acct = findAccount(state, argValue("--account") || die("--account required"));
    const c = clockFor(doc);
    doc.events.push(ev.txnCreate(c.send(), {
      txnId: randomUUID(), accountId: acct.id, amount: Math.abs(amount),
      date: argValue("--date") || new Date().toISOString(), payeeId: argValue("--payee"),
      categoryId: RTA_INFLOW, cleared: "cleared",
    }));
    save(doc);
    console.log(`+ income ${formatMoney(Math.abs(amount), doc.currency || DEFAULT_CURRENCY)} to ${acct.name} -> Ready to Assign`);
    break;
  }

  case "spend": {
    const doc = load();
    const amount = toMilli(positionals()[0] || die("amount required"));
    const state = stateOf(doc);
    const acct = findAccount(state, argValue("--account") || die("--account required"));
    const cat = findCategory(state, argValue("--category") || die("--category required"));
    const c = clockFor(doc);
    doc.events.push(ev.txnCreate(c.send(), {
      txnId: randomUUID(), accountId: acct.id, amount: -Math.abs(amount),
      date: argValue("--date") || new Date().toISOString(),
      payeeId: argValue("--payee"), categoryId: cat.id, memo: argValue("--memo"),
      cleared: "uncleared",
    }));
    save(doc);
    console.log(`- spent ${formatMoney(Math.abs(amount), doc.currency || DEFAULT_CURRENCY)} from ${acct.name} on ${cat.name}${argValue("--payee") ? ` @ ${argValue("--payee")}` : ""}`);
    break;
  }

  case "assign": {
    const doc = load();
    const state = stateOf(doc);
    const cat = findCategory(state, positionals()[0] || die("category required"));
    const amount = toMilli(positionals()[1] || die("amount required"));
    const month = M || monthOf(new Date().toISOString());
    const mode = argValue("--set") !== undefined ? "set" : "delta";
    const c = clockFor(doc);
    doc.events.push(ev.assign(c.send(), { categoryId: cat.id, month, amount, mode }));
    save(doc);
    console.log(`= assigned ${mode === "set" ? "=" : "+"}${formatMoney(amount, doc.currency || DEFAULT_CURRENCY)} to ${cat.name} (${month})`);
    break;
  }

  case "target": {
    const doc = load();
    const state = stateOf(doc);
    const cat = findCategory(state, positionals()[0] || die("category required"));
    const type = positionals()[1] || die("type required: monthly | balance | balanceByDate");
    if (!["monthly", "balance", "balanceByDate"].includes(type)) die(`bad target type ${type}`);
    const amount = toMilli(positionals()[2] || die("amount required"));
    const targetMonth = argValue("--by");
    if (type === "balanceByDate" && !targetMonth) die("balanceByDate needs --by YYYY-MM");
    const c = clockFor(doc);
    doc.events.push(ev.categoryTarget(c.send(), { categoryId: cat.id, targetType: type, amount, targetMonth }));
    save(doc);
    const ccy = doc.currency || DEFAULT_CURRENCY;
    console.log(`= target ${type} ${formatMoney(amount, ccy)} on ${cat.name}${targetMonth ? ` by ${targetMonth}` : ""}`);
    break;
  }

  case "move": {
    const doc = load();
    const state = stateOf(doc);
    const from = findCategory(state, positionals()[0] || die("from category required"));
    const to = findCategory(state, positionals()[1] || die("to category required"));
    const amount = toMilli(positionals()[2] || die("amount required"));
    const month = M || monthOf(new Date().toISOString());
    const c = clockFor(doc);
    doc.events.push(ev.move(c.send(), { fromCategoryId: from.id, toCategoryId: to.id, month, amount }));
    save(doc);
    console.log(`~ moved ${formatMoney(amount, doc.currency || DEFAULT_CURRENCY)} : ${from.name} -> ${to.name} (${month})`);
    break;
  }

  case "budget": {
    const doc = load();
    const state = stateOf(doc, M ? { asOf: M } : {});
    printBudget(state, doc.currency || DEFAULT_CURRENCY);
    break;
  }

  case "accounts": {
    const doc = load();
    const state = stateOf(doc);
    console.log(`\n  Accounts (device: ${doc.device})`);
    console.log(`  ${"─".repeat(44)}`);
    for (const a of state.accounts) {
      const ac = a.currency || doc.currency || DEFAULT_CURRENCY;
      console.log(`  ${a.name.padEnd(20)} ${formatMoney(state.balances[a.id] || 0, ac).padStart(14)}  ${a.onBudget ? a.type : a.type + " (off-budget)"}`);
    }
    console.log("");
    break;
  }

  case "sync": {
    const other = positionals()[0] || die("usage: kym sync <other-budget.json>");
    if (!existsSync(other)) die(`no such file: ${other}`);
    const doc = load();
    const theirs = JSON.parse(readFileSync(other, "utf8"));
    const before = doc.events.length;
    const merged = mergeEvents(doc.events, theirs.events);
    doc.events = merged;
    save(doc);
    const gained = merged.length - before;
    console.log(`Synced ${other}: ${merged.length} events total (+${gained} new). Both logs now converge.`);
    printBudget(stateOf(doc), doc.currency || DEFAULT_CURRENCY);
    break;
  }

  case "import": {
    const path = positionals()[0] || die("usage: kym import <file.csv> --account <acct> [--format airbank|revolut] [--dry-run]");
    const doc = load();
    const state = stateOf(doc);
    const acct = findAccount(state, argValue("--account") || die("--account required"));
    const ccy = acct.currency || doc.currency || DEFAULT_CURRENCY;
    let text;
    try { text = fsRead(path, "utf8"); } catch { die(`cannot read ${path}`); }
    const parsed = parseExport(text, {
      format: argValue("--format"),
      delimiter: argValue("--delimiter"),
      dateCol: argValue("--date-col") != null ? Number(argValue("--date-col")) : undefined,
      amountCol: argValue("--amount-col") != null ? Number(argValue("--amount-col")) : undefined,
      payeeCol: argValue("--payee-col") != null ? Number(argValue("--payee-col")) : undefined,
    });
    // dedup against already-imported rows (by fingerprint stored in importId)
    const seen = new Set(mergeEvents(doc.events).filter((e) => e.type === "txn.create" && e.payload.importId).map((e) => e.payload.importId));
    const c = clockFor(doc);
    let added = 0, dupes = 0;
    const dry = argValue("--dry-run");
    for (const row of parsed.rows) {
      const fp = fingerprint(row, acct.id);
      if (seen.has(fp)) { dupes++; continue; }
      seen.add(fp);
      added++;
      if (!dry) {
        doc.events.push(ev.txnCreate(c.send(), {
          txnId: randomUUID(), accountId: acct.id, amount: row.amount,
          date: row.date, payeeId: row.payee || undefined, memo: row.memo || undefined,
          cleared: "cleared", importId: fp,
        }));
      }
      if (dry || added <= 8) {
        console.log(`  ${row.date.slice(0, 10)}  ${formatMoney(row.amount, ccy).padStart(14)}  ${row.payee || "—"}`);
      }
    }
    if (!dry) save(doc);
    console.log(`\n${dry ? "[dry-run] " : ""}Imported ${added} transaction(s) from ${parsed.format} export` +
      `${dupes ? `, ${dupes} duplicate(s) skipped` : ""}${parsed.skipped ? `, ${parsed.skipped} unparseable row(s)` : ""}.`);
    if (!dry && added) console.log("(uncategorized — they sit in Ready to Assign until you categorize them)");
    break;
  }

  case "log": {
    const doc = load();
    for (const e of mergeEvents(doc.events)) {
      console.log(`${e.hlc.wall}.${e.hlc.ctr}@${e.dev}  ${e.type.padEnd(15)} ${JSON.stringify(e.payload)}`);
    }
    break;
  }

  default:
    console.log(`kym — Know Your Money (local-first budget)

  kym init [--device NAME] [--file F]
  kym account add <name> --type <checking|savings|cash|creditCard|lineOfCredit|tracking> [--balance N] [--off-budget]
  kym category add <name> [--group G]
  kym income <amount> --account <acct> [--payee P] [--date ISO]
  kym spend <amount> --account <acct> --category <cat> [--payee P] [--memo M] [--date ISO]
  kym assign <category> <amount> [--month YYYY-MM] [--set]
  kym move <from> <to> <amount> [--month YYYY-MM]
  kym target <category> <monthly|balance|balanceByDate> <amount> [--by YYYY-MM]
  kym budget [--month YYYY-MM]
  kym accounts
  kym import <file.csv> --account <acct> [--format airbank|revolut] [--dry-run]
  kym sync <other-budget.json>
  kym log

  Budget file: ${FILE} (override with --file or KYM_FILE)`);
}

function printBudget(state, ccy = DEFAULT_CURRENCY) {
  const inv = checkInvariant(state);
  const f = (m) => formatMoney(m, ccy);
  const byGroup = new Map();
  for (const cat of state.categories) {
    const g = state.groups.find((x) => x.id === cat.groupId)?.name || "—";
    if (!byGroup.has(g)) byGroup.set(g, []);
    byGroup.get(g).push(cat);
  }
  console.log(`\n  Budget — ${state.currentMonth || "(no activity yet)"}`);
  console.log(`  Ready to Assign: ${f(state.readyToAssign)}${state.readyToAssign < 0 ? "  ⚠ negative" : state.readyToAssign === 0 ? "  ✓ every dollar has a job" : ""}`);
  console.log(`  ${"─".repeat(58)}`);
  console.log(`  ${"CATEGORY".padEnd(24)}${"ASSIGNED".padStart(11)}${"ACTIVITY".padStart(11)}${"AVAILABLE".padStart(12)}`);
  for (const [group, cats] of byGroup) {
    console.log(`  ${group}`);
    for (const cat of cats) {
      const rows = state.categoryMonths.filter((r) => r.categoryId === cat.id);
      const row = rows[rows.length - 1] || { assigned: 0, activity: 0 };
      const avail = state.categoryAvailable[cat.id] || 0;
      const flag = avail < 0 ? " ⚠" : "";
      const tp = state.targetProgress[cat.id];
      const target = tp ? (tp.onTrack ? "  🎯 funded" : `  🎯 need ${f(tp.needed)}`) : "";
      console.log(`  ${("  " + cat.name).padEnd(24)}${f(row.assigned).padStart(13)}${f(row.activity).padStart(13)}${f(avail).padStart(14)}${flag}${target}`);
    }
  }
  const ccp = Object.entries(state.creditCardPayments || {});
  if (ccp.length) {
    console.log(`  Credit Card Payments`);
    for (const [acctId, avail] of ccp) {
      const acct = state.accounts.find((a) => a.id === acctId);
      console.log(`  ${("  " + (acct?.name || acctId)).padEnd(48)}${f(avail).padStart(14)}`);
    }
  }
  console.log(`  ${"─".repeat(58)}`);
  console.log(`  invariant ${inv.ok ? "OK ✓" : `BROKEN ✗ (diff ${f(inv.diff)})`}  ·  assets ${f(inv.assets)} = categories ${f(inv.categoriesAvail)} + RTA ${f(inv.readyToAssign)}\n`);
}
