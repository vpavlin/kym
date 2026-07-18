// C++ mirror of packages/contract/src/currency.mjs — display formatting only.
// Money stays integer milliunits everywhere; this formats it per currency.
#pragma once
#include <string>
#include <cstdint>
#include <cmath>
#include <cstdio>

namespace kym {

struct CurrencyFmt { std::string symbol; int decimals; bool symbolAfter; std::string thousands; std::string decimal; };

inline CurrencyFmt currencyFmt(const std::string& code) {
  if (code == "EUR") return {"€", 2, true, " ", ","};
  if (code == "USD") return {"$", 2, false, ",", "."};
  return {"Kč", 0, true, " ", ","}; // CZK default
}

inline std::string formatMoney(int64_t milli, const std::string& code = "CZK") {
  CurrencyFmt c = currencyFmt(code);
  bool neg = milli < 0;
  int64_t factor = (int64_t)std::llround(std::pow(10, 3 - c.decimals));
  int64_t units = (int64_t)std::llround((double)std::llabs(milli) / (double)factor);
  int64_t scale = (int64_t)std::llround(std::pow(10, c.decimals));
  int64_t whole = units / scale;
  int64_t frac = units % scale;

  std::string ws = std::to_string(whole);
  // group thousands
  std::string grouped;
  int cnt = 0;
  for (int i = (int)ws.size() - 1; i >= 0; --i) {
    grouped.insert(grouped.begin(), ws[i]);
    if (++cnt % 3 == 0 && i != 0) grouped.insert(0, c.thousands);
  }
  std::string numeric = grouped;
  if (c.decimals > 0) {
    char fbuf[8]; std::snprintf(fbuf, sizeof(fbuf), "%0*lld", c.decimals, (long long)frac);
    numeric += c.decimal + std::string(fbuf);
  }
  std::string lead = neg ? "-" : "";
  return c.symbolAfter ? (lead + numeric + " " + c.symbol) : (lead + c.symbol + numeric);
}

} // namespace kym
