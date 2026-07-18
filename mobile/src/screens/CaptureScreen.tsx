// The one job: capture an expense in under 10 seconds. Amount-first, big custom
// keypad (no OS keyboard round-trip), amount is the ONLY required field. Account,
// date, cleared, category are all defaulted. One tap on Save appends a txn.create
// and the balances re-fold instantly — never blocks on anything.
import React, { useMemo, useState } from "react";
import {
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { useBudget } from "../state/BudgetContext";
import { formatMoney } from "../lib/engine";
import { DEFAULT_ACCOUNT } from "../lib/budget";
import { theme } from "../ui/theme";

const KEYS = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "clr", "0", "del"];

export function CaptureScreen({ goSetup }: { goSetup: () => void }) {
  const { state, addExpense, budgetCurrency } = useBudget();
  const [cents, setCents] = useState(0); // ATM-style entry: digits shift in from the right
  const [accountId, setAccountId] = useState<string | null>(null);
  const [categoryId, setCategoryId] = useState<string | null>(null);
  const [cleared, setCleared] = useState(false);
  const [flash, setFlash] = useState<string | null>(null);

  const accounts = state.accounts.filter((a) => !a.closed);
  const categories = state.categories.filter((c) => !c.hidden);

  // Default account = Checking if present, else the first account.
  const activeAccount =
    accountId ??
    (accounts.find((a) => a.id === DEFAULT_ACCOUNT)?.id ?? accounts[0]?.id ?? null);

  const amountMilli = cents * 10; // 1 cent = 10 milliunits
  // The capture is denominated in the chosen account's currency (a EUR tracking
  // account captures in EUR); fall back to the budget currency.
  const activeCurrency =
    accounts.find((a) => a.id === activeAccount)?.currency || budgetCurrency;
  const display = useMemo(
    () => formatMoney(amountMilli, activeCurrency),
    [amountMilli, activeCurrency]
  );

  const press = (k: string) => {
    if (k === "del") setCents((c) => Math.floor(c / 10));
    else if (k === "clr") setCents(0);
    else setCents((c) => Math.min(c * 10 + Number(k), 9_999_999)); // cap ~ $99,999.99
  };

  const canSave = amountMilli > 0 && !!activeAccount;

  const save = async () => {
    if (!canSave || !activeAccount) return;
    await addExpense({
      amountMilli,
      accountId: activeAccount,
      categoryId,
      cleared: cleared ? "cleared" : "uncleared",
    });
    const acctName = accounts.find((a) => a.id === activeAccount)?.name ?? "account";
    const catName = categories.find((c) => c.id === categoryId)?.name ?? "Uncategorized";
    setFlash(`Saved ${formatMoney(amountMilli, activeCurrency)} · ${catName} · ${acctName}`);
    setCents(0);
    setCategoryId(null);
    setCleared(false);
    setTimeout(() => setFlash(null), 1600);
  };

  if (accounts.length === 0) {
    return (
      <View style={styles.empty}>
        <Text style={styles.emptyTitle}>No accounts yet</Text>
        <Text style={styles.emptyBody}>
          Seed a demo budget (or add an account) so your captures have somewhere to land.
        </Text>
        <Pressable style={styles.primaryBtn} onPress={goSetup}>
          <Text style={styles.primaryBtnText}>Go to Setup</Text>
        </Pressable>
      </View>
    );
  }

  return (
    <View style={styles.root}>
      {/* Amount — the hero (formatted in the active account's currency). */}
      <View style={styles.amountWrap}>
        <Text style={styles.amount} numberOfLines={1} adjustsFontSizeToFit>
          {display}
        </Text>
      </View>

      {flash ? (
        <View style={styles.flash}>
          <Text style={styles.flashText}>{flash}</Text>
        </View>
      ) : (
        <Text style={styles.hint}>Type an amount — that's all you need.</Text>
      )}

      {/* Optional context: category (defaults to Uncategorized → Review inbox). */}
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        style={styles.chipRow}
        contentContainerStyle={styles.chipRowContent}
      >
        <Chip
          label="Uncategorized"
          active={categoryId === null}
          onPress={() => setCategoryId(null)}
        />
        {categories.map((c) => (
          <Chip
            key={c.id}
            label={c.name}
            active={categoryId === c.id}
            onPress={() => setCategoryId(c.id)}
          />
        ))}
      </ScrollView>

      {/* Account + cleared row. */}
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        style={styles.chipRow}
        contentContainerStyle={styles.chipRowContent}
      >
        {accounts.map((a) => (
          <Chip
            key={a.id}
            label={a.name}
            active={activeAccount === a.id}
            onPress={() => setAccountId(a.id)}
          />
        ))}
        <Chip
          label={cleared ? "Cleared" : "Uncleared"}
          active={cleared}
          onPress={() => setCleared((v) => !v)}
        />
      </ScrollView>

      {/* Keypad. */}
      <View style={styles.pad}>
        {KEYS.map((k) => (
          <Pressable
            key={k}
            style={({ pressed }) => [styles.key, pressed && styles.keyPressed]}
            onPress={() => press(k)}
          >
            <Text style={styles.keyText}>{k === "del" ? "⌫" : k === "clr" ? "C" : k}</Text>
          </Pressable>
        ))}
      </View>

      <Pressable
        style={[styles.save, !canSave && styles.saveDisabled]}
        onPress={save}
        disabled={!canSave}
      >
        <Text style={styles.saveText}>Save expense</Text>
      </Pressable>
    </View>
  );
}

