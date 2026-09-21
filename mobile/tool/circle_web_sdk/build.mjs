import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "vite";
import { nodePolyfills } from "vite-plugin-node-polyfills";

const here = fileURLToPath(new URL(".", import.meta.url));
const output = resolve(here, "../../assets/circle_w3s_sdk.js");

await build({
  root: here,
  plugins: [
    nodePolyfills({
      include: ["buffer", "crypto", "stream", "util", "vm"],
      globals: { Buffer: true, global: true, process: true },
      protocolImports: true,
    }),
  ],
  build: {
    outDir: resolve(here, "../../assets"),
    emptyOutDir: false,
    minify: true,
    target: ["chrome100", "safari15"],
    lib: {
      entry: resolve(here, "entry.js"),
      name: "CircleW3S",
      formats: ["iife"],
      fileName: () => "circle_w3s_sdk.js",
    },
  },
});

const bytes = await readFile(output);
const sha256 = createHash("sha256").update(bytes).digest("hex");
await writeFile(`${output}.sha256`, `${sha256}  circle_w3s_sdk.js\n`, "utf8");
console.log(`Circle Web SDK bundle SHA-256: ${sha256}`);
