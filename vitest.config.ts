import swc from "unplugin-swc";
import { defineConfig } from "vitest/config";

export default defineConfig({
  // The DB-backed suites share one scratch database (each truncates it first), so files run one at a time.
  test: { include: ["test/**/*.test.ts"], environment: "node", testTimeout: 30_000, hookTimeout: 60_000, fileParallelism: false },
  // Nest DI needs decorator metadata; esbuild cannot emit it, SWC can.
  plugins: [swc.vite({ module: { type: "es6" }, jsc: { transform: { legacyDecorator: true, decoratorMetadata: true } } })],
});
