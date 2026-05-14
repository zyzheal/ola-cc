import { build } from "bun";

// ESM build
await build({
  entrypoints: ["src/index.ts"],
  outdir: "./dist",
  format: "esm",
  target: "node",
  minify: false,
  sourcemap: "linked",
  external: ["ajv", "zod", "@modelcontextprotocol/*"],
});

// CJS build
await build({
  entrypoints: ["src/index.ts"],
  outfile: "./dist/index.cjs",
  format: "cjs",
  target: "node",
  minify: false,
  sourcemap: "linked",
  external: ["ajv", "zod", "@modelcontextprotocol/*"],
});

console.log("Build complete: dist/index.js + dist/index.cjs");
