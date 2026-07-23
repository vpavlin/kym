// Offline balances — the proof the phone runs the same engine as the desktop.
// Everything here is read from computeState(log): Ready to Assign, per-category
// Available for the current month, account balances, and the invariant oracle.
// No number on this screen is stored; all are a fold of the local event log.
import React, { useMemo, useState } from "react";
import {
  Alert,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { useBudget } from "../state/BudgetContext";
import { formatMoney, toMilli, netWorth } from "../lib/engine";
import { theme } from "../ui/theme";

// What the action sheet is currently editing: an envelope (assign / set target)
// or an account (reconcile). Null = closed.
type Sheet =
  | { kind: "category"; id: string; name: string }
  | { kind: "account"; id: string; name: string; currency: string }
  | null;

function Amount({
  milli,
  currency,
  dim,
  warnNegative,
}: {
  milli: number;
  currency: string;
  dim?: boolean;
  // When set, a negative value renders a non-color "over" indicator (a ⚠ glyph)
  // next to the amount — meaning survives without color (WCAG 1.4.1). The amount
  // keeps its minus sign either way.
  warnNegative?: boolean;
}) {
  const color = milli > 0 ? theme.good : milli < 0 ? theme.danger : theme.textDim;
  return (
    <View style={styles.amtWrap}>
      {warnNegative && milli < 0 ? (
        <Text style={styles.overTag} accessibilityLabel="overspent">
          ⚠ over
        </Text>
      ) : null}
      <Text style={[styles.amt, { color: dim ? theme.textDim : color }]}>
        {formatMoney(milli, currency)}
      </Text>
    </View>
  );
}

export function BudgetScreen() {
  const { state, invariant, budgetCurrency, assign, setTarget, reconcile, moveMoney, currentBudgetColor } = useBudget();
  // Accent follows the current budget's colour. The module-level `styles` (default
  // accent) still serves the <Amount> sub-component, which uses no accent.
  const styles = useMemo(() => makeStyles(currentBudgetColor), [currentBudgetColor]);
  const month = state.currentMonth ?? "—";

  // Action sheet: tap an envelope to assign / set a target, tap an account to
  // reconcile. All ops go through the shared engine (BudgetContext) — same events
  // the desktop and CLI produce.
  const [sheet, setSheet] = useState<Sheet>(null);
  const [amount, setAmount] = useState("");
  const [busy, setBusy] = useState(false);
  const closeSheet = () => { setSheet(null); setAmount(""); };

  const parse = (): number | null => {
    const t = amount.trim();
    if (!t) return null;
    try { return toMilli(t); } catch { return null; }
  };
  const run = async (fn: () => Promise<unknown>, okMsg: string) => {
    const m = parse();
    if (m === null) { Alert.alert("Enter an amount", "Type a number like 1500 or 1500.00."); return; }
    setBusy(true);
    try { await fn(); closeSheet(); }
    catch (e: any) { Alert.alert("Couldn't save", String(e?.message ?? e)); }
    finally { setBusy(false); }
  };

  const cmByCat = new Map<string, { assigned: number; activity: number }>();
  for (const cm of state.categoryMonths) {
    if (cm.month === state.currentMonth) {
      cmByCat.set(cm.categoryId, { assigned: cm.assigned, activity: cm.activity });
    }
  }

  const groupName = (id: string) =>
    state.groups.find((g) => g.id === id)?.name ?? "Other";
  const groupsInUse = Array.from(
    new Set(state.categories.filter((c) => !c.hidden).map((c) => c.groupId))
  );

  return (
    <ScrollView style={styles.root} contentContainerStyle={{ paddingBottom: 32 }}>
      {/* Ready to Assign — the zero-based headline number. */}
      <View
        style={[
          styles.rta,
          { borderColor: state.readyToAssign < 0 ? theme.danger : currentBudgetColor },
        ]}
      >
        <Text style={styles.rtaLabel}>Ready to Assign · {month}</Text>
        <Amount milli={state.readyToAssign} currency={budgetCurrency} />
        {/* Status WORD alongside the number, so the state reads without color
            (WCAG 1.4.1): over-assigned / all assigned / to assign. */}
        <Text
          style={[
            styles.rtaWarn,
            {
              color:
                state.readyToAssign < 0
                  ? theme.danger
                  : state.readyToAssign === 0
                  ? theme.good
                  : theme.textDim,
            },
          ]}
        >
          {state.readyToAssign < 0
            ? "⚠ over-assigned — move money to fix"
            : state.readyToAssign === 0
            ? "✓ all assigned"
            : "to assign"}
        </Text>
      </View>

      {/* Invariant oracle — the same check the engine tests assert. */}
      <View style={styles.invariant}>
        <Text
          style={[styles.invDot, { color: invariant.ok ? theme.good : theme.danger }]}
          accessibilityLabel={invariant.ok ? "invariant holds" : "invariant broken"}
        >
          {invariant.ok ? "✓" : "✗"}
        </Text>
        <Text style={styles.invText}>
          {invariant.ok
            ? "Invariant holds (assets = envelopes + RTA)"
            : `Invariant off by ${formatMoney(Math.abs(invariant.diff), budgetCurrency)} — engine bug`}
        </Text>
      </View>

      {/* Accounts. */}
      <Text style={styles.section}>Accounts</Text>
      <View style={styles.card}>
        {state.accounts.map((a) => (
          <Pressable
            key={a.id}
            style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
            onPress={() => setSheet({ kind: "account", id: a.id, name: a.name, currency: a.currency || budgetCurrency })}
            accessibilityHint="Reconcile this account"
          >
            <Text style={styles.rowName}>
              {a.name}{" "}
              <Text style={styles.rowType}>
                · {a.type}
                {a.onBudget ? "" : " (off-budget)"}
              </Text>
            </Text>
            <Amount
              milli={state.balances[a.id] ?? 0}
              currency={a.currency || budgetCurrency}
            />
          </Pressable>
        ))}
        {state.accounts.length === 0 ? (
          <Text style={styles.emptyLine}>No accounts. Seed a budget on the Setup tab.</Text>
        ) : null}
        {state.accounts.length > 0
          ? (() => {
              const nw = netWorth(state, budgetCurrency);
              return nw.currencies.map((ccy) => (
                <View key={ccy} style={styles.netRow}>
                  <Text style={styles.netLabel}>
                    Net worth{nw.currencies.length > 1 ? ` (${ccy})` : ""}
                  </Text>
                  <Text style={styles.netValue}>{formatMoney(nw.byCurrency[ccy].net, ccy)}</Text>
                </View>
              ));
            })()
          : null}
      </View>

      {/* Envelopes by group. */}
      {groupsInUse.map((gid) => (
        <View key={gid}>
          <Text style={styles.section}>{groupName(gid)}</Text>
          <View style={styles.card}>
            {state.categories
              .filter((c) => c.groupId === gid && !c.hidden)
              .map((c) => {
                const avail = state.categoryAvailable[c.id] ?? 0;
                const cm = cmByCat.get(c.id) ?? { assigned: 0, activity: 0 };
                return (
                  <Pressable
                    key={c.id}
                    style={({ pressed }) => [styles.catRow, pressed && styles.rowPressed]}
                    onPress={() => setSheet({ kind: "category", id: c.id, name: c.name })}
                    accessibilityHint="Assign money or set a target"
                  >
                    <View style={{ flex: 1 }}>
                      <Text style={styles.rowName}>{c.name}</Text>
                      <Text style={styles.catMeta}>
                        assigned {formatMoney(cm.assigned, budgetCurrency)} · spent{" "}
                        {formatMoney(Math.abs(cm.activity), budgetCurrency)}
                      </Text>
                    </View>
                    <View style={styles.availPill}>
                      <Amount milli={avail} currency={budgetCurrency} warnNegative />
                    </View>
                  </Pressable>
                );
              })}
          </View>
        </View>
      ))}

      {/* Credit card payment envelopes, if any. */}
      {Object.keys(state.creditCardPayments).length > 0 ? (
        <View>
          <Text style={styles.section}>Credit Card Payments</Text>
          <View style={styles.card}>
            {Object.entries(state.creditCardPayments).map(([acctId, avail]) => (
              <View key={acctId} style={styles.row}>
                <Text style={styles.rowName}>
                  {state.accounts.find((a) => a.id === acctId)?.name ?? acctId}
                </Text>
                <Amount milli={avail} currency={budgetCurrency} />
              </View>
            ))}
          </View>
        </View>
      ) : null}

      <Text style={styles.footer}>
        {state.eventCount} events folded on-device · income{" "}
        {formatMoney(state.income, budgetCurrency)} · assigned{" "}
        {formatMoney(state.totalAssigned, budgetCurrency)}
      </Text>

      {/* Action sheet — assign / set target on a category, reconcile an account. */}
      <Modal visible={sheet !== null} transparent animationType="fade" onRequestClose={closeSheet}>
        <Pressable style={styles.backdrop} onPress={closeSheet}>
          <Pressable style={styles.sheet} onPress={() => {}}>
            <Text style={styles.sheetTitle}>
              {sheet?.kind === "account" ? `Reconcile ${sheet.name}` : `${sheet?.name}`}
            </Text>
            <Text style={styles.sheetSub}>
              {sheet?.kind === "account"
                ? "Enter the balance your bank shows. KYM books the difference and locks this account's transactions."
                : "Give this envelope money, or set a monthly funding target."}
            </Text>
            <TextInput
              style={styles.sheetInput}
              value={amount}
              onChangeText={setAmount}
              keyboardType="decimal-pad"
              placeholder={sheet?.kind === "account" ? "actual balance" : "amount"}
              placeholderTextColor={theme.textDim}
              autoFocus
            />
            <View style={styles.sheetBtns}>
              {sheet?.kind === "account" ? (
                <Pressable
                  style={[styles.sheetBtn, styles.sheetBtnPrimary]}
                  disabled={busy}
                  onPress={() =>
                    run(async () => {
                      const diff = await reconcile(sheet.id, parse()!);
                      Alert.alert("Reconciled", diff === 0 ? "Already matched — transactions locked." : `Booked ${formatMoney(diff, sheet.currency)} adjustment.`);
                    }, "Reconciled")
                  }
                >
                  <Text style={styles.sheetBtnText}>Reconcile</Text>
                </Pressable>
              ) : (
                <>
                  <Pressable
                    style={[styles.sheetBtn, styles.sheetBtnPrimary]}
                    disabled={busy}
                    onPress={() => run(() => assign(sheet!.id, parse()!, "delta"), "Assigned")}
                  >
                    <Text style={styles.sheetBtnText}>Assign +</Text>
                  </Pressable>
                  <Pressable
                    style={[styles.sheetBtn, styles.sheetBtnGhost]}
                    disabled={busy}
                    onPress={() => run(() => setTarget(sheet!.id, "monthly", parse()!), "Target set")}
                  >
                    <Text style={styles.sheetBtnGhostText}>Set /mo target</Text>
                  </Pressable>
                </>
              )}
            </View>

            {/* Move the amount from this envelope to another one (net-zero). */}
            {sheet?.kind === "category" ? (
              <View style={styles.moveWrap}>
                <Text style={styles.moveLabel}>or move the amount to →</Text>
                <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.moveChips}>
                  {state.categories
                    .filter((c) => c.id !== sheet.id && !c.hidden)
                    .map((c) => (
                      <Pressable
                        key={c.id}
                        style={styles.moveChip}
                        disabled={busy}
                        onPress={() => run(() => moveMoney(sheet.id, c.id, parse()!), `Moved to ${c.name}`)}
                      >
                        <Text style={styles.moveChipText}>{c.name}</Text>
                      </Pressable>
                    ))}
                </ScrollView>
              </View>
            ) : null}
            <Pressable onPress={closeSheet} style={styles.sheetCancel}>
              <Text style={styles.sheetCancelText}>Cancel</Text>
            </Pressable>
          </Pressable>
        </Pressable>
      </Modal>
    </ScrollView>
  );
}

