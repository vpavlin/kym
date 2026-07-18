// Offline balances — the proof the phone runs the same engine as the desktop.
// Everything here is read from computeState(log): Ready to Assign, per-category
// Available for the current month, account balances, and the invariant oracle.
// No number on this screen is stored; all are a fold of the local event log.
import React from "react";
import { ScrollView, StyleSheet, Text, View } from "react-native";
import { useBudget } from "../state/BudgetContext";
import { formatMoney } from "../lib/engine";
import { theme } from "../ui/theme";

function Amount({
  milli,
  currency,
  dim,
}: {
  milli: number;
  currency: string;
  dim?: boolean;
}) {
  const color = milli > 0 ? theme.good : milli < 0 ? theme.danger : theme.textDim;
  return (
    <Text style={[styles.amt, { color: dim ? theme.textDim : color }]}>
      {formatMoney(milli, currency)}
    </Text>
  );
}

export function BudgetScreen() {
  const { state, invariant, budgetCurrency } = useBudget();
  const month = state.currentMonth ?? "—";

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
          { borderColor: state.readyToAssign < 0 ? theme.danger : theme.accent },
        ]}
      >
        <Text style={styles.rtaLabel}>Ready to Assign · {month}</Text>
        <Amount milli={state.readyToAssign} currency={budgetCurrency} />
        {state.readyToAssign < 0 ? (
          <Text style={styles.rtaWarn}>Over-assigned — move money to fix.</Text>
        ) : null}
      </View>

      {/* Invariant oracle — the same check the engine tests assert. */}
      <View style={styles.invariant}>
        <Text style={[styles.invDot, { color: invariant.ok ? theme.good : theme.danger }]}>
          {invariant.ok ? "●" : "▲"}
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
          <View key={a.id} style={styles.row}>
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
          </View>
        ))}
        {state.accounts.length === 0 ? (
          <Text style={styles.emptyLine}>No accounts. Seed a budget on the Setup tab.</Text>
        ) : null}
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
                  <View key={c.id} style={styles.catRow}>
                    <View style={{ flex: 1 }}>
                      <Text style={styles.rowName}>{c.name}</Text>
                      <Text style={styles.catMeta}>
                        assigned {formatMoney(cm.assigned, budgetCurrency)} · spent{" "}
                        {formatMoney(Math.abs(cm.activity), budgetCurrency)}
                      </Text>
                    </View>
                    <View style={styles.availPill}>
                      <Amount milli={avail} currency={budgetCurrency} />
                    </View>
                  </View>
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
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, paddingHorizontal: 16 },
  amt: { fontSize: 18, fontWeight: "800" },
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
