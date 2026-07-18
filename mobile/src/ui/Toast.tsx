// A tiny shared confirmation/status pill — the "visibility of system status"
// primitive (WCAG / Nielsen). One hook, one node: call show(message, tone) after
// any action so success is confirmed and nothing fails silently. Mirrors the
// inline flash CaptureScreen already used, made reusable. Auto-dismisses.
import React, { useCallback, useRef, useState } from "react";
import { StyleSheet, Text, View } from "react-native";
import { theme } from "./theme";

export type ToastTone = "success" | "error" | "info";

interface ToastState {
  message: string;
  tone: ToastTone;
}

export function useToast(defaultMs = 1800) {
  const [state, setState] = useState<ToastState | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const show = useCallback(
    (message: string, tone: ToastTone = "success", ms = defaultMs) => {
      if (timer.current) clearTimeout(timer.current);
      setState({ message, tone });
      timer.current = setTimeout(() => setState(null), ms);
    },
    [defaultMs]
  );

  const toast = state ? <Toast message={state.message} tone={state.tone} /> : null;

  return { show, toast };
}

// A non-color-alone status pill: every tone carries a leading glyph so meaning
// survives when color can't be seen (WCAG 1.4.1).
const GLYPH: Record<ToastTone, string> = {
  success: "✓",
  error: "✗",
  info: "•",
};

function toneColor(tone: ToastTone): string {
  return tone === "error" ? theme.danger : tone === "info" ? theme.textDim : theme.good;
}

export function Toast({ message, tone = "success" }: { message: string; tone?: ToastTone }) {
  return (
    <View style={styles.wrap} pointerEvents="none">
      <View style={[styles.pill, { borderColor: toneColor(tone) }]}>
        <Text style={[styles.text, { color: toneColor(tone) }]}>
          {GLYPH[tone]}  {message}
        </Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    position: "absolute",
    left: 0,
    right: 0,
    bottom: 24,
    alignItems: "center",
  },
  pill: {
    maxWidth: "90%",
    backgroundColor: theme.surfaceAlt,
    borderRadius: 12,
    borderWidth: 1,
    paddingVertical: 10,
    paddingHorizontal: 16,
  },
  text: { fontWeight: "700", fontSize: 14 },
});