function Chip({
  label,
  active,
  onPress,
}: {
  label: string;
  active: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      onPress={onPress}
      style={[styles.chip, active && styles.chipActive]}
    >
      <Text style={[styles.chipText, active && styles.chipTextActive]}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, paddingHorizontal: 16, paddingTop: 8 },
  amountWrap: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    marginTop: 12,
  },
  currency: { color: theme.textDim, fontSize: 32, fontWeight: "600", marginRight: 6 },
  amount: { color: theme.text, fontSize: 64, fontWeight: "800", letterSpacing: 1 },
  hint: { color: theme.textDim, textAlign: "center", marginTop: 4, minHeight: 20 },
  flash: {
    backgroundColor: theme.surfaceAlt,
    borderRadius: 10,
    paddingVertical: 6,
    paddingHorizontal: 12,
    alignSelf: "center",
    marginTop: 2,
    minHeight: 20,
  },
  flashText: { color: theme.good, fontWeight: "600" },
  chipRow: { flexGrow: 0, marginTop: 12 },
  chipRowContent: { gap: 8, paddingRight: 8 },
  chip: {
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 999,
    backgroundColor: theme.surface,
    borderWidth: 1,
    borderColor: theme.border,
  },
  chipActive: { backgroundColor: theme.accent, borderColor: theme.accent },
  chipText: { color: theme.textDim, fontWeight: "600" },
  chipTextActive: { color: theme.accentText },
  pad: {
    flexDirection: "row",
    flexWrap: "wrap",
    justifyContent: "space-between",
    marginTop: 16,
  },
  key: {
    width: "31%",
    aspectRatio: 1.9,
    backgroundColor: theme.surface,
    borderRadius: 14,
    alignItems: "center",
    justifyContent: "center",
    marginBottom: 10,
    borderWidth: 1,
    borderColor: theme.border,
  },
  keyPressed: { backgroundColor: theme.surfaceAlt },
  keyText: { color: theme.text, fontSize: 26, fontWeight: "700" },
  save: {
    backgroundColor: theme.accent,
    borderRadius: 14,
    paddingVertical: 18,
    alignItems: "center",
    marginTop: 4,
    marginBottom: 8,
  },
  saveDisabled: { backgroundColor: theme.surfaceAlt },
  saveText: { color: theme.accentText, fontSize: 18, fontWeight: "800" },
  empty: { flex: 1, alignItems: "center", justifyContent: "center", padding: 32 },
  emptyTitle: { color: theme.text, fontSize: 22, fontWeight: "800", marginBottom: 8 },
  emptyBody: { color: theme.textDim, textAlign: "center", marginBottom: 24, lineHeight: 20 },
  primaryBtn: {
    backgroundColor: theme.accent,
    borderRadius: 12,
    paddingVertical: 14,
    paddingHorizontal: 28,
  },
  primaryBtnText: { color: theme.accentText, fontWeight: "800", fontSize: 16 },
});
