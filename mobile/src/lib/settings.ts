// Local app settings — currently just the budget currency. Persisted alongside
// the event log in AsyncStorage, but kept OUT of the log: the budget currency is
// a display/entry preference for the whole budget (one currency, default CZK),
// not a household ledger fact that needs to sync as an event. See
// packages/contract/src/currency.mjs for the currency model.
import AsyncStorage from "@react-native-async-storage/async-storage";
import { DEFAULT_CURRENCY } from "./engine";

const KEY = "kym.settings.v1";

export interface Settings {
  budgetCurrency: string; // "CZK" | "EUR" | "USD"
}

export const DEFAULT_SETTINGS: Settings = {
  budgetCurrency: DEFAULT_CURRENCY,
};

export async function loadSettings(): Promise<Settings> {
  try {
    const raw = await AsyncStorage.getItem(KEY);
    if (!raw) return { ...DEFAULT_SETTINGS };
    const parsed = JSON.parse(raw);
    return {
      budgetCurrency:
        typeof parsed?.budgetCurrency === "string"
          ? parsed.budgetCurrency
          : DEFAULT_CURRENCY,
    };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export async function saveSettings(settings: Settings): Promise<void> {
  await AsyncStorage.setItem(KEY, JSON.stringify(settings));
}
