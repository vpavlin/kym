// Setup / seed. One tap seeds a meaningful demo budget so balances are non-trivial;
// or add your own account/category. Also the reset. Nothing here is special — it
// just emits the same account.create / category.create events the desktop uses.
import React, { useMemo, useState } from "react";
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
import { formatMoney, toMilli, CURRENCIES } from "../lib/engine";
import { theme } from "../ui/theme";

const ACCOUNT_TYPES = ["checking", "savings", "cash", "creditCard", "tracking"];
const CURRENCY_CODES = Object.keys(CURRENCIES);

export function SetupScreen() {
  const {
    state,
    seedDemo,
    resetAll,
    addAccount,
    addCategory,
    deleteCategory,
    archiveCategory,
    unarchiveCategory,
    deviceId,
    syncStatus,
    peerInfo,
    storeInfo,
    events,
    budgetCurrency,
    setBudgetCurrency,
    authorName,
    setAuthorName,
    currentBudgetColor,
    syncError,
    reconnect,
    syncNow,
    rxInfo,
  } = useBudget();
  const styles = useMemo(() => makeStyles(currentBudgetColor), [currentBudgetColor]);

  const [nameInput, setNameInput] = useState(authorName);

  const [acctName, setAcctName] = useState("");
  const [acctType, setAcctType] = useState("checking");
  const [acctStart, setAcctStart] = useState("");
  const [acctCurrency, setAcctCurrency] = useState(budgetCurrency);

  const [catName, setCatName] = useState("");
  const [catGroup, setCatGroup] = useState<string>("Everyday");  // group NAME, not id

  const groups = state.groups;
  const alreadySeeded = state.accounts.length > 0;
  const hasAccounts = state.accounts.length > 0;

  // A category with any assignment/move/txn history can't be deleted (would orphan
  // money) — it's archived instead (hidden, kept). Mirrors the desktop rule.
  const catHasHistory = (id: string) =>
    events.some((e) => {
      const p: any = e.payload;
      return (
        (e.type === "assign" && p?.categoryId === id) ||
        (e.type === "move" && (p?.fromCategoryId === id || p?.toCategoryId === id)) ||
        (e.type === "txn.create" && p?.categoryId === id) ||
        (Array.isArray(p?.splits) && p.splits.some((s: any) => s?.categoryId === id))
      );
    });

  const onRemoveCategory = (c: { id: string; name: string }) => {
    if (catHasHistory(c.id)) {
      Alert.alert(
        `Archive "${c.name}"?`,
        "It has history, so it's hidden (not deleted). Its Available must be 0 first.",
        [
          { text: "Cancel", style: "cancel" },
          {
            text: "Archive",
            onPress: async () => {
              try {
                await archiveCategory(c.id);
              } catch (e: any) {
                Alert.alert("Couldn't archive", e?.message ?? String(e));
              }
            },
          },
        ]
      );
    } else {
      Alert.alert(`Delete "${c.name}"?`, "This category has no history.", [
        { text: "Cancel", style: "cancel" },
        {
          text: "Delete",
          style: "destructive",
          onPress: async () => {
            try {
              await deleteCategory(c.id);
            } catch (e: any) {
              Alert.alert("Couldn't delete", e?.message ?? String(e));
            }
          },
        },
      ]);
    }
  };

  const activeCats = state.categories.filter((c) => !c.archived && !c.hidden);
  const archivedCats = state.categories.filter((c) => c.archived);

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
        Adds a Checking + Cash account (47 000 Kč on-budget) plus a EUR Revolut tracking
        account (500,00 €), two groups, six categories, and this month's assignments — so
        Ready to Assign and envelopes are meaningful immediately, in the CZK + foreign model.
      </Text>

      {/* Budget currency — the single currency envelopes and Ready to Assign are in. */}
      <Text style={styles.section}>Budget currency</Text>
      <View style={styles.card}>
        <View style={styles.chipRow}>
          {CURRENCY_CODES.map((code) => (
            <Pressable
              key={code}
              disabled={hasAccounts}
              style={[
                styles.chip,
                budgetCurrency === code && styles.chipActive,
                hasAccounts && budgetCurrency !== code && styles.chipDisabled,
              ]}
              onPress={() => setBudgetCurrency(code)}
            >
              <Text
                style={[styles.chipText, budgetCurrency === code && styles.chipTextActive]}
              >
                {code}
              </Text>
            </Pressable>
          ))}
        </View>
        <Text style={styles.note}>
          {hasAccounts
            ? `Locked to ${budgetCurrency} while accounts exist. Reset to change it. Foreign money lives in off-budget tracking accounts.`
            : "One currency for the whole budget (default CZK). Foreign money lives in off-budget tracking accounts."}
        </Text>
      </View>

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
        <View style={styles.chipRow}>
          {CURRENCY_CODES.map((code) => (
            <Pressable
              key={code}
              style={[styles.chip, acctCurrency === code && styles.chipActive]}
              onPress={() => setAcctCurrency(code)}
            >
              <Text style={[styles.chipText, acctCurrency === code && styles.chipTextActive]}>
                {code}
              </Text>
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
        <Text style={styles.note}>
          On-budget accounts must be in {budgetCurrency}. For a foreign-currency account,
          pick type "tracking" (off-budget, shown in its own currency).
        </Text>
        <Pressable
          style={styles.secondary}
          onPress={async () => {
            if (!acctName.trim()) return Alert.alert("Name required");
            try {
              await addAccount(
                acctName.trim(),
                acctType,
                toMilli(acctStart || "0"),
                acctCurrency
              );
            } catch (e: any) {
              return Alert.alert("Can't add account", e?.message ?? String(e));
            }
            setAcctName("");
            setAcctStart("");
            setAcctCurrency(budgetCurrency);
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
        {/* Group is a NAME the user can type — the category's group is created on
            the fly if it doesn't exist yet (no need to seed a budget first). The
            chips are quick-fills for groups that already exist. This is the
            category "group" (Bills / Everyday), NOT the household "group budget"
            below — two different things that used to be confusingly conflated. */}
        <TextInput
          style={styles.input}
          placeholder="Group (e.g. Everyday, Bills)"
          placeholderTextColor={theme.textDim}
          value={catGroup}
          onChangeText={setCatGroup}
          autoCapitalize="words"
        />
        {groups.length > 0 && (
          <View style={styles.chipRow}>
            {groups.map((g) => (
              <Pressable
                key={g.id}
                style={[styles.chip, catGroup === g.name && styles.chipActive]}
                onPress={() => setCatGroup(g.name)}
              >
                <Text style={[styles.chipText, catGroup === g.name && styles.chipTextActive]}>
                  {g.name}
                </Text>
              </Pressable>
            ))}
          </View>
        )}
        <Pressable
          style={styles.secondary}
          onPress={async () => {
            if (!catName.trim()) return Alert.alert("Name required");
            await addCategory(catName.trim(), catGroup.trim() || "Everyday");
            setCatName("");
          }}
        >
          <Text style={styles.secondaryText}>Add category</Text>
        </Pressable>
      </View>

      {/* Manage categories — delete (history-free) or archive (with history). */}
      {(activeCats.length > 0 || archivedCats.length > 0) && (
        <>
          <Text style={styles.section}>Manage categories</Text>
          <View style={styles.card}>
            {activeCats.map((c) => (
              <View key={c.id} style={styles.rowBetween}>
                <Text style={styles.rowText}>{c.name}</Text>
                <Pressable style={styles.rowAction} onPress={() => onRemoveCategory(c)}>
                  <Text style={styles.rowActionText}>
                    {catHasHistory(c.id) ? "Archive" : "Delete"}
                  </Text>
                </Pressable>
              </View>
            ))}
            {activeCats.length === 0 && (
              <Text style={styles.note}>No active categories.</Text>
            )}
            {archivedCats.length > 0 && (
              <>
                <Text style={[styles.note, { marginTop: 12, fontWeight: "700" }]}>
                  Archived ({archivedCats.length})
                </Text>
                {archivedCats.map((c) => (
                  <View key={c.id} style={styles.rowBetween}>
                    <Text style={[styles.rowText, { color: theme.textDim }]}>{c.name}</Text>
                    <Pressable
                      style={styles.rowAction}
                      onPress={async () => {
                        try {
                          await unarchiveCategory(c.id);
                        } catch (e: any) {
                          Alert.alert("Couldn't restore", e?.message ?? String(e));
                        }
                      }}
                    >
                      <Text style={styles.rowActionText}>Un-archive</Text>
                    </Pressable>
                  </View>
                ))}
              </>
            )}
          </View>
        </>
      )}

      {/* Your name — attribution stamped on transactions you add (shared budgets). */}
      <Text style={styles.section}>Your name</Text>
      <View style={styles.card}>
        <Text style={styles.note}>
          Stamped on transactions you add, so a shared budget shows who did what.
          Leave empty for no attribution.
        </Text>
        <TextInput
          style={styles.input}
          placeholder="e.g. Vašek"
          placeholderTextColor={theme.textDim}
          value={nameInput}
          onChangeText={setNameInput}
          autoCapitalize="words"
        />
        <Pressable
          style={styles.secondary}
          onPress={async () => {
            await setAuthorName(nameInput.trim());
            Alert.alert("Saved", nameInput.trim() ? `Attributing to “${nameInput.trim()}”.` : "Attribution turned off.");
          }}
        >
          <Text style={styles.secondaryText}>Save name</Text>
        </Pressable>
      </View>

      {/* Sync & this device. Group membership/roles were removed: in the current
          model, sharing a budget's code grants full access to it (any member can
          read/write) — real per-member group management will come from libchat. */}
      <Text style={styles.section}>Sync &amp; device</Text>
      <View style={styles.card}>
        <Text style={styles.note}>This device's id: {deviceId}</Text>
        {/* Connectivity. Relay node: "syncing" means the mesh is up; the peer count
            is how many nodes we're connected to. */}
        <Text style={styles.note}>
          Sync: {syncStatus}
          {peerInfo
            ? ` · ${peerInfo.peers} ${peerInfo.peers === 1 ? "peer" : "peers"}` +
              (peerInfo.mesh > 0 ? ` · mesh ${peerInfo.mesh}` : "")
            : ""}
        </Text>
        {peerInfo ? (
          <Text style={styles.note}>
            Shard: {peerInfo.shard} (desktop is on 2/7 — they must match)
          </Text>
        ) : null}
        {/* Received-message counters: seen = arrived over the mesh, opened = decrypted
            with one of our budget keys. seen 0 → nothing is reaching us (no peer on
            this budget's topic, or the mesh isn't delivering). */}
        <Text style={styles.note}>
          Sent: {rxInfo.sent} · raw: {rxInfo.raw} · payload: {rxInfo.seen} · ours: {rxInfo.opened}
        </Text>
        {/* Store-pull outcome: msg = messages the fleet store returned, ev = those
            that decrypted as our events. If this stays "0 msg", the fleet isn't
            retaining our shard and history must come from a live peer instead. */}
        <Text style={[styles.note, { fontFamily: "monospace", fontSize: 10 }]} numberOfLines={3}>
          {storeInfo}
        </Text>
        {rxInfo.raw > 0 && rxInfo.opened === 0 && rxInfo.sample ? (
          <Text style={[styles.note, { fontFamily: "monospace", fontSize: 10 }]} numberOfLines={3}>
            {rxInfo.sample}
          </Text>
        ) : null}
        {syncError ? (
          <Text style={[styles.note, { color: theme.warn }]}>{syncError}</Text>
        ) : null}
        <View style={{ flexDirection: "row", gap: 8, marginTop: 8 }}>
          <Pressable
            style={[styles.primary, { flex: 1, marginTop: 0 }]}
            onPress={async () => {
              await syncNow();
              Alert.alert("Sync requested", "Asked peers to re-send this budget and re-shared ours. Watch the “Received” counter.");
            }}
          >
            <Text style={styles.primaryText}>Sync now</Text>
          </Pressable>
          <Pressable style={[styles.secondary, { flex: 1, marginTop: 0 }]} onPress={() => reconnect()}>
            <Text style={styles.secondaryText}>Reconnect</Text>
          </Pressable>
        </View>
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
        On-budget assets total {formatMoney(
          state.accounts
            .filter((a) => a.onBudget && ["checking", "savings", "cash"].includes(a.type))
            .reduce((s, a) => s + (state.balances[a.id] ?? 0), 0),
          budgetCurrency
        )}.
      </Text>
    </ScrollView>
  );
}

const makeStyles = (accent: string) =>
  StyleSheet.create({
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
  chipActive: { backgroundColor: accent, borderColor: accent },
  chipDisabled: { opacity: 0.4 },
  chipText: { color: theme.textDim, fontWeight: "600", fontSize: 13 },
  chipTextActive: { color: theme.accentText },
  chipSm: {
    paddingHorizontal: 9,
    paddingVertical: 5,
    borderRadius: 999,
    backgroundColor: theme.surfaceAlt,
    borderWidth: 1,
    borderColor: theme.border,
  },
  chipTextSm: { color: theme.textDim, fontWeight: "600", fontSize: 11 },
  memberRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingVertical: 8,
    borderTopWidth: 1,
    borderTopColor: theme.border,
    flexWrap: "wrap",
  },
  memberName: { color: theme.text, fontWeight: "700", fontSize: 14 },
  memberMeta: { color: theme.textDim, fontSize: 11, marginTop: 2 },
  primary: {
    backgroundColor: accent,
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
  rowBetween: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingVertical: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: theme.border,
  },
  rowText: { color: theme.text, fontSize: 15, flex: 1 },
  rowAction: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: theme.border,
  },
  rowActionText: { color: accent, fontWeight: "700", fontSize: 13 },
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
