// Re-export shim — KYM consumes the shared transport from the loam-transport submodule.
// Same public API KYM's delivery.ts already uses; the real code (incl. ServiceNode for the
// device-wide Logos Delivery node) lives in the package.
export * from "./loam-transport-pkg/src/logos-transport";
