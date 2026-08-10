// Re-export shim — KYM consumes the shared transport from the logos-transport submodule.
// Same public API KYM's delivery.ts already uses; the real code (incl. ServiceNode for the
// device-wide Logos Delivery node) lives in the package.
export * from "./logos-transport-pkg/src/logos-transport";
