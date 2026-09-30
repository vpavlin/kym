// C++ mirror of packages/contract/src/currency.mjs — display formatting only.
// Money stays integer milliunits everywhere; this formats it per currency.
#pragma once
#include <string>
#include <cstdint>
#include <cmath>
#include <cstdio>
#include <cctype>

namespace kym {

struct CurrencyFmt { std::string symbol; int decimals; bool symbolAfter; std::string thousands; std::string decimal; };

inline CurrencyFmt currencyFmt(const std::string& code) {
  if (code == "EUR") return {"€", 2, true, " ", ","};
  if (code == "USD") return {"$", 2, false, ",", "."};
  return {"Kč", 0, true, " ", ","}; // CZK default
}

// Human amount → integer milliunits (×1000), never float. Mirrors toMilli in
// packages/contract/src/money.mjs: everything but digits "." "," "-" is dropped
// (spaces/NBSP = thousands); with both "." and "," the LAST is the decimal point;
// a single "," is a decimal comma ("1500,50"); repeats of one separator = thousands.
inline int64_t toMilli(const std::string& in) {
  size_t i = 0; while (i < in.size() && std::isspace((unsigned char)in[i])) i++;
  bool neg = i < in.size() && in[i] == '-';
  std::string s; size_t dots = 0, commas = 0;
  for (char c : in) {
    if ((c >= '0' && c <= '9') || c == '.' || c == ',') s.push_back(c);
    if (c == '.') dots++; else if (c == ',') commas++;
  }
  char dec = 0;                                 // the decimal separator, 0 = none
  if (dots && commas) dec = s.rfind('.') > s.rfind(',') ? '.' : ',';
  else if (commas == 1) dec = ',';
  else if (dots == 1) dec = '.';
  std::string whole, frac; bool afterDec = false;
  for (char c : s) {
    if (c == dec && !afterDec) { afterDec = true; continue; }
    if (c == '.' || c == ',') continue;         // thousands separator
    (afterDec ? frac : whole).push_back(c);
  }
  if (whole.size() > 15) return 0;              // guard stoll overflow on junk input
  int64_t w = whole.empty() ? 0 : std::stoll(whole);
  frac += "000";
  int64_t v = w * 1000 + std::stoll(frac.substr(0, 3));
  return neg ? -v : v;
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
