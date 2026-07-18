// Merchant -> category guess. A small static keyword map (Czech + generic) used
// to PREFILL the category after a receipt scan — never authoritative. Returns a
// canonical category NAME matching the seed budget's category names (see
// budget.ts SEED_CATEGORIES); the capture screen maps that name to the user's
// actual category id, and the user can always override before saving.
//
// This is the v1 heuristic. The research notes (§4/§5) call for a per-user
// learned override table and later an on-device classifier — deliberately out of
// scope here.

// Category name -> substring keywords (already diacritic-folded + lower-cased).
// Order matters: the first category with a matching keyword wins.
const RULES: Array<{ category: string; keywords: string[] }> = [
  {
    category: "Groceries",
    keywords: [
      "albert", "lidl", "kaufland", "billa", "tesco", "penny", "globus",
      "coop", "makro", "potraviny", "grocery", "groceries", "supermarket",
      "market", "spar", "rohlik", "kosik",
    ],
  },
  {
    category: "Dining Out",
    keywords: [
      "restaurace", "restaurant", "kavarna", "cafe", "caffe", "coffee", "kava",
      "pizza", "pizzeria", "bistro", "hospoda", "pub", "bar", "mcdonald",
      "kfc", "burger", "starbucks", "costa", "jidelna", "obcerstveni",
    ],
  },
  {
    category: "Transport",
    keywords: [
      "shell", "omv", "benzina", "mol", "eurooil", "orlen", "benzin", "nafta",
      "fuel", "gas station", "cerpaci", "cerpacistanice", "dpp", "dpmb",
      "jizdenka", "jizdne", "uber", "bolt", "taxi", "parking", "parkovani",
      "cd.cz", "ceske drahy", "regiojet", "leo express",
    ],
  },
  {
    category: "Utilities",
    keywords: [
      "cez", "innogy", "eon", "e.on", "pre", "energie", "elektrina", "plyn",
      "vodarny", "vodovody", "o2", "vodafone", "t-mobile", "tmobile", "utility",
      "utilities", "internet", "upc",
    ],
  },
];

/** Strip diacritics + lower-case so "Kavárna" matches "kavarna". */
function fold(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase();
}

/**
 * Guess a category name from merchant text (or any receipt text). Returns the
 * canonical category name, or null if nothing matches. Pure/deterministic.
 */
export function guessCategory(text: string | null | undefined): string | null {
  if (!text) return null;
  const hay = fold(text);
  for (const rule of RULES) {
    for (const kw of rule.keywords) {
      if (hay.includes(kw)) return rule.category;
    }
  }
  return null;
}
