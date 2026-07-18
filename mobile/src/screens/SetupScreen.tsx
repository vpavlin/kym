// Setup / seed. One tap seeds a meaningful demo budget so balances are non-trivial;
// or add your own account/category. Also the reset. Nothing here is special — it
// just emits the same account.create / category.create events the desktop uses.
import React, { useState } from "react";
import {
  Alert,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { useBudget } from "../state/BudgetContext";
import { fromMilli, toMilli } from "../lib/engine";
import { GROUP_EVERYDAY } from "../lib/budget";
import { theme } from "../ui/theme";

const ACCOUNT_TYPES = ["checking", "savings", "cash", "creditCard"];

export function SetupScreen() {
  const { state, seedDemo, resetAll, addAccount, addCategory, events } = useBudget();

  const [acctName, setAcctName] = useState("");
  const [acctType, setAcctType] = useState("checking");
  const [acctStart, setAcctStart] = useState("");

  const [catName, setCatName] = useState("");
  const [catGroup, setCatGroup] = useState<string>(GROUP_EVERYDAY);

  const groups = state.groups;
  const alreadySeeded = state.accounts.length > 0;

  return (
    <ScrollView style={styles.root} contentContainerStyle={{ paddingBottom: 40 }}>
      <Text style={styles.title}>Setup</Text>
      <Text style={styles.sub}>
        {events.length} events in the local log · {state.accounts.length} accounts ·{" "}
        {state.categories.length} categories
      </Text>

      <Pressable style={styles.primary} onPress={seedDemo}>
        <Text style={styles.primaryText}>
          {alreadySeeded ? "Seed demo budget again" : "Seed demo budget"}
        </Text>
      </Pressable>
      <Text style={styles.note}>
        Adds a Checking + Cash account ($290 total), two groups, six categories, and this
        month's assignments — so Ready to Assign and envelopes are meaningful immediately.
      </Text>

      {/* Add account. */}
      <Text style={styles.section}>Add account</Text>
      <View style={styles.card}>
        <TextInput
          style={styles.input}
          placeholder="Account name"
          placeholderTextColor={theme.textDim}
          value={acctName}
          onChangeText={setAcctName}
        />
        <View style={styles.chipRow}>
          {ACCOUNT_TYPES.map((t) => (
            <Pressable
              key={t}
              style={[styles.chip, acctType === t && styles.chipActive]}
              onPress={() => setAcctType(t)}
            >
              <Text style={[styles.chipText, acctType === t && styles.chipTextActive]}>{t}</Text>
            </Pressable>
          ))}
        </View>
        <TextInput
          style={styles.input}
          placeholder="Starting balance (e.g. 250.00)"
          placeholderTextColor={theme.textDim}
          keyboardType="decimal-pad"
          value={acctStart}
          onChangeText={setAcctStart}
        />
        <Pressable
          style={styles.secondary}
          onPress={async () => {
            if (!acctName.trim()) return Alert.alert("Name required");
            await addAccount(acctName.trim(), acctType, toMilli(acctStart || "0"));
            setAcctName("");
            setAcctStart("");
          }}
        >
          <Text style={styles.secondaryText}>Add account</Text>
        </Pressable>
      </View>

      {/* Add category. */}
      <Text style={styles.section}>Add category</Text>
      <View style={styles.card}>
        <TextInput
          style={styles.input}
          placeholder="Category name"
          placeholderTextColor={theme.textDim}
          value={catName}
          onChangeText={setCatName}
        />
        {groups.length > 0 ? (
          <View style={styles.chipRow}>
            {groups.map((g) => (
              <Pressable
                key={g.id}
                style={[styles.chip, catGroup === g.id && styles.chipActive]}
                onPress={() => setCatGroup(g.id)}
              >
                <Text style={[styles.chipText, catGroup === g.id && styles.chipTextActive]}>
                  {g.name}
                </Text>
              </Pressable>
            ))}
          </View>
        ) : (
          <Text style={styles.note}>Seed the demo budget first to create groups.</Text>
        )}
        <Pressable
          style={styles.secondary}
          onPress={async () => {
            if (!catName.trim()) return Alert.alert("Name required");
            if (groups.length === 0) return Alert.alert("Seed a budget first (needs a group)");
            await addCategory(catName.trim(), catGroup);
            setCatName("");
          }}
        >
          <Text style={styles.secondaryText}>Add category</Text>
        </Pressable>
      </View>

      {/* Danger zone. */}
      <Text style={styles.section}>Reset</Text>
      <Pressable
        style={styles.danger}
        onPress={() =>
          Alert.alert("Reset everything?", "Deletes the local event log on this device.", [
            { text: "Cancel", style: "cancel" },
            { text: "Reset", style: "destructive", onPress: () => resetAll() },
          ])
        }
      >
        <Text style={styles.dangerText}>Erase local event log</Text>
      </Pressable>
      <Text style={styles.note}>
        Assets total ${fromMilli(
          state.accounts
            .filter((a) => a.onBudget && ["checking", "savings", "cash"].includes(a.type))
            .reduce((s, a) => s + (state.balances[a.id] ?? 0), 0)
        )}.
      </Text>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, paddingHorizontal: 16 },
  title: { color: theme.text, fontSize: 24, fontWeight: "800", marginTop: 12 },
  sub: { color: theme.textDim, marginTop: 4, marginBottom: 16 },
  section: { color: theme.text, fontSize: 15, fontWeight: "800", marginTop: 24, marginBottom: 8 },
  card: {
    backgroundColor: theme.surface,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: theme.border,
    padding: 14,
    gap: 12,
  },
  input: {
    backgroundColor: theme.surfaceAlt,
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 12,
    color: theme.text,
    fontSize: 16,
  },
  chipRow: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  chip: {
    paddingHorizontal: 12,
    paddingVertical: 7,
    borderRadius: 999,
    backgroundColor: theme.surfaceAlt,
    borderWidth: 1,
    borderColor: theme.border,
  },
  chipActive: { backgroundColor: theme.accent, borderColor: theme.accent },
  chipText: { color: theme.textDim, fontWeight: "600", fontSize: 13 },
  chipTextActive: { color: theme.accentText },
  primary: {
    backgroundColor: theme.accent,
    borderRadius: 12,
    paddingVertical: 16,
    alignItems: "center",
    marginTop: 4,
  },
  primaryText: { color: theme.accentText, fontWeight: "800", fontSize: 16 },
  secondary: {
    backgroundColor: theme.surfaceAlt,
    borderRadius: 10,
    paddingVertical: 13,
    alignItems: "center",
  },
  secondaryText: { color: theme.text, fontWeight: "700" },
  danger: {
    backgroundColor: theme.surface,
    borderRadius: 12,
    paddingVertical: 14,
    alignItems: "center",
    borderWidth: 1,
    borderColor: theme.danger,
  },
  dangerText: { color: theme.danger, fontWeight: "700" },
  note: { color: theme.textDim, fontSize: 12, marginTop: 10, lineHeight: 18 },
});
