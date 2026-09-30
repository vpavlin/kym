// toMilli must accept a decimal COMMA (Czech/European input) and space/NBSP
// thousands separators, and keep "." working. The same cases run against the C++
// kym::toMilli in kym_core/test/money_parity.cpp.
import { test } from "node:test";
import assert from "node:assert/strict";
import { toMilli } from "@kym/contract/money";

const CASES = [
  ["1500,50", 1500500], ["1500.50", 1500500], ["1 500,50", 1500500], ["1 500,50", 1500500],
  ["1.500,50", 1500500], ["1,500.50", 1500500], ["1,500,000", 1500000000], ["1.500.000", 1500000000],
  ["-12,5", -12500], ["250", 250000], ["0,99", 990], [",5", 500], ["abc", 0], ["10.5", 10500], ["1500,", 1500000],
];

test("toMilli: decimal comma, dot, and thousands separators", () => {
  for (const [input, want] of CASES) assert.equal(toMilli(input), want, JSON.stringify(input));
});

test("toMilli: numbers still round to milliunits", () => {
  assert.equal(toMilli(10.5), 10500);
  assert.equal(toMilli(0.1), 100);
});
