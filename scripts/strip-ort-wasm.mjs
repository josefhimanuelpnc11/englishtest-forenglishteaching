// Post-build cleanup (runs automatically via `postbuild`).
//
// Removes the ORT wasm binary that Vite emits into dist/assets.
// It is never requested at runtime — the app loads its WASM from
// the CDN configured in wasmPaths, and the hashed dist filename
// could never match anyway. At ~27MB it exceeds Cloudflare Pages'
// 25 MiB per-asset limit and fails deploys, so it must go.
import { readdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const assetsDir = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "dist",
  "assets",
);

let entries = [];

try {
  entries = readdirSync(assetsDir);
} catch {
  process.exit(0);
}

for (const name of entries) {
  if (/^ort-wasm-.*\.wasm$/.test(name)) {
    rmSync(join(assetsDir, name));
    console.log(
      `[postbuild] removed unused ${name}`,
    );
  }
}
