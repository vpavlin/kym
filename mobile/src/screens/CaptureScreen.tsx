// The one job: capture an expense in under 10 seconds. Amount-first, big custom
// keypad (no OS keyboard round-trip), amount is the ONLY required field. Account,
// date, cleared, category are all defaulted. One tap on Save appends a txn.create
// and the balances re-fold instantly — never blocks on anything.
import React, { useMemo, useState } from "react";
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import * as ImagePicker from "expo-image-picker";
import { useBudget } from "../state/BudgetContext";
import { formatMoney, suggestCategory } from "../lib/engine";
import { DEFAULT_ACCOUNT } from "../lib/budget";
import { recognizeReceipt } from "../lib/ocr";
import { guessCategory } from "../lib/categoryGuess";
import { theme } from "../ui/theme";

const KEYS = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "clr", "0", "del"];

// ISO "YYYY-MM-DD" (from the OCR heuristics) -> ms epoch for the txn date. Parsed
// as local noon so a timezone offset can't roll it to the previous day. Falls
// back to "now" if the string is somehow unparseable.
function isoToEpoch(iso: string): number {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!m) return Date.now();
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 12, 0, 0);
  const t = d.getTime();
  return Number.isFinite(t) ? t : Date.now();
}

export function CaptureScreen({ goSetup }: { goSetup: () => void }) {
  const { state, events, addExpense, budgetCurrency } = useBudget();
  const [cents, setCents] = useState(0); // ATM-style entry: digits shift in from the right
  const [accountId, setAccountId] = useState<string | null>(null);
  const [categoryId, setCategoryId] = useState<string | null>(null);
  const [cleared, setCleared] = useState(false);
  const [flash, setFlash] = useState<string | null>(null);
  // Optional payee for a manual capture. If typed, we offer a learned category as
  // the default (pre-selected, always overridable) and stash it as the memo.
  const [payee, setPayee] = useState("");
  // Receipt-scan state. All of it is an editable PREFILL — the user confirms the
  // amount on the keypad and can retap category/account before Save.
  const [scanBusy, setScanBusy] = useState(false);
  const [fromReceipt, setFromReceipt] = useState(false); // shows the "check it" hint
  const [receiptMemo, setReceiptMemo] = useState<string | null>(null); // merchant
  const [receiptDate, setReceiptDate] = useState<number | null>(null); // ms epoch

  const accounts = state.accounts.filter((a) => !a.closed);
  const categories = state.categories.filter((c) => !c.hidden);

  // Clear any stashed receipt prefill (merchant/date/from-receipt hint). The
  // amount + category the user sees stay put; this just drops the OCR provenance.
  const clearReceipt = () => {
    setFromReceipt(false);
    setReceiptMemo(null);
    setReceiptDate(null);
  };

  // Snap a receipt -> ML Kit OCR (on-device) -> editable prefill. Everything
  // degrades gracefully: no permission, cancel, missing native module, or no text
  // found all fall back to plain manual entry.
  const scanReceipt = async () => {
    if (scanBusy) return;
    setFlash(null);
    try {
      const perm = await ImagePicker.requestCameraPermissionsAsync();
      let result: ImagePicker.ImagePickerResult;
      if (perm.granted) {
        result = await ImagePicker.launchCameraAsync({
          mediaTypes: ["images"],
          quality: 1,
          allowsEditing: false,
        });
      } else {
        // No camera permission — let the user pick an existing receipt photo.
        result = await ImagePicker.launchImageLibraryAsync({
          mediaTypes: ["images"],
          quality: 1,
        });
      }
      if (result.canceled || !result.assets?.length) return;
      const uri = result.assets[0].uri;

      setScanBusy(true);
      const fields = await recognizeReceipt(uri);

      if (fields.amount && fields.amount > 0) {
        // cents = milliunits / 10 (1 cent = 10 milli). Cap mirrors the keypad.
        setCents(Math.min(Math.round(fields.amount / 10), 9_999_999));
      }
      setReceiptMemo(fields.merchant ?? null);
      setReceiptDate(fields.date ? isoToEpoch(fields.date) : null);

      // Prefill category. HISTORY FIRST: how has the user categorized this
      // merchant before? suggestCategory returns a real category id already, so
      // use it directly. Only if that yields nothing do we fall back to the static
      // keyword map (guessCategory), mapping its category NAME to a real id. Either
      // way we only prefill when the user hasn't already picked a category.
      if (categoryId === null) {
        const merchant = fields.merchant ?? "";
        // Match both fields: imported bank rows carry payeeId, app-native captures
        // store the merchant in memo — pass merchant as both so history matches either.
        const learned = suggestCategory(events, { payee: merchant, memo: merchant });
        if (learned) {
          setCategoryId(learned.categoryId);
        } else {
          const guessName = guessCategory(merchant + " " + (fields.rawText ?? ""));
          if (guessName) {
            const match = categories.find(
              (c) => c.name.toLowerCase() === guessName.toLowerCase()
            );
            if (match) setCategoryId(match.id);
          }
        }
      }

      if (fields.amount || fields.merchant || fields.date) {
        setFromReceipt(true);
      } else {
        setFlash("No text found — enter it manually.");
        setTimeout(() => setFlash(null), 2200);
      }
    } catch {
      // Native module absent (emulator/no arm64 libs), camera unavailable, etc.
      setFlash("Couldn't scan — enter it manually.");
      setTimeout(() => setFlash(null), 2200);
    } finally {
      setScanBusy(false);
    }
  };

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

  // Manual capture: when the user finishes typing a payee, offer a learned
  // category as the default. Non-intrusive — only pre-selects when nothing is
  // chosen yet, and the user can still tap any chip to override.
  const suggestFromPayee = () => {
    const p = payee.trim();
    if (!p || categoryId !== null) return;
    const learned = suggestCategory(events, { payee: p, memo: p });
    if (learned) setCategoryId(learned.categoryId);
  };

  const canSave = amountMilli > 0 && !!activeAccount;

  const save = async () => {
    if (!canSave || !activeAccount) return;
    await addExpense({
      amountMilli,
      accountId: activeAccount,
      categoryId,
      cleared: cleared ? "cleared" : "uncleared",
      // From a scanned receipt: use the receipt's date as the txn date and stash
      // the merchant as the memo. Both are undefined for a plain manual capture,
      // so the existing defaults (now / no memo) apply. Category was already
      // prefilled into `categoryId` and is overridable, so it rides along as-is.
      // Prefer the scanned merchant; else the manually typed payee. Undefined for
      // a plain capture (existing "no memo" default applies).
      memo: receiptMemo ?? (payee.trim() ? payee.trim() : undefined),
      date: receiptDate ?? undefined,
    });
    const acctName = accounts.find((a) => a.id === activeAccount)?.name ?? "account";
    const catName = categories.find((c) => c.id === categoryId)?.name ?? "Uncategorized";
    setFlash(`Saved ${formatMoney(amountMilli, activeCurrency)} · ${catName} · ${acctName}`);
    setCents(0);
    setCategoryId(null);
    setCleared(false);
    setPayee("");
    clearReceipt();
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
      ) : fromReceipt ? (
        <Text style={[styles.hint, styles.receiptHint]}>
          {receiptMemo ? `${receiptMemo} · ` : ""}from receipt — check it
        </Text>
      ) : (
        <Text style={styles.hint}>Type an amount — that's all you need.</Text>
      )}

      {/* Scan receipt: on-device OCR prefill. Falls back to manual entry if the
          camera/native module is unavailable or nothing is recognized. */}
      <Pressable
        style={({ pressed }) => [
          styles.scanBtn,
          pressed && styles.keyPressed,
          scanBusy && styles.saveDisabled,
        ]}
        onPress={scanReceipt}
        disabled={scanBusy}
      >
        {scanBusy ? (
          <ActivityIndicator color={theme.text} />
        ) : (
          <Text style={styles.scanBtnText}>⧉  Scan receipt</Text>
        )}
      </Pressable>

      {/* Optional payee. Typing one and moving on offers a learned category as
          the default (pre-selected below — always overridable). */}
      <TextInput
        style={styles.payeeInput}
        placeholder="Payee (optional)"
        placeholderTextColor={theme.textDim}
        value={payee}
        onChangeText={setPayee}
        onEndEditing={suggestFromPayee}
        onBlur={suggestFromPayee}
        returnKeyType="done"
        autoCapitalize="words"
      />

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
  amount: { color: theme.text, fontSize: 64, fontWeight: "800", letterSpacing: 1 },
  hint: { color: theme.textDim, textAlign: "center", marginTop: 4, minHeight: 20 },
  receiptHint: { color: theme.warn, fontWeight: "600" },
  scanBtn: {
    marginTop: 10,
    alignSelf: "center",
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    minWidth: 180,
    minHeight: 44,
    paddingVertical: 10,
    paddingHorizontal: 18,
    borderRadius: 12,
    backgroundColor: theme.surface,
    borderWidth: 1,
    borderColor: theme.border,
  },
  scanBtnText: { color: theme.text, fontSize: 15, fontWeight: "700" },
  payeeInput: {
    marginTop: 12,
    height: 44,
    paddingHorizontal: 14,
    borderRadius: 12,
    backgroundColor: theme.surface,
    borderWidth: 1,
    borderColor: theme.border,
    color: theme.text,
    fontSize: 15,
  },
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
