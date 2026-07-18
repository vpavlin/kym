// Pairing — STUB (issue #3/#4). This screen generates a REAL 32-byte household
// secret and derives the REAL topic + 3-word fingerprint (ported from Perun's
// shipped pairing crypto, re-namespaced to `kym`), and renders the pairing QR.
//
// What is intentionally NOT here: any networking. There is no Delivery/Waku in
// Phase 2. Nothing is sent, subscribed, or synced. The QR + fingerprint are the
// UI + key material a later phase (liblogosdelivery, issue #4) will use to
// actually pair and sync devices. The secret is persisted in SecureStore so the
// same household key survives app restarts.
import React, { useEffect, useState } from "react";
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import QRCode from "react-native-qrcode-svg";
import * as SecureStore from "expo-secure-store";
import {
  deriveIdentity,
  encodeSecret,
  decodeSecret,
  groupCode,
  newSecret,
  pairingUri,
  topicFor,
} from "../lib/identity";
import { theme } from "../ui/theme";

const SECRET_KEY = "kym.householdSecret.b32";

export function PairingScreen() {
  const [loading, setLoading] = useState(true);
  const [secretB32, setSecretB32] = useState<string>("");

  useEffect(() => {
    (async () => {
      let b32: string | null = null;
      try {
        b32 = await SecureStore.getItemAsync(SECRET_KEY);
      } catch {
        b32 = null;
      }
      if (!b32) {
        b32 = encodeSecret(newSecret());
        try {
          await SecureStore.setItemAsync(SECRET_KEY, b32);
        } catch {
          // ignore — kept in memory for this session
        }
      }
      setSecretB32(b32);
      setLoading(false);
    })();
  }, []);

  const regenerate = async () => {
    const b32 = encodeSecret(newSecret());
    try {
      await SecureStore.setItemAsync(SECRET_KEY, b32);
    } catch {
      // ignore
    }
    setSecretB32(b32);
  };

  if (loading || !secretB32) {
    return (
      <View style={styles.center}>
        <ActivityIndicator color={theme.accent} />
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
          STUB · no networking yet. Key material + QR only. Delivery/Waku sync lands in
          issues #3 / #4.
        </Text>
      </View>

      <Text style={styles.title}>Household pairing</Text>
      <Text style={styles.sub}>
        Show this QR on another device to join the same household (one shared 32-byte secret).
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

      <Text style={styles.label}>Derived household topic (phase 3)</Text>
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

const styles = StyleSheet.create({
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
    borderColor: theme.accent,
  },
  fpText: { color: theme.accent, fontWeight: "800", fontSize: 15 },
  codeCard: {
    backgroundColor: theme.surface,
    borderRadius: 12,
    padding: 14,
    borderWidth: 1,
    borderColor: theme.border,
  },
  code: { color: theme.text, fontSize: 16, letterSpacing: 1, lineHeight: 24 },
  mono: { color: theme.textDim, fontSize: 12 },
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
