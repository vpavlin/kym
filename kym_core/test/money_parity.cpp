// Parity: kym::toMilli (money_format.hpp) must parse human amounts exactly like
// toMilli in packages/contract/src/money.mjs (cases mirrored in
// packages/engine/test/money.test.mjs). Build & run (from kym_core/test):
//   g++ -std=c++17 -I../src money_parity.cpp -o mp && ./mp
#include "../src/money_format.hpp"
#include <iostream>

int main() {
  struct C { const char* in; int64_t want; };
  const C cases[] = {
    {"1500,50", 1500500}, {"1500.50", 1500500}, {"1 500,50", 1500500}, {"1\xC2\xA0" "500,50", 1500500},
    {"1.500,50", 1500500}, {"1,500.50", 1500500}, {"1,500,000", 1500000000}, {"1.500.000", 1500000000},
    {"-12,5", -12500}, {"250", 250000}, {"0,99", 990}, {",5", 500}, {"abc", 0}, {"10.5", 10500}, {"1500,", 1500000},
  };
  int failures = 0, checks = 0;
  for (const auto& c : cases) {
    checks++;
    int64_t got = kym::toMilli(c.in);
    if (got != c.want) { failures++; std::cerr << "  FAIL toMilli(\"" << c.in << "\") = " << got << " want " << c.want << "\n"; }
  }
  std::cout << (failures ? "MONEY PARITY FAILED" : "MONEY PARITY OK") << " — " << (checks - failures) << "/" << checks << " checks passed\n";
  return failures ? 1 : 0;
}
