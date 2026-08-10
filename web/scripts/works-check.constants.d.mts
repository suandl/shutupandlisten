// Types for works-check.constants.mjs (NOT generated).
//
// Same reason as wav.d.mts: scripts/ is plain JS and outside tsconfig's `include`,
// so its JSDoc types are invisible to `tsc`. vite.works-check.config.ts IS inside
// `include` and imports both constants, so it needs a declaration to typecheck.
// Keep in sync with works-check.constants.mjs by hand — it is two scalars.

export declare const WORKS_CHECK_PORT: number;

export declare const WORKS_CHECK_OUT_DIR: string;
