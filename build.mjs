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
