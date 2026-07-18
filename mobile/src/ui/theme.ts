// Minimal dark theme tokens. Android-first, high-contrast, big touch targets.
export const theme = {
  bg: "#0d1013",
  surface: "#161b21",
  surfaceAlt: "#1e252d",
  border: "#2a323b",
  text: "#f2f5f7",
  textDim: "#93a1ad",
  accent: "#4fd1c5",
  accentText: "#04201d",
  danger: "#f2555a",
  warn: "#f2b155",
  good: "#5fd38d",
};

export const money = {
  positive: theme.good,
  negative: theme.danger,
  zero: theme.textDim,
};
