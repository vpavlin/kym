// KYM MCP tools — PURE functions over a budget event log. The MCP server
// (server.mjs) wires these to the protocol. Principle: the LLM never does math
// or sees raw events — each tool returns engine-COMPUTED values (+ a human
// `text` summary), so the model can only route and phrase, never hallucinate a
// number. All money is formatted in the budget currency at the edge.
import { computeState, checkInvariant, listTransactions } from "@kym/engine";
import { formatMoney, toMilli, monthOf } from "@kym/contract";

const CREDIT = new Set(["creditCard", "lineOfCredit"]);
const catNameOf = (st, id) => st.categories.find((c) => c.id === id)?.name || (id || "uncategorized");
const findCat = (st, name) => st.categories.find((c) => c.name.toLowerCase() === String(name).toLowerCase());

export function budget_summary(events, ccy, { month } = {}) {
  const st = computeState(events, month ? { asOf: month } : {});
  const inv = checkInvariant(st);
  const m = (x) => formatMoney(x, ccy);
  return {
    month: st.currentMonth,
    readyToAssign: m(st.readyToAssign),
    readyToAssignRaw: st.readyToAssign,
    accounts: st.accounts.length,
    categories: st.categories.length,
    invariantOk: inv.ok,
    text: `Budget for ${st.currentMonth || "(no activity)"}: Ready to Assign ${m(st.readyToAssign)}`
      + `${st.readyToAssign < 0 ? " (over-assigned)" : st.readyToAssign === 0 ? " (every dollar has a job)" : ""}, `
      + `${st.categories.length} categories across ${st.accounts.length} accounts. Zero-based invariant ${inv.ok ? "holds" : "BROKEN"}.`,
  };
}

export function ready_to_assign(events, ccy) {
  const st = computeState(events);
  const m = (x) => formatMoney(x, ccy);
  return {
    readyToAssign: m(st.readyToAssign), raw: st.readyToAssign,
    text: `Ready to Assign is ${m(st.readyToAssign)}`
      + `${st.readyToAssign < 0 ? " — you have assigned more than you have." : st.readyToAssign === 0 ? " — every dollar has a job." : " — still to be assigned."}`,
  };
}

export function category_status(events, ccy, { name }) {
  const st = computeState(events);
  const cat = findCat(st, name);
  if (!cat) return { error: `no category "${name}"`, text: `There is no category named "${name}".` };
  const row = st.categoryMonths.filter((r) => r.categoryId === cat.id && r.month === st.currentMonth)[0] || { assigned: 0, activity: 0 };
  const avail = st.categoryAvailable[cat.id] || 0;
  const tp = st.targetProgress[cat.id];
  const m = (x) => formatMoney(x, ccy);
  return {
    name: cat.name, assigned: m(row.assigned), spent: m(-Math.min(0, row.activity)), available: m(avail),
    target: tp ? { type: tp.type, need: m(tp.needed), onTrack: tp.onTrack } : null,
    text: `${cat.name}: assigned ${m(row.assigned)}, spent ${m(-Math.min(0, row.activity))}, available ${m(avail)}`
      + `${tp ? (tp.onTrack ? " — target funded." : ` — target needs ${m(tp.needed)} more.`) : "."}`,
  };
}

export function target_progress(events, ccy) {
  const st = computeState(events);
  const items = Object.entries(st.targetProgress).map(([id, tp]) => ({
    category: catNameOf(st, id), type: tp.type,
    need: formatMoney(tp.needed, ccy), onTrack: tp.onTrack,
  }));
  return {
    targets: items,
    text: items.length
      ? items.map((i) => `${i.category}: ${i.onTrack ? "funded" : "needs " + i.need}`).join("; ")
      : "No funding targets set yet.",
  };
}

export function spending(events, ccy, { category, from, to } = {}) {
  const st = computeState(events);
  let rows = listTransactions(events).filter((t) => t.amount < 0 && t.categoryId && t.categoryId !== "rta-inflow");
  if (from) rows = rows.filter((t) => t.date.slice(0, 10) >= from);
  if (to) rows = rows.filter((t) => t.date.slice(0, 10) <= to);
  if (category) { const cat = findCat(st, category); rows = rows.filter((t) => t.categoryId === cat?.id); }
  const byCat = {};
  for (const t of rows) { const n = catNameOf(st, t.categoryId); byCat[n] = (byCat[n] || 0) + -t.amount; }
  const total = Object.values(byCat).reduce((s, v) => s + v, 0);
  const breakdown = Object.entries(byCat).sort((a, b) => b[1] - a[1]).map(([c, v]) => ({ category: c, amount: formatMoney(v, ccy) }));
  const range = from || to ? ` (${from || "…"}–${to || "…"})` : "";
  return {
    total: formatMoney(total, ccy), breakdown,
    text: `Spent ${formatMoney(total, ccy)}${category ? " on " + category : ""}${range}`
      + (breakdown.length ? ": " + breakdown.map((b) => `${b.category} ${b.amount}`).join(", ") : "."),
  };
}

