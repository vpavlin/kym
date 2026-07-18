// KYM mobile — thin capture companion. A tiny hand-rolled tab shell (no nav lib)
// keeps the dependency surface minimal; the default tab is Add (capture), because
// the whole point is "amount in under 10 seconds".
import React, { useState } from "react";
import {
  ActivityIndicator,
  Pressable,
  SafeAreaView,
  StatusBar,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { BudgetProvider, useBudget } from "./src/state/BudgetContext";
import { CaptureScreen } from "./src/screens/CaptureScreen";
import { BudgetScreen } from "./src/screens/BudgetScreen";
import { ReviewScreen } from "./src/screens/ReviewScreen";
import { SetupScreen } from "./src/screens/SetupScreen";
import { PairingScreen } from "./src/screens/PairingScreen";
import { theme } from "./src/ui/theme";

type Tab = "add" | "budget" | "review" | "setup" | "pair";

const TABS: { key: Tab; label: string; icon: string }[] = [
  { key: "add", label: "Add", icon: "＋" },
  { key: "budget", label: "Budget", icon: "▤" },
  { key: "review", label: "Review", icon: "☰" },
  { key: "setup", label: "Setup", icon: "⚙" },
  { key: "pair", label: "Pair", icon: "⧉" },
];

function Shell() {
  const { ready } = useBudget();
  const [tab, setTab] = useState<Tab>("add");

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
      <View style={styles.content}>
        {tab === "add" && <CaptureScreen goSetup={() => setTab("setup")} />}
        {tab === "budget" && <BudgetScreen />}
        {tab === "review" && <ReviewScreen />}
        {tab === "setup" && <SetupScreen />}
        {tab === "pair" && <PairingScreen />}
      </View>
      <View style={styles.tabbar}>
        {TABS.map((t) => (
          <Pressable key={t.key} style={styles.tab} onPress={() => setTab(t.key)}>
            <Text style={[styles.tabIcon, tab === t.key && styles.tabActive]}>{t.icon}</Text>
            <Text style={[styles.tabLabel, tab === t.key && styles.tabActive]}>{t.label}</Text>
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
      <View style={styles.header}>
        <Text style={styles.brand}>KYM</Text>
        <Text style={styles.brandSub}>Know Your Money · offline</Text>
      </View>
      <BudgetProvider>
        <Shell />
      </BudgetProvider>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: theme.bg },
  header: {
    paddingHorizontal: 16,
    paddingTop: 8,
    paddingBottom: 4,
    flexDirection: "row",
    alignItems: "baseline",
    gap: 10,
  },
  brand: { color: theme.accent, fontSize: 20, fontWeight: "900", letterSpacing: 2 },
  brandSub: { color: theme.textDim, fontSize: 12 },
  body: { flex: 1 },
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
