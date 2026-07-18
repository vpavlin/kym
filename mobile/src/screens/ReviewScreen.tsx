// The review inbox: every captured transaction, newest first. Uncategorized ones
// float to the top so the "capture now, categorize later" flow works. Assigning a
// category or toggling cleared emits a txn.edit (a superseding event) — the log
// stays append-only, and balances re-fold on the Budget tab.
import React, { useMemo, useState } from "react";
import {
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { useBudget } from "../state/BudgetContext";
import { fromMilli } from "../lib/engine";
import { theme } from "../ui/theme";
import type { TxnView } from "../lib/budget";

export function ReviewScreen() {
  const { txns, state, setTxnCategory, setTxnCleared } = useBudget();
  const [editing, setEditing] = useState<TxnView | null>(null);

  const catName = (id?: string | null) =>
    id ? state.categories.find((c) => c.id === id)?.name ?? id : null;
  const acctName = (id: string) =>
    state.accounts.find((a) => a.id === id)?.name ?? id;

  // Uncategorized first (the inbox), then by date desc (already sorted in listTxns).
  const ordered = useMemo(() => {
    const un = txns.filter((t) => !t.categoryId);
    const cat = txns.filter((t) => t.categoryId);
    return [...un, ...cat];
  }, [txns]);

  const uncategorizedCount = txns.filter((t) => !t.categoryId).length;

  return (
    <View style={styles.root}>
      <View style={styles.header}>
        <Text style={styles.headerText}>
          {txns.length} transactions
          {uncategorizedCount > 0 ? ` · ${uncategorizedCount} to review` : ""}
        </Text>
      </View>

      <ScrollView contentContainerStyle={{ paddingBottom: 32 }}>
        {ordered.length === 0 ? (
          <Text style={styles.empty}>
            No transactions yet. Capture one on the Add tab.
          </Text>
        ) : null}
        {ordered.map((t) => {
          const cn = catName(t.categoryId);
          return (
            <Pressable key={t.txnId} style={styles.item} onPress={() => setEditing(t)}>
              <View style={{ flex: 1 }}>
                <Text style={[styles.cat, !cn && styles.catNeeded]}>
                  {cn ?? "Uncategorized — tap to set"}
                </Text>
                <Text style={styles.meta}>
                  {acctName(t.accountId)} · {new Date(t.date as any).toLocaleDateString()} ·{" "}
                  {t.cleared === "cleared" ? "cleared" : "uncleared"}
                </Text>
              </View>
              <Text style={styles.amount}>-${fromMilli(Math.abs(t.amount))}</Text>
            </Pressable>
          );
        })}
      </ScrollView>

      {/* Categorize / clear sheet. */}
      <Modal
        visible={!!editing}
        transparent
        animationType="slide"
        onRequestClose={() => setEditing(null)}
      >
        <Pressable style={styles.backdrop} onPress={() => setEditing(null)}>
          <Pressable style={styles.sheet} onPress={() => {}}>
            <Text style={styles.sheetTitle}>
              -${editing ? fromMilli(Math.abs(editing.amount)) : "0.00"} · pick a category
            </Text>
            <ScrollView style={{ maxHeight: 320 }}>
              {state.categories
                .filter((c) => !c.hidden)
                .map((c) => (
                  <Pressable
                    key={c.id}
                    style={styles.catOption}
                    onPress={async () => {
                      if (editing) await setTxnCategory(editing.txnId, c.id);
                      setEditing(null);
                    }}
                  >
                    <Text style={styles.catOptionText}>{c.name}</Text>
                    {editing?.categoryId === c.id ? (
                      <Text style={styles.check}>✓</Text>
                    ) : null}
                  </Pressable>
                ))}
              <Pressable
                style={styles.catOption}
                onPress={async () => {
                  if (editing) await setTxnCategory(editing.txnId, null);
                  setEditing(null);
                }}
              >
                <Text style={[styles.catOptionText, { color: theme.textDim }]}>
                  Clear category
                </Text>
              </Pressable>
            </ScrollView>
            <Pressable
              style={styles.clearedBtn}
              onPress={async () => {
                if (editing) {
                  await setTxnCleared(
                    editing.txnId,
                    editing.cleared === "cleared" ? "uncleared" : "cleared"
                  );
                }
                setEditing(null);
              }}
            >
              <Text style={styles.clearedBtnText}>
                {editing?.cleared === "cleared" ? "Mark uncleared" : "Mark cleared"}
              </Text>
            </Pressable>
          </Pressable>
        </Pressable>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, paddingHorizontal: 16 },
  header: { paddingVertical: 12 },
  headerText: { color: theme.textDim, fontWeight: "600" },
  empty: { color: theme.textDim, textAlign: "center", marginTop: 48 },
  item: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: theme.surface,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: theme.border,
    padding: 14,
    marginBottom: 10,
  },
  cat: { color: theme.text, fontSize: 16, fontWeight: "700" },
  catNeeded: { color: theme.warn },
  meta: { color: theme.textDim, fontSize: 12, marginTop: 4 },
  amount: { color: theme.danger, fontSize: 18, fontWeight: "800" },
  backdrop: { flex: 1, backgroundColor: "#000a", justifyContent: "flex-end" },
  sheet: {
    backgroundColor: theme.surfaceAlt,
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    padding: 18,
  },
  sheetTitle: { color: theme.text, fontSize: 16, fontWeight: "800", marginBottom: 12 },
  catOption: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingVertical: 14,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: theme.border,
  },
  catOptionText: { color: theme.text, fontSize: 16 },
  check: { color: theme.accent, fontSize: 16, fontWeight: "800" },
  clearedBtn: {
    marginTop: 14,
    backgroundColor: theme.surface,
    borderRadius: 12,
    paddingVertical: 14,
    alignItems: "center",
    borderWidth: 1,
    borderColor: theme.border,
  },
  clearedBtnText: { color: theme.text, fontWeight: "700" },
});
