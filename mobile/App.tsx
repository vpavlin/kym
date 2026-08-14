// KYM mobile — thin capture companion. A tiny hand-rolled tab shell (no nav lib)
// keeps the dependency surface minimal; the default tab is Add (capture), because
// the whole point is "amount in under 10 seconds".
import React, { useEffect, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  BackHandler,
  Modal,
  Platform,
  Pressable,
  SafeAreaView,
  StatusBar,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { CameraView, useCameraPermissions } from "expo-camera";
import { BudgetProvider, useBudget } from "./src/state/BudgetContext";
import { CaptureScreen } from "./src/screens/CaptureScreen";
import { BudgetScreen } from "./src/screens/BudgetScreen";
import { ReviewScreen } from "./src/screens/ReviewScreen";
import { SetupScreen } from "./src/screens/SetupScreen";
import { PairingScreen } from "./src/screens/PairingScreen";
import { theme } from "./src/ui/theme";
import { usingServiceBackend, serviceNodeDown, serviceAwaitingApproval, launchSharedService, refreshPeerInfo } from "./src/lib/loam-transport";

type Tab = "add" | "budget" | "review" | "setup" | "pair";

const TABS: { key: Tab; label: string; icon: string }[] = [
  { key: "add", label: "Add", icon: "＋" },
  { key: "budget", label: "Budget", icon: "▤" },
  { key: "review", label: "Review", icon: "☰" },
  { key: "setup", label: "Setup", icon: "⚙" },
  { key: "pair", label: "Share", icon: "⧉" },
];

// Tiny dot + label reflecting the Delivery sync state. Minimal on purpose.
const SYNC_COLOR: Record<string, string> = {
  syncing: "#3fb950",
  connecting: theme.accent,
  "not paired": theme.textDim,
  offline: theme.textDim,
};

function SyncIndicator() {
  const { syncStatus } = useBudget();
  return (
    <View style={styles.sync}>
      <View style={[styles.syncDot, { backgroundColor: SYNC_COLOR[syncStatus] ?? theme.textDim }]} />
      <Text style={styles.syncText}>{syncStatus}</Text>
    </View>
  );
}

// Always-visible budget switcher: the current budget as a colored pill (so you
// always know which household you're in — the #1 multi-budget UX rule), tap to
// switch or create. Mirrors the desktop's colored switcher.
function BudgetSwitcher() {
  const { budgets, currentBudgetId, currentBudgetName, currentBudgetColor, selectBudget, createBudget, joinBudget, deleteBudget } =
    useBudget();
  const [open, setOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [joining, setJoining] = useState(false);
  const [name, setName] = useState("");
  const [joinName, setJoinName] = useState("");
  const [joinCode, setJoinCode] = useState("");
  const [scanning, setScanning] = useState(false);
  const [permission, requestPermission] = useCameraPermissions();

  if (budgets.length === 0) return null;

  const closeAll = () => {
    setOpen(false); setCreating(false); setJoining(false);
    setName(""); setJoinName(""); setJoinCode("");
  };

  const doCreate = async () => {
    const n = name.trim();
    if (!n) return;
    await createBudget(n);
    closeAll();
  };

  // Join an existing budget from a scanned/pasted code. The code carries the
  // household key; the budget then syncs from scratch.
  const doJoin = async (rawCode?: string) => {
    const code = (rawCode ?? joinCode).trim();
    if (!code) return Alert.alert("Code needed", "Scan or paste the budget's pairing code / kym://pair link.");
    try {
      await joinBudget(joinName.trim() || "Shared budget", code);
      closeAll();
    } catch (e: any) {
      Alert.alert("Couldn't join", e?.message ?? String(e));
    }
  };

  const openScanner = async () => {
    if (!permission?.granted) {
      const res = await requestPermission();
      if (!res.granted) return Alert.alert("Camera needed", "Allow camera to scan the QR, or paste the code.");
    }
    setScanning(true);
  };

  // Delete a budget — strong confirmation (it forgets the household key locally).
  const confirmDelete = (b: { id: string; name: string }) => {
    Alert.alert(
      `Delete “${b.name}”?`,
      "This removes the budget and its household key FROM THIS DEVICE. If it's shared, other devices keep their copy — you'd re-join with its code to get it back here. This can't be undone.",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Delete",
          style: "destructive",
          onPress: async () => {
            try {
              await deleteBudget(b.id);
            } catch (e: any) {
              Alert.alert("Couldn't delete", e?.message ?? String(e));
            }
          },
        },
      ]
    );
  };

  return (
    <>
      <Pressable style={[styles.pill, { borderColor: currentBudgetColor }]} onPress={() => setOpen(true)}>
        <View style={[styles.pillDot, { backgroundColor: currentBudgetColor }]} />
        <Text style={styles.pillText} numberOfLines={1}>
          {currentBudgetName}
        </Text>
        <Text style={styles.pillCaret}>▾</Text>
      </Pressable>

      <Modal visible={open} transparent animationType="fade" onRequestClose={closeAll}>
        <Pressable style={styles.switchBackdrop} onPress={closeAll}>
          <Pressable style={styles.switchSheet} onPress={() => {}}>
            <Text style={styles.switchTitle}>Budgets</Text>
            {budgets.map((b) => (
              <View key={b.id} style={styles.switchRow}>
                <Pressable
                  style={{ flexDirection: "row", alignItems: "center", gap: 10, flex: 1 }}
                  onPress={async () => {
                    await selectBudget(b.id);
                    closeAll();
                  }}
                >
                  <View style={[styles.pillDot, { backgroundColor: b.color }]} />
                  <Text style={styles.switchRowText}>{b.name}</Text>
                  {b.id === currentBudgetId ? <Text style={[styles.switchCheck, { color: currentBudgetColor }]}>✓</Text> : null}
                </Pressable>
                {budgets.length > 1 ? (
                  <Pressable hitSlop={10} onPress={() => confirmDelete(b)} style={{ paddingHorizontal: 8 }}>
                    <Text style={{ color: theme.danger, fontSize: 18 }}>🗑</Text>
                  </Pressable>
                ) : null}
              </View>
            ))}

            {/* Create a fresh budget (you host it). */}
            {creating ? (
              <View style={styles.createRow}>
                <TextInput
                  style={styles.createInput}
                  placeholder="New budget name"
                  placeholderTextColor={theme.textDim}
                  value={name}
                  onChangeText={setName}
                  autoFocus
                  onSubmitEditing={doCreate}
                />
                <Pressable style={styles.createBtn} onPress={doCreate}>
                  <Text style={styles.createBtnText}>Create</Text>
                </Pressable>
              </View>
            ) : !joining ? (
              <Pressable style={styles.switchRow} onPress={() => { setCreating(true); setJoining(false); }}>
                <Text style={[styles.switchRowText, { color: currentBudgetColor }]}>＋  New budget</Text>
              </Pressable>
            ) : null}

            {/* Join an EXISTING budget by scanning its QR (Basecamp / another phone)
                or pasting its code — no create-then-share needed. */}
            {joining ? (
              <View style={{ gap: 8, paddingVertical: 8 }}>
                <TextInput
                  style={styles.joinInput}
                  placeholder="Name it on this device (optional)"
                  placeholderTextColor={theme.textDim}
                  value={joinName}
                  onChangeText={setJoinName}
                />
                <TextInput
                  style={styles.joinInput}
                  placeholder="pairing code / kym://pair?s=…"
                  placeholderTextColor={theme.textDim}
                  autoCapitalize="characters"
                  autoCorrect={false}
                  value={joinCode}
                  onChangeText={setJoinCode}
                />
                <View style={{ flexDirection: "row", gap: 8 }}>
                  <Pressable style={[styles.createBtn, { flex: 1, alignItems: "center" }]} onPress={openScanner}>
                    <Text style={styles.createBtnText}>Scan QR</Text>
                  </Pressable>
                  <Pressable style={[styles.createBtn, { flex: 1, alignItems: "center" }]} onPress={() => doJoin()}>
                    <Text style={styles.createBtnText}>Join</Text>
                  </Pressable>
                </View>
              </View>
            ) : !creating ? (
              <Pressable style={styles.switchRow} onPress={() => { setJoining(true); setCreating(false); }}>
                <Text style={[styles.switchRowText, { color: currentBudgetColor }]}>⤵  Join a budget</Text>
              </Pressable>
            ) : null}

            <Text style={styles.switchNote}>
              Each budget is its own household. “New” starts one you host; “Join” imports one
              shared from a Basecamp or another phone and syncs it from scratch.
            </Text>
          </Pressable>
        </Pressable>
      </Modal>

      {/* QR scanner for joining. A scanned kym://pair link joins directly. */}
      <Modal visible={scanning} animationType="slide" onRequestClose={() => setScanning(false)}>
        <View style={{ flex: 1, backgroundColor: "#000" }}>
          <CameraView
            style={StyleSheet.absoluteFill}
            facing="back"
            barcodeScannerSettings={{ barcodeTypes: ["qr"] }}
            onBarcodeScanned={(e) => {
              if (!scanning) return;
              setScanning(false);
              doJoin(e.data);
            }}
          />
          <Pressable
            style={{ position: "absolute", bottom: 44, alignSelf: "center", backgroundColor: currentBudgetColor, borderRadius: 10, paddingVertical: 13, paddingHorizontal: 40 }}
            onPress={() => setScanning(false)}
          >
            <Text style={{ color: theme.bg, fontWeight: "800" }}>Cancel</Text>
          </Pressable>
        </View>
      </Modal>
    </>
  );
}

