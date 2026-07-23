// The review inbox: every captured transaction, newest first. Uncategorized ones
// float to the top so the "capture now, categorize later" flow works. Assigning a
// category or toggling cleared emits a txn.edit (a superseding event) — the log
// stays append-only, and balances re-fold on the Budget tab.
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
import { formatMoney, suggestCategory } from "../lib/engine";
import { theme } from "../ui/theme";
import { useToast } from "../ui/Toast";
import type { TxnView } from "../lib/budget";

export function ReviewScreen() {
  const {
    txns,
    events,
    state,
    setTxnCategory,
    setTxnCleared,
    editTransaction,
    deleteTransaction,
    budgetCurrency,
    currentBudgetColor,
  } = useBudget();
  const styles = useMemo(() => makeStyles(currentBudgetColor), [currentBudgetColor]);
  const [editing, setEditing] = useState<TxnView | null>(null);
  const [amountText, setAmountText] = useState("");
  const [memoText, setMemoText] = useState("");
  const { show, toast } = useToast();

  // Open the edit sheet, prefilling the amount + note fields.
  const openEditor = (t: TxnView) => {
    setEditing(t);
    setAmountText((Math.abs(t.amount) / 1000).toString());
    setMemoText(t.memo ?? "");
  };

  // Save an edited note (memo). Empty string clears it.
  const applyMemo = async (t: TxnView) => {
    try {
      if ((memoText ?? "") !== (t.memo ?? "")) await editTransaction(t.txnId, { memo: memoText });
      show("Note updated");
      setEditing(null);
    } catch (e: any) {
      Alert.alert("Couldn't update note", e?.message ?? String(e));
    }
  };

  // Save an edited amount: keep the original sign, convert whole units → milli.
  const applyAmount = async (t: TxnView) => {
    const v = parseFloat(amountText.replace(",", "."));
    if (isNaN(v)) {
      Alert.alert("Invalid amount", "Enter a number.");
      return;
    }
    const signed = (t.amount < 0 ? -1 : 1) * Math.round(Math.abs(v) * 1000);
    try {
      if (signed !== t.amount) await editTransaction(t.txnId, { amount: signed });
      show("Amount updated");
      setEditing(null);
    } catch (e: any) {
      Alert.alert("Couldn't update amount", e?.message ?? String(e));
    }
  };

  const applyAccount = async (t: TxnView, accountId: string) => {
    try {
      if (accountId !== t.accountId) await editTransaction(t.txnId, { accountId });
      show("Account updated");
      setEditing(null);
    } catch (e: any) {
      Alert.alert("Couldn't update account", e?.message ?? String(e));
    }
  };

  // Delete confirms first — a tombstone removes the txn's money from the budget.
  const confirmDelete = (t: TxnView) => {
    Alert.alert("Delete transaction?", "This removes its money from the budget.", [
      { text: "Cancel", style: "cancel" },
      {
        text: "Delete",
        style: "destructive",
        onPress: async () => {
          try {
            await deleteTransaction(t.txnId);
            show("Transaction deleted");
            setEditing(null);
          } catch (e: any) {
            Alert.alert("Couldn't delete", e?.message ?? String(e));
          }
        },
      },
    ]);
  };

  const catNameById = (id: string | null) =>
    (id && state.categories.find((c) => c.id === id)?.name) || "Uncategorized";

  // Every action confirms on success and SURFACES its error — never silent
  // (Nielsen: visibility of system status). Errors go to an Alert that explains.
  const applyCategory = async (txnId: string, categoryId: string | null) => {
    try {
      await setTxnCategory(txnId, categoryId);
      show(
        categoryId ? `Set to ${catNameById(categoryId)}` : "Category cleared"
      );
    } catch (e: any) {
      Alert.alert("Couldn't set category", e?.message ?? String(e));
    }
  };

  const applyCleared = async (txnId: string, cleared: TxnView["cleared"]) => {
    try {
      await setTxnCleared(txnId, cleared);
      show(cleared === "cleared" ? "Marked cleared" : "Marked uncleared");
    } catch (e: any) {
      Alert.alert("Couldn't update transaction", e?.message ?? String(e));
    }
  };

  const catName = (id?: string | null) =>
    id ? state.categories.find((c) => c.id === id)?.name ?? id : null;
  const acctName = (id: string) =>
    state.accounts.find((a) => a.id === id)?.name ?? id;
  // A transaction is denominated in its account's currency (a EUR tracking
  // account shows EUR); fall back to the budget currency.
  const acctCurrency = (id: string) =>
    state.accounts.find((a) => a.id === id)?.currency || budgetCurrency;

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
          // For an UNCATEGORIZED txn, learn a category from the user's own history
          // (this payee/memo). One tap on the chip accepts it via the same edit
          // path the sheet uses. Nothing shows when there's no signal.
          const suggestion = !t.categoryId
            ? suggestCategory(events, {
                payee: (t as any).payeeId,
                memo: t.memo,
              })
            : null;
          return (
            <Pressable key={t.txnId} style={styles.item} onPress={() => openEditor(t)}>
              <View style={{ flex: 1 }}>
                <Text style={[styles.cat, !cn && styles.catNeeded]}>
                  {cn ?? "Uncategorized — tap to set"}
                </Text>
                {t.memo ? <Text style={styles.note} numberOfLines={1}>{t.memo}</Text> : null}
                <Text style={styles.meta}>
                  {acctName(t.accountId)} · {new Date(t.date as any).toLocaleDateString()} ·{" "}
                  {t.cleared === "cleared" ? "cleared" : "uncleared"}
                  {(t as any).author ? ` · ${(t as any).author}` : ""}
                </Text>
                {suggestion ? (
                  <Pressable
                    style={styles.suggest}
                    onPress={() => applyCategory(t.txnId, suggestion.categoryId)}
                  >
                    <Text style={styles.suggestText}>→ {suggestion.name}?</Text>
                  </Pressable>
                ) : null}
              </View>
              <Text style={styles.amount}>
                {formatMoney(t.amount, acctCurrency(t.accountId))}
              </Text>
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
              Edit transaction
              {editing ? ` · ${editing.cleared === "cleared" ? "cleared" : "uncleared"}` : ""}
            </Text>

            {/* Amount — magnitude; the sign is preserved on save. */}
            <View style={styles.amountRow}>
              <TextInput
                style={styles.amountInput}
                value={amountText}
                onChangeText={setAmountText}
                keyboardType="decimal-pad"
                placeholder="amount"
                placeholderTextColor={theme.textDim}
              />
              <Pressable
                style={styles.saveBtn}
                onPress={() => editing && applyAmount(editing)}
              >
                <Text style={styles.saveBtnText}>Save amount</Text>
              </Pressable>
            </View>

            {/* Note — what it was for / where it came from. */}
            <View style={styles.amountRow}>
              <TextInput
                style={styles.amountInput}
                value={memoText}
                onChangeText={setMemoText}
                placeholder="Note (optional)"
                placeholderTextColor={theme.textDim}
                autoCapitalize="sentences"
              />
              <Pressable
                style={styles.saveBtn}
                onPress={() => editing && applyMemo(editing)}
              >
                <Text style={styles.saveBtnText}>Save note</Text>
              </Pressable>
            </View>

            {/* Account — tap a chip to move the txn to another account. */}
            {state.accounts.length > 1 ? (
              <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.acctRow}>
                {state.accounts.map((a) => (
                  <Pressable
                    key={a.id}
                    style={[styles.acctChip, editing?.accountId === a.id && styles.acctChipOn]}
                    onPress={() => editing && applyAccount(editing, a.id)}
                  >
                    <Text style={[styles.acctChipText, editing?.accountId === a.id && styles.acctChipTextOn]}>
                      {a.name}
                    </Text>
                  </Pressable>
                ))}
              </ScrollView>
            ) : null}

            <Text style={styles.sectionLabel}>Category</Text>
            <ScrollView style={{ maxHeight: 260 }}>
              {state.categories
                .filter((c) => !c.hidden && !c.archived)
                .map((c) => (
                  <Pressable
                    key={c.id}
                    style={styles.catOption}
                    onPress={async () => {
                      if (editing) await applyCategory(editing.txnId, c.id);
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
                  if (editing) await applyCategory(editing.txnId, null);
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
                  await applyCleared(
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
            <Pressable
              style={styles.deleteBtn}
              onPress={() => editing && confirmDelete(editing)}
            >
              <Text style={styles.deleteBtnText}>Delete transaction</Text>
            </Pressable>
          </Pressable>
        </Pressable>
      </Modal>

      {toast}
    </View>
  );
}

const makeStyles = (accent: string) =>
  StyleSheet.create({
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
  note: { color: theme.text, fontSize: 13, marginTop: 2, fontStyle: "italic" },
  suggest: {
    alignSelf: "flex-start",
    marginTop: 8,
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 999,
    backgroundColor: theme.surfaceAlt,
    borderWidth: 1,
    borderColor: accent,
  },
  suggestText: { color: accent, fontWeight: "700", fontSize: 13 },
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
  check: { color: accent, fontSize: 16, fontWeight: "800" },
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
  amountRow: { flexDirection: "row", alignItems: "center", gap: 10, marginBottom: 12 },
  amountInput: {
    flex: 1,
    color: theme.text,
    fontSize: 18,
    fontWeight: "700",
    backgroundColor: theme.surface,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: theme.border,
    paddingHorizontal: 14,
    paddingVertical: 10,
  },
  saveBtn: {
    backgroundColor: accent,
    borderRadius: 12,
    paddingHorizontal: 16,
    paddingVertical: 12,
  },
  saveBtnText: { color: theme.bg, fontWeight: "800" },
  acctRow: { marginBottom: 12 },
  acctChip: {
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 999,
    backgroundColor: theme.surface,
    borderWidth: 1,
    borderColor: theme.border,
    marginRight: 8,
  },
  acctChipOn: { borderColor: accent, backgroundColor: theme.surfaceAlt },
  acctChipText: { color: theme.text, fontWeight: "600" },
  acctChipTextOn: { color: accent },
  sectionLabel: { color: theme.textDim, fontSize: 12, fontWeight: "700", marginBottom: 4 },
  deleteBtn: {
    marginTop: 10,
    backgroundColor: "transparent",
    borderRadius: 12,
    paddingVertical: 14,
    alignItems: "center",
    borderWidth: 1,
    borderColor: theme.danger,
  },
  deleteBtnText: { color: theme.danger, fontWeight: "800" },
});
