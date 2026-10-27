import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

// GitHub Pages serves the site from https://sile16.github.io/NutanixVis/
export default defineConfig({
  base: '/NutanixVis/',
  plugins: [react(), tailwindcss()],
  test: {
    include: ['tests/**/*.test.ts', 'src/**/*.test.ts'],
    exclude: ['tests/e2e/**', 'node_modules/**'],
    environment: 'node',
    // Full-domain simulations (hundreds of ticks) run slower on CI runners than locally.
    testTimeout: 30_000,
  },
});
