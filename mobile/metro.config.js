// Metro config — the integration seam that lets React Native bundle the SHARED
// engine/contract packages (plain ESM `.mjs` in the npm workspace at ../packages).
//
// The problems Metro has out of the box with this setup, and how each is solved
// (full write-up in mobile/README.md):
//
//  1. The packages live OUTSIDE mobile/ (in ../packages). Metro only watches the
//     project root by default → add ../packages to `watchFolders`.
//  2. `@kym/contract` uses package.json `exports` subpaths (`@kym/contract/hlc`)
//     and, critically, `events.mjs` imports `randomUUID` from `node:crypto`, which
//     does not exist in React Native. So a custom `resolveRequest` maps every bare
//     `@kym/*` specifier straight to its `.mjs` file and rewrites `node:crypto`
//     (and bare `crypto`) to a tiny Expo-backed shim (shims/crypto.js). (`.mjs` is
//     already in Expo's default `sourceExts`.)
//  3. Watchman/lazy-SHA1 hazards for files outside the project root — see the two
//     `config` overrides below.
//  4. Expo's on-demand filesystem drops external watchFolders on export — disabled
//     via app.json `expo.experiments.onDemandFilesystem: false` (NOT here).
//
// Net effect: the phone bundles and runs the exact same `computeState` fold as the
// desktop module — no vendored fork, no drift.

const { getDefaultConfig } = require("expo/metro-config");
const path = require("path");

const projectRoot = __dirname;
const monorepoRoot = path.resolve(projectRoot, "..");
const packagesRoot = path.resolve(monorepoRoot, "packages");

const config = getDefaultConfig(projectRoot);

// Force Metro's Node filesystem crawler. Watchman is not installed in every dev
// environment; when Metro probes for it and it is missing, external watchFolders
// (our ../packages) can end up absent from the file map, surfacing as a spurious
// "Failed to get the SHA-1" for packages/engine/src/index.mjs. The Node crawler
// maps the external sources reliably.
config.resolver.useWatchman = false;

// Compute file SHA-1s eagerly during the crawl. Metro's default lazy SHA-1
// (`watcher.unstable_lazySha1`) computes hashes on demand, and for source files
// that live OUTSIDE the project root (our ../packages/*.mjs) that lazy path
// throws "Failed to get the SHA-1" — even though the file is watched and mapped.
// Eager hashing (matching Metro's classic behaviour) resolves the external
// sources correctly. See mobile/README.md for the full write-up.
config.watcher = config.watcher || {};
config.watcher.unstable_lazySha1 = false;

// (1) Watch the shared packages so Metro's file map includes their .mjs sources.
// We watch `../packages` specifically (not the whole monorepo ancestor of the
// project root) — an ancestor watchFolder confuses Metro's crawler and yields
// "Failed to get the SHA-1" for files it resolved but never mapped.
config.watchFolders = [packagesRoot];

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
