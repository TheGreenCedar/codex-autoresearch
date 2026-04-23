import { defineConfig } from "tsdown";

export default defineConfig({
  entry: ["lib/**/*.ts", "scripts/**/*.ts", "tests/**/*.ts"],
  deps: {
    onlyBundle: false,
    skipNodeModulesBundle: true,
  },
  tsconfig: "tsconfig.node.json",
  outDir: "dist",
  clean: true,
  format: "esm",
  platform: "node",
  target: "node24",
  sourcemap: false,
  report: false,
  unbundle: true,
});
