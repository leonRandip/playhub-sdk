import { defineConfig } from 'vitest/config';

// Each test file starts its own `wrangler dev`; give it time.
export default defineConfig({ test: { testTimeout: 20_000, hookTimeout: 90_000 } });
