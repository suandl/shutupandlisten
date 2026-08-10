// The two scalars the works-check driver and its vite config must agree on.
//
// They live in their own module — not in vite.works-check.config.ts, where they
// started — so the CLI can read them WITHOUT importing vite. The config module
// pulls in vite plus the base config's whole plugin graph, and the driver
// (scripts/works-check.mjs) was paying that entire import for two numbers before
// it had done anything at all. It also made the driver untestable in practice:
// scripts/works-check.test.mjs only wants parseArgs, and importing the driver
// dragged the same graph into the node suite behind it.
//
// Both sides import from here, and nothing else defines them: the config owns the
// vite wiring, this module owns the values that wiring and the driver share.

/** Preview port for the works-check, pinned with strictPort — the works-check
 *  mirror of the dev server's pinned :5173 (su-lou.4.1). The driver gets a stable
 *  origin or a fast, classifiable port clash, never a silent port hop, and check
 *  runs never contend with a live `npm run dev`. Overridable per run via --port. */
export const WORKS_CHECK_PORT = 4650;

/** Build output for the probe-only build, relative to web/. Gitignored, and
 *  deliberately NOT dist/: a check run must never clobber a real dist/ the
 *  operator built for deploy. The parent (.works-check/) holds report.json. */
export const WORKS_CHECK_OUT_DIR = '.works-check/dist';
