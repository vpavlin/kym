// Pairing — STUB (issue #3/#4). This screen generates a REAL 32-byte household
// secret and derives the REAL topic + 3-word fingerprint (ported from Perun's
// shipped pairing crypto, re-namespaced to `kym`), and renders the pairing QR.
//
// What is intentionally NOT here: any networking. There is no Delivery/Waku in
// Phase 2. Nothing is sent, subscribed, or synced. The QR + fingerprint are the
// UI + key material a later phase (liblogosdelivery, issue #4) will use to
// actually pair and sync devices. The secret is persisted in SecureStore so the
// same household key survives app restarts.
import React, { useEffect, useMemo, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { CameraView, useCameraPermissions } from "expo-camera";
import QRCode from "react-native-qrcode-svg";
import {
  deriveIdentity,
  encodeSecret,
  decodeSecret,
  groupCode,
  newSecret,
  pairingUri,
  topicFor,
} from "../lib/identity";
import {
  ensureSecret,
  saveSecret,
  getSecretB32,
  resetIdentityCache,
} from "../lib/identityStore";
import { refreshRoutes } from "../lib/delivery";
import { useBudget } from "../state/BudgetContext";
import { theme } from "../ui/theme";

// Strip a kym://pair?s=<code> deep link down to the raw base32 code (the URI
// prefix letters are base32-valid and would corrupt a lenient decode).
function extractCode(input: string): string {
  const s = input.trim();
  const i = s.indexOf("s=");
  return s.startsWith("kym://") && i >= 0 ? s.slice(i + 2) : s;
}

export function PairingScreen() {
  // Pairing operates on the CURRENT budget (each budget is its own household with
  // its own secret). Switching budgets on another tab re-derives this screen.
  const { currentBudgetId, currentBudgetName, currentBudgetColor, refreshBudgetColors } = useBudget();
  const styles = useMemo(() => makeStyles(currentBudgetColor), [currentBudgetColor]);
  const [loading, setLoading] = useState(true);
  const [secretB32, setSecretB32] = useState<string>("");
  const [joinCode, setJoinCode] = useState("");
  // Scanning the desktop's pairing QR — the only practical way to move a
  // 52-char code from Basecamp to a phone (typing it is error-prone).
  const [scanning, setScanning] = useState(false);
  const [permission, requestPermission] = useCameraPermissions();

  useEffect(() => {
    if (!currentBudgetId) return;
    let alive = true;
    (async () => {
      setLoading(true);
      // Ensure this budget has a household secret (generates one if brand new), then
      // read it back for display. Mirrors kym_core loadOrCreateSecret.
      await ensureSecret(currentBudgetId);
      const b32 = await getSecretB32(currentBudgetId);
      if (!alive) return;
      setSecretB32(b32 ?? "");
      setLoading(false);
    })();
    return () => {
      alive = false;
    };
  }, [currentBudgetId]);

  const regenerate = async () => {
    const s = newSecret();
    await saveSecret(currentBudgetId, s);
    resetIdentityCache(currentBudgetId);
    await refreshRoutes(); // subscribe the new topic on the live node
    await refreshBudgetColors(); // colour follows the new household
    setSecretB32(encodeSecret(s));
  };

  // Open the scanner, asking for the camera permission on first use.
  const openScanner = async () => {
    if (!permission?.granted) {
      const res = await requestPermission();
      if (!res.granted) {
        return Alert.alert("Camera needed", "Allow camera access to scan the pairing QR, or paste the code instead.");
      }
    }
    setScanning(true);
  };

  // A scanned QR carries the same kym://pair?s=<code> the typed field accepts,
  // so it goes through exactly one join path — no second code branch to drift.
  const onScanned = (data: string) => {
    if (!scanning) return;      // ignore the burst of frames after the first hit
    setScanning(false);
    join(data);
  };

  // Join another device's household from its pairing code (or kym://pair link).
  // Takes the raw text so the scanner and the paste field share this path.
  const join = async (raw?: string) => {
    const input = raw !== undefined ? raw : joinCode;
    let secret: Uint8Array;
    try {
      secret = decodeSecret(extractCode(input));      // throws if too short
    } catch {
      return Alert.alert("Invalid code", "Scan or paste the full pairing code (or the kym://pair link) shown on the other device.");
    }
    const b32 = encodeSecret(secret);                 // normalize to canonical form
    await saveSecret(currentBudgetId, secret);        // this budget now shares that household key
    resetIdentityCache(currentBudgetId);              // delivery re-derives the topic on next sync
    await refreshRoutes();                            // subscribe the joined topic on the live node
    await refreshBudgetColors();                      // colour now matches the joined household
    setSecretB32(b32);
    setJoinCode("");
    Alert.alert("Joined household", "Confirm the fingerprint above matches the other device.");
  };

  if (loading || !secretB32) {
    return (
      <View style={styles.center}>
        <ActivityIndicator color={currentBudgetColor} />
      </View>
    );
  }

  const secret = decodeSecret(secretB32);
  const id = deriveIdentity(secret);
  const uri = pairingUri(secret);
  const topic = topicFor(id, 0);

  return (
    <ScrollView style={styles.root} contentContainerStyle={{ paddingBottom: 40 }}>
      <View style={styles.stubBanner}>
        <Text style={styles.stubText}>
          This sets the shared 32-byte household key (real crypto). Live sync runs when the app
          is on a real device with the Delivery bridge; the code + fingerprint are wire-compatible
          with the desktop Basecamp app.
        </Text>
      </View>

      <Text style={styles.title}>Share “{currentBudgetName}”</Text>
      <Text style={styles.sub}>
        Show this QR (or the code below) on another device — your own laptop/phone, or a
        partner — to join THIS budget. They start empty and sync it from scratch. Each budget
        is shared separately; a device you don’t share a budget with never sees it.
      </Text>

      <View style={styles.qrCard}>
        <QRCode value={uri} size={220} backgroundColor="#ffffff" color="#000000" />
      </View>

      <Text style={styles.label}>Fingerprint (confirm it matches on both devices)</Text>
      <View style={styles.fpRow}>
        {id.fingerprint.map((w, i) => (
          <View key={i} style={styles.fpChip}>
            <Text style={styles.fpText}>{w}</Text>
          </View>
        ))}
      </View>

      <Text style={styles.label}>Pairing code</Text>
      <View style={styles.codeCard}>
        <Text style={styles.code}>{groupCode(secretB32)}</Text>
      </View>

      <Text style={styles.label}>Join another household</Text>
      <Text style={styles.sub}>
        Paste the code (or `kym://pair` link) shown on another device — including a Basecamp
        — to share its budget. Confirm the fingerprint matches afterward.
      </Text>
      <TextInput
        style={styles.joinInput}
        placeholder="pairing code / kym://pair?s=…"
        placeholderTextColor={theme.textDim}
        autoCapitalize="characters"
        autoCorrect={false}
        value={joinCode}
        onChangeText={setJoinCode}
      />
      <View style={styles.joinRow}>
        <Pressable style={[styles.joinBtn, styles.joinBtnFlex]} onPress={openScanner}>
          <Text style={styles.joinBtnText}>Scan QR</Text>
        </Pressable>
        <Pressable style={[styles.joinBtn, styles.joinBtnFlex]} onPress={() => join()}>
          <Text style={styles.joinBtnText}>Join household</Text>
        </Pressable>
      </View>

      <Modal visible={scanning} animationType="slide" onRequestClose={() => setScanning(false)}>
        <View style={styles.scanRoot}>
          <CameraView
            style={StyleSheet.absoluteFill}
            facing="back"
            barcodeScannerSettings={{ barcodeTypes: ["qr"] }}
            onBarcodeScanned={(e) => onScanned(e.data)}
          />
          <View style={styles.scanHint} pointerEvents="none">
            <Text style={styles.scanHintText}>Point at the pairing QR in Basecamp</Text>
          </View>
          <Pressable style={styles.scanCancel} onPress={() => setScanning(false)}>
            <Text style={styles.joinBtnText}>Cancel</Text>
          </Pressable>
        </View>
      </Modal>

      <Text style={styles.label}>Derived household topic</Text>
      <View style={styles.codeCard}>
        <Text style={styles.mono}>{topic}</Text>
      </View>

      <Pressable style={styles.regen} onPress={regenerate}>
        <Text style={styles.regenText}>Generate a new secret</Text>
      </Pressable>
      <Text style={styles.note}>
        Regenerating makes a brand-new household — other devices would need to re-pair.
      </Text>
    </ScrollView>
  );
}

const makeStyles = (accent: string) =>
  StyleSheet.create({
  root: { flex: 1, paddingHorizontal: 16 },
  center: { flex: 1, alignItems: "center", justifyContent: "center" },
  stubBanner: {
    backgroundColor: "#2a2410",
    borderRadius: 10,
    padding: 12,
    marginTop: 12,
    borderWidth: 1,
    borderColor: theme.warn,
  },
  stubText: { color: theme.warn, fontSize: 13, lineHeight: 18 },
  title: { color: theme.text, fontSize: 22, fontWeight: "800", marginTop: 18 },
  sub: { color: theme.textDim, marginTop: 6, lineHeight: 20 },
  qrCard: {
    backgroundColor: "#fff",
    borderRadius: 16,
    padding: 20,
    alignSelf: "center",
    marginTop: 20,
  },
  label: { color: theme.textDim, fontWeight: "700", marginTop: 22, marginBottom: 8 },
  fpRow: { flexDirection: "row", gap: 8, flexWrap: "wrap" },
  fpChip: {
    backgroundColor: theme.surfaceAlt,
    borderRadius: 999,
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderWidth: 1,
    borderColor: accent,
  },
  fpText: { color: accent, fontWeight: "800", fontSize: 15 },
  codeCard: {
    backgroundColor: theme.surface,
    borderRadius: 12,
    padding: 14,
    borderWidth: 1,
    borderColor: theme.border,
  },
  code: { color: theme.text, fontSize: 16, letterSpacing: 1, lineHeight: 24 },
  mono: { color: theme.textDim, fontSize: 12 },
  joinInput: {
    backgroundColor: theme.surfaceAlt,
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 12,
    color: theme.text,
    fontSize: 15,
    marginTop: 4,
  },
  joinBtn: {
    backgroundColor: accent,
    borderRadius: 10,
    paddingVertical: 13,
    alignItems: "center",
    marginTop: 10,
  },
  joinBtnText: { color: theme.accentText, fontWeight: "800" },
  joinRow: { flexDirection: "row", gap: 10 },
  joinBtnFlex: { flex: 1 },
  scanRoot: { flex: 1, backgroundColor: "#000000" },
  scanHint: {
    position: "absolute",
    top: 70,
    left: 0,
    right: 0,
    alignItems: "center",
  },
  scanHintText: {
    color: "#ffffff",
    fontWeight: "700",
    backgroundColor: "rgba(0,0,0,0.55)",
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 10,
  },
  scanCancel: {
    position: "absolute",
    bottom: 44,
    alignSelf: "center",
    backgroundColor: accent,
    borderRadius: 10,
    paddingVertical: 13,
    paddingHorizontal: 40,
  },
  regen: {
    backgroundColor: theme.surface,
    borderRadius: 12,
    paddingVertical: 14,
    alignItems: "center",
    marginTop: 24,
    borderWidth: 1,
    borderColor: theme.border,
  },
  regenText: { color: theme.text, fontWeight: "700" },
  note: { color: theme.textDim, fontSize: 12, marginTop: 10, lineHeight: 18 },
});