export function search_transactions(events, ccy, { payee, minAmount, maxAmount, from, to, limit = 20 } = {}) {
  const st = computeState(events);
  let rows = listTransactions(events);
  if (payee) rows = rows.filter((t) => `${t.payeeId || ""} ${t.memo || ""}`.toLowerCase().includes(String(payee).toLowerCase()));
  if (from) rows = rows.filter((t) => t.date.slice(0, 10) >= from);
  if (to) rows = rows.filter((t) => t.date.slice(0, 10) <= to);
  if (minAmount != null) rows = rows.filter((t) => Math.abs(t.amount) >= toMilli(minAmount));
  if (maxAmount != null) rows = rows.filter((t) => Math.abs(t.amount) <= toMilli(maxAmount));
  rows = rows.slice(-limit).reverse();
  const list = rows.map((t) => ({
    date: t.date.slice(0, 10), amount: formatMoney(t.amount, ccy),
    payee: t.payeeId || "", category: catNameOf(st, t.categoryId),
  }));
  return {
    count: list.length, transactions: list,
    text: list.length ? list.map((t) => `${t.date}  ${t.amount}  ${t.payee} [${t.category}]`).join("\n") : "No matching transactions.",
  };
}

export function net_worth(events, ccy) {
  const st = computeState(events);
  const byCcy = {};
  for (const a of st.accounts) {
    const c = a.currency || ccy;
    (byCcy[c] ??= { net: 0, rows: [] });
    const bal = st.balances[a.id] || 0;
    byCcy[c].net += bal;
    byCcy[c].rows.push({ name: a.name, balance: formatMoney(bal, c), liability: CREDIT.has(a.type) });
  }
  const nets = Object.entries(byCcy).map(([c, v]) => ({ currency: c, net: formatMoney(v.net, c), accounts: v.rows }));
  return {
    byCurrency: nets,
    text: nets.map((n) => `Net worth (${n.currency}): ${n.net}`).join("; ")
      + (nets.length > 1 ? " — currencies not converted (no exchange rate)." : "."),
  };
}

export function can_i_afford(events, ccy, { amount, category } = {}) {
  const st = computeState(events);
  const amt = toMilli(amount);
  const m = (x) => formatMoney(x, ccy);
  if (category) {
    const cat = findCat(st, category);
    if (!cat) return { error: `no category "${category}"`, text: `There is no category named "${category}".` };
    const avail = st.categoryAvailable[cat.id] || 0;
    const ok = amt <= avail;
    return { affordable: ok, available: m(avail),
      text: `${cat.name} has ${m(avail)} available. ${ok ? "Yes" : "No"}, you ${ok ? "can" : "cannot"} afford ${m(amt)} from it${ok ? "." : ` — short by ${m(amt - avail)}.`}` };
  }
  const rta = st.readyToAssign;
  const ok = amt <= rta;
  return { affordable: ok, readyToAssign: m(rta),
    text: `Ready to Assign is ${m(rta)}. ${ok ? "Yes" : "No"}, ${m(amt)} ${ok ? "fits" : `does not fit — short by ${m(amt - rta)}`}.` };
}

// Registry: name -> { fn, description, inputSchema } for the server to expose.
export const TOOLS = {
  budget_summary: { fn: budget_summary, description: "Overview of the budget for a month (Ready to Assign, counts, invariant).",
    inputSchema: { type: "object", properties: { month: { type: "string", description: "YYYY-MM; default current" } } } },
  ready_to_assign: { fn: ready_to_assign, description: "The single Ready-to-Assign figure and its status.",
    inputSchema: { type: "object", properties: {} } },
  category_status: { fn: category_status, description: "Assigned / spent / available (and target) for one category.",
    inputSchema: { type: "object", properties: { name: { type: "string" } }, required: ["name"] } },
  target_progress: { fn: target_progress, description: "Funding progress for every category that has a target.",
    inputSchema: { type: "object", properties: {} } },
  spending: { fn: spending, description: "Spending by category, optionally filtered by category and/or date range.",
    inputSchema: { type: "object", properties: { category: { type: "string" }, from: { type: "string", description: "YYYY-MM-DD" }, to: { type: "string", description: "YYYY-MM-DD" } } } },
  search_transactions: { fn: search_transactions, description: "Find transactions by payee text, amount range, and/or date range.",
    inputSchema: { type: "object", properties: { payee: { type: "string" }, minAmount: { type: "number" }, maxAmount: { type: "number" }, from: { type: "string" }, to: { type: "string" }, limit: { type: "number" } } } },
  net_worth: { fn: net_worth, description: "Net worth per currency (assets + liabilities; no FX conversion).",
    inputSchema: { type: "object", properties: {} } },
  can_i_afford: { fn: can_i_afford, description: "Whether an amount fits in Ready to Assign, or in a given category's available.",
    inputSchema: { type: "object", properties: { amount: { type: "number" }, category: { type: "string" } }, required: ["amount"] } },
};