// Header, rendered INSIDE the provider so the brand + switcher can follow the
// current budget's colour (the app's accent). Padded below the status bar.
function TopBar() {
  const { currentBudgetColor } = useBudget();
  return (
    <View style={styles.header}>
      <Text style={[styles.brand, { color: currentBudgetColor }]}>KYM</Text>
      <BudgetSwitcher />
      <View style={styles.headerSpacer} />
      <SyncIndicator />
    </View>
  );
}

function Shell() {
  const { ready, currentBudgetColor } = useBudget();
  // A small tab back-stack so the Android hardware back button walks back through
  // the tabs you visited (instead of exiting the app from any tab). `go` pushes a
  // tab unless it's already current; back pops; from the first tab, back exits.
  // Open modals capture back themselves (onRequestClose), so this only runs when
  // none is showing.
  const [history, setHistory] = useState<Tab[]>(["add"]);
  const [, setLdTick] = useState(0);
  useEffect(() => { const t = setInterval(() => { refreshPeerInfo().catch(() => {}); setLdTick((n) => n + 1); }, 3000); return () => clearInterval(t); }, []);
  const tab = history[history.length - 1];
  const go = (t: Tab) =>
    setHistory((h) => {
      if (h[h.length - 1] === t) return h; // already here
      const i = h.indexOf(t);
      // Revisiting a tab already in the stack collapses back to it, so the stack
      // never exceeds the number of distinct tabs and back stays predictable.
      return i >= 0 ? h.slice(0, i + 1) : [...h, t];
    });

  useEffect(() => {
    const onBack = () => {
      if (history.length > 1) {
        setHistory((h) => h.slice(0, -1));
        return true; // handled — don't exit the app
      }
      return false; // on the first tab → let the OS close the app
    };
    const sub = BackHandler.addEventListener("hardwareBackPress", onBack);
    return () => sub.remove();
  }, [history.length]);

  if (!ready) {
    return (
      <View style={styles.loading}>
        <ActivityIndicator color={theme.accent} size="large" />
        <Text style={styles.loadingText}>Loading local log…</Text>
      </View>
    );
  }

  return (
    <View style={styles.body}>
      {usingServiceBackend() && (serviceNodeDown() || serviceAwaitingApproval()) ? (
        <Pressable style={styles.ldBanner} onPress={() => launchSharedService()}>
          <Text style={styles.ldBannerIcon}>{serviceNodeDown() ? "\u26A0\uFE0F" : "\uD83D\uDD12"}</Text>
          <View style={{ flex: 1 }}>
            <Text style={styles.ldBannerT}>{serviceNodeDown() ? "Logos Delivery isn't running" : "KYM isn't approved yet"}</Text>
            <Text style={styles.ldBannerSub}>{serviceNodeDown() ? "Tap to open it — KYM can't sync until it's running." : "Tap to open Logos Delivery and approve KYM."}</Text>
          </View>
          <Text style={styles.ldBannerCta}>OPEN ›</Text>
        </Pressable>
      ) : null}
      <View style={styles.content}>
        {tab === "add" && <CaptureScreen goSetup={() => go("setup")} />}
        {tab === "budget" && <BudgetScreen />}
        {tab === "review" && <ReviewScreen />}
        {tab === "setup" && <SetupScreen />}
        {tab === "pair" && <PairingScreen />}
      </View>
      <View style={styles.tabbar}>
        {TABS.map((t) => (
          <Pressable key={t.key} style={styles.tab} onPress={() => go(t.key)}>
            <Text style={[styles.tabIcon, tab === t.key && { color: currentBudgetColor }]}>{t.icon}</Text>
            <Text style={[styles.tabLabel, tab === t.key && { color: currentBudgetColor }]}>{t.label}</Text>
          </Pressable>
        ))}
      </View>
    </View>
  );
}

