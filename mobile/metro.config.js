// Metro config — the integration seam that lets React Native bundle the SHARED
// engine/contract packages (plain ESM `.mjs` in the npm workspace at ../packages).
//
// Three problems Metro has out of the box, and how each is solved here:
//
//  1. The packages live OUTSIDE mobile/ (in ../packages). Metro only watches the
//     project root by default → add the monorepo root to `watchFolders`.
//  2. The sources are `.mjs`. Metro's default `sourceExts` has no `mjs` → add it.
//  3. `@kym/contract` uses package.json `exports` subpaths (`@kym/contract/hlc`)
//     and, critically, `events.mjs` imports `randomUUID` from `node:crypto`, which
//     does not exist in React Native. Metro's default resolver honours neither the
//     `exports` map nor Node core modules → a custom `resolveRequest` maps every
//     bare `@kym/*` specifier straight to its `.mjs` file and rewrites `node:crypto`
//     (and bare `crypto`) to a tiny Expo-backed shim (shims/crypto.js).
//
// Net effect: the phone bundles and runs the exact same `computeState` fold as the
// desktop module — no vendored fork, no drift. See mobile/README.md.

const { getDefaultConfig } = require("expo/metro-config");
const path = require("path");

const projectRoot = __dirname;
const monorepoRoot = path.resolve(projectRoot, "..");
const packagesRoot = path.resolve(monorepoRoot, "packages");

const config = getDefaultConfig(projectRoot);

// (1) Watch the monorepo so Metro can read files under ../packages.
config.watchFolders = [monorepoRoot];

// (2) Teach Metro that `.mjs` is source.
config.resolver.sourceExts = Array.from(
  new Set([...config.resolver.sourceExts, "mjs"])
);

// Resolve modules from both the app's and the monorepo's node_modules.
config.resolver.nodeModulesPaths = [
  path.resolve(projectRoot, "node_modules"),
  path.resolve(monorepoRoot, "node_modules"),
];

// (3) Explicit specifier map — deterministic, no reliance on Metro's package
// `exports` support, and it intercepts the Node core `crypto` import.
const cryptoShim = path.resolve(projectRoot, "shims/crypto.js");
const contractSrc = path.resolve(packagesRoot, "contract/src");
const engineSrc = path.resolve(packagesRoot, "engine/src");

const EXPLICIT = {
  "node:crypto": cryptoShim,
  crypto: cryptoShim,
  "@kym/contract": path.resolve(contractSrc, "index.mjs"),
  "@kym/contract/money": path.resolve(contractSrc, "money.mjs"),
  "@kym/contract/hlc": path.resolve(contractSrc, "hlc.mjs"),
  "@kym/contract/events": path.resolve(contractSrc, "events.mjs"),
  "@kym/engine": path.resolve(engineSrc, "index.mjs"),
};

const defaultResolveRequest = config.resolver.resolveRequest;

config.resolver.resolveRequest = (context, moduleName, platform) => {
  const target = EXPLICIT[moduleName];
  if (target) {
    return { type: "sourceFile", filePath: target };
  }
  if (defaultResolveRequest) {
    return defaultResolveRequest(context, moduleName, platform);
  }
  return context.resolveRequest(context, moduleName, platform);
};

module.exports = config;
