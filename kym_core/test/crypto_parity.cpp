// Cross-language crypto parity (#6): read the TS-generated fixture on stdin and
// assert the C++ crypto (kym_crypto.hpp) reproduces K/Ke/topic, opens the
// TS-sealed message back to the original plaintext, and re-seals it identically.
//   node crypto_fixture.mjs | ./crypto_parity
#include "../src/kym_crypto.hpp"
#include <iostream>
#include <sstream>
#include <map>

using namespace kym;
static int fails = 0, checks = 0;
static void eq(const std::string &got, const std::string &want, const std::string &what) {
  checks++;
  if (got != want) { fails++; std::cerr << "  FAIL " << what << "\n    got  " << got << "\n    want " << want << "\n"; }
}

int main() {
  std::map<std::string, std::string> f;
  std::string k, v, line;
  while (std::getline(std::cin, line)) {
    std::istringstream is(line);
    if (is >> k >> v) f[k] = v;
  }
  Identity id = deriveIdentity(fromHex(f["secret"]));
  eq(toHex(id.K), f["K"], "K (HKDF salt=kym-pair-v1)");
  eq(toHex(id.Ke), f["Ke"], "Ke (HKDF info=kym/payload/v1)");
  eq(topicFor(id), f["topic"], "content topic (HMAC)");

  // open the TS-sealed message -> original plaintext
  Bytes opened = open(id, fromHex(f["sealed"]), f["topic"]);
  eq(toHex(opened), f["plaintext"], "open(TS sealed) == plaintext");

  // re-seal with the same nonce -> identical ciphertext (encrypt parity)
  Bytes resealed = seal(id, fromHex(f["plaintext"]), f["topic"], fromHex(f["nonce"]));
  eq(toHex(resealed), f["sealed"], "seal(plaintext) == TS sealed");

  std::cout << (fails ? "CRYPTO PARITY FAILED" : "CRYPTO PARITY OK")
            << " — " << (checks - fails) << "/" << checks << " checks\n";
  return fails ? 1 : 0;
}
