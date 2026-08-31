import { build } from "esbuild";
import { createRequire } from "module";

const require = createRequire(import.meta.url);
const { version } = require("./package.json");

await build({
  entryPoints: ["src/carl.ts"],
  bundle: true,
  platform: "node",
  format: "esm",
  banner: {
    js: [
      'import {fileURLToPath as _fup} from "url";',
      'import {dirname as _dn} from "path";',
      'import {createRequire as _cr} from "module";',
      "const __dirname=_dn(_fup(import.meta.url));",
      "const require=_cr(import.meta.url);",
    ].join(" "),
  },
  define: {
    CARL_VERSION: JSON.stringify(version),
  },
  outfile: "dist/carl.mjs",
});

// The model benchmark. Its own entry point rather than a `carl` subcommand: it
// spawns `dist/carl.mjs` as a subprocess many times over, and it needs to set
// CARL_CONFIG_DIR for those children without having already loaded a config of
// its own.
await build({
  entryPoints: ["src/bench.ts"],
  bundle: true,
  platform: "node",
  format: "esm",
  banner: {
    js: [
      'import {fileURLToPath as _fup} from "url";',
      'import {dirname as _dn} from "path";',
      'import {createRequire as _cr} from "module";',
      "const __dirname=_dn(_fup(import.meta.url));",
      "const require=_cr(import.meta.url);",
    ].join(" "),
  },
  define: {
    CARL_VERSION: JSON.stringify(version),
  },
  outfile: "dist/bench.mjs",
});

// The read-ledger harness plugin. Not part of the CLI bundle: this one is
// imported by the DeepSeek Harness subprocess, which resolves it as an ESM
// module relative to runtime/cordis.yml. It depends on no @deepseek-ai package,
// so the bundle is carl's own source and nothing else.
await build({
  entryPoints: ["src/read-ledger-plugin.ts"],
  bundle: true,
  platform: "node",
  format: "esm",
  outfile: "dist/plugins/read-ledger.mjs",
});
