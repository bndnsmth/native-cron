import { defineConfig } from "vite-plus";

export default defineConfig({
  fmt: {
    ignorePatterns: ["dist/**"],
  },
  lint: {
    jsPlugins: [{ name: "vite-plus", specifier: "vite-plus/oxlint-plugin" }],
    rules: { "vite-plus/prefer-vite-plus-imports": "error" },
    options: { typeAware: true, typeCheck: true },
  },
  test: {
    include: ["test/**/*.test.ts"],
  },
  pack: {
    entry: {
      index: "src/index.ts",
      jobs: "src/jobs-public.ts",
      "run-job": "src/run-job.ts",
    },
    dts: true,
    format: ["esm", "cjs"],
    platform: "node",
    fixedExtension: false,
    outExtensions: ({ format }) => ({
      js: format === "cjs" ? ".cjs" : ".js",
      dts: format === "cjs" ? ".d.cts" : ".d.ts",
    }),
    sourcemap: true,
    outDir: "dist",
    clean: true,
  },
});
