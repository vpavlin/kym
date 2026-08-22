// Type augmentation for @kym/contract's Clock.
//
// @kym/contract ships as dependency-free ESM (.mjs). When tsc resolves it through
// the node_modules workspace symlink, JS type inference is depth-limited
// (`maxNodeModuleJsDepth` defaults to 0) and silently drops `primeFrom` from the
// inferred Clock — even though the method exists at runtime and in direct
// inference. Metro/Babel build from the .mjs directly and are unaffected; this
// only teaches `tsc --noEmit` the member it under-infers. See ADR 0013.
import "@kym/contract";

declare module "@kym/contract" {
  interface Clock {
    /** Seed the HLC from a persisted log so the next send() sorts after it (ADR 0013). */
    primeFrom(log: Array<{ hlc?: { wall: number; ctr: number; dev: string } }>): this;
  }
}