const makeStyles = (accent: string) =>
  StyleSheet.create({
  rowPressed: { opacity: 0.55 },
  netRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", borderTopWidth: 1, borderTopColor: theme.border, marginTop: 4, paddingTop: 10 },
  netLabel: { color: theme.textDim, fontWeight: "700", fontSize: 13 },
  netValue: { color: theme.text, fontWeight: "800", fontSize: 15 },
  backdrop: { flex: 1, backgroundColor: "rgba(0,0,0,0.55)", justifyContent: "flex-end" },
  sheet: { backgroundColor: theme.surface, borderTopLeftRadius: 18, borderTopRightRadius: 18, padding: 20, paddingBottom: 34, borderTopWidth: 1, borderColor: theme.border },
  sheetTitle: { color: theme.text, fontSize: 19, fontWeight: "800" },
  sheetSub: { color: theme.textDim, fontSize: 13, lineHeight: 19, marginTop: 6 },
  sheetInput: { backgroundColor: theme.surfaceAlt, borderRadius: 10, borderWidth: 1, borderColor: theme.border, color: theme.text, fontSize: 20, paddingHorizontal: 14, paddingVertical: 12, marginTop: 16 },
  sheetBtns: { flexDirection: "row", gap: 10, marginTop: 14 },
  sheetBtn: { flex: 1, borderRadius: 10, paddingVertical: 13, alignItems: "center" },
  sheetBtnPrimary: { backgroundColor: accent },
  sheetBtnText: { color: theme.accentText, fontWeight: "800", fontSize: 15 },
  sheetBtnGhost: { backgroundColor: theme.surfaceAlt, borderWidth: 1, borderColor: theme.border },
  sheetBtnGhostText: { color: theme.text, fontWeight: "700", fontSize: 15 },
  sheetCancel: { alignItems: "center", paddingVertical: 14, marginTop: 4 },
  sheetCancelText: { color: theme.textDim, fontWeight: "600" },
  moveWrap: { marginTop: 16 },
  moveLabel: { color: theme.textDim, fontSize: 12, marginBottom: 8 },
  moveChips: { gap: 8, paddingRight: 8 },
  moveChip: { backgroundColor: theme.surfaceAlt, borderWidth: 1, borderColor: theme.border, borderRadius: 999, paddingHorizontal: 14, paddingVertical: 9 },
  moveChipText: { color: theme.text, fontSize: 13, fontWeight: "600" },
  root: { flex: 1, paddingHorizontal: 16 },
  amt: { fontSize: 18, fontWeight: "800" },
  amtWrap: { flexDirection: "row", alignItems: "center", gap: 6 },
  overTag: {
    color: theme.danger,
    fontSize: 11,
    fontWeight: "800",
    textTransform: "uppercase",
    letterSpacing: 0.5,
  },
  rta: {
    borderWidth: 2,
    borderRadius: 16,
    padding: 18,
    alignItems: "center",
    marginTop: 12,
    backgroundColor: theme.surface,
  },
  rtaLabel: { color: theme.textDim, fontWeight: "700", marginBottom: 6 },
  rtaWarn: { color: theme.danger, marginTop: 6, fontWeight: "600" },
  invariant: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    marginTop: 10,
    paddingHorizontal: 4,
  },
  invDot: { fontSize: 14 },
  invText: { color: theme.textDim, fontSize: 13 },
  section: {
    color: theme.text,
    fontSize: 15,
    fontWeight: "800",
    marginTop: 20,
    marginBottom: 8,
  },
  card: {
    backgroundColor: theme.surface,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: theme.border,
    paddingHorizontal: 14,
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingVertical: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: theme.border,
  },
  catRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingVertical: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: theme.border,
  },
  rowName: { color: theme.text, fontSize: 16, fontWeight: "600" },
  rowType: { color: theme.textDim, fontSize: 13, fontWeight: "400" },
  catMeta: { color: theme.textDim, fontSize: 12, marginTop: 3 },
  availPill: { minWidth: 90, alignItems: "flex-end" },
  emptyLine: { color: theme.textDim, paddingVertical: 14 },
  footer: { color: theme.textDim, fontSize: 12, textAlign: "center", marginTop: 24 },
});

// Module-level default (accent = teal) for the <Amount> sub-component and any
// non-hook reference; the main component overrides accent via useMemo(makeStyles).
const styles = makeStyles(theme.accent);