export default function App() {
  return (
    <SafeAreaView style={styles.root}>
      <StatusBar barStyle="light-content" backgroundColor={theme.bg} />
      <BudgetProvider>
        <TopBar />
        <Shell />
      </BudgetProvider>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  // Pad below the Android status/notification bar (react-native's SafeAreaView
  // doesn't inset it on Android, so the header used to collide with it).
  root: {
    flex: 1,
    backgroundColor: theme.bg,
    paddingTop: Platform.OS === "android" ? StatusBar.currentHeight ?? 0 : 0,
  },
  header: {
    paddingHorizontal: 16,
    paddingTop: 8,
    paddingBottom: 4,
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
  },
  brand: { color: theme.accent, fontSize: 20, fontWeight: "900", letterSpacing: 2 },
  brandSub: { color: theme.textDim, fontSize: 12 },
  pill: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    maxWidth: 170,
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 999,
    borderWidth: 1,
    backgroundColor: theme.surface,
  },
  pillDot: { width: 9, height: 9, borderRadius: 5 },
  pillText: { color: theme.text, fontSize: 13, fontWeight: "700", flexShrink: 1 },
  pillCaret: { color: theme.textDim, fontSize: 10 },
  switchBackdrop: { flex: 1, backgroundColor: "#000a", justifyContent: "flex-start", paddingTop: 90, paddingHorizontal: 16 },
  switchSheet: { backgroundColor: theme.surfaceAlt, borderRadius: 16, padding: 14, borderWidth: 1, borderColor: theme.border },
  switchTitle: { color: theme.textDim, fontSize: 12, fontWeight: "800", marginBottom: 6, textTransform: "uppercase" },
  switchRow: { flexDirection: "row", alignItems: "center", gap: 10, paddingVertical: 12, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: theme.border },
  switchRowText: { color: theme.text, fontSize: 16, fontWeight: "600", flex: 1 },
  switchCheck: { color: theme.accent, fontWeight: "800" },
  switchNote: { color: theme.textDim, fontSize: 11, marginTop: 10, lineHeight: 16 },
  createRow: { flexDirection: "row", alignItems: "center", gap: 8, paddingVertical: 10 },
  createInput: { flex: 1, color: theme.text, backgroundColor: theme.surface, borderRadius: 10, borderWidth: 1, borderColor: theme.border, paddingHorizontal: 12, paddingVertical: 8 },
  // Join inputs live in a COLUMN, so no vertical flex (that squashed them). Full
  // width, fixed comfortable height.
  joinInput: { alignSelf: "stretch", minHeight: 44, color: theme.text, fontSize: 15, backgroundColor: theme.surface, borderRadius: 10, borderWidth: 1, borderColor: theme.border, paddingHorizontal: 12, paddingVertical: 10 },
  createBtn: { backgroundColor: theme.accent, borderRadius: 10, paddingHorizontal: 14, paddingVertical: 10 },
  createBtnText: { color: theme.accentText, fontWeight: "800" },
  headerSpacer: { flex: 1 },
  sync: { flexDirection: "row", alignItems: "center", gap: 5 },
  syncDot: { width: 8, height: 8, borderRadius: 4 },
  syncText: { color: theme.textDim, fontSize: 11 },
  body: { flex: 1 },
  ldBanner: { flexDirection: "row", alignItems: "center", gap: 12, backgroundColor: "#c2410c", paddingVertical: 14, paddingHorizontal: 16 },
  ldBannerIcon: { fontSize: 24 },
  ldBannerT: { color: "#ffffff", fontSize: 15, fontWeight: "800" },
  ldBannerSub: { color: "#ffe3cf", fontSize: 12, marginTop: 2, lineHeight: 16 },
  ldBannerCta: { color: "#ffffff", fontSize: 14, fontWeight: "800" },
  content: { flex: 1 },
  loading: { flex: 1, alignItems: "center", justifyContent: "center", gap: 12 },
  loadingText: { color: theme.textDim },
  tabbar: {
    flexDirection: "row",
    borderTopWidth: 1,
    borderTopColor: theme.border,
    backgroundColor: theme.surface,
    paddingVertical: 8,
  },
  tab: { flex: 1, alignItems: "center", gap: 2 },
  tabIcon: { color: theme.textDim, fontSize: 18 },
  tabLabel: { color: theme.textDim, fontSize: 11, fontWeight: "600" },
  tabActive: { color: theme.accent },
});
