import { execSync } from 'node:child_process';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

/** Short commit id for the banner: CI's checkout sha, else the local git head, else `dev`. */
function buildId(): string {
  const ci = process.env.GITHUB_SHA;
  if (ci) return ci.slice(0, 7);
  try {
    const head = execSync('git rev-parse --short=7 HEAD', { stdio: ['ignore', 'pipe', 'ignore'] })
      .toString()
      .trim();
    const dirty = execSync('git status --porcelain', { stdio: ['ignore', 'pipe', 'ignore'] })
      .toString()
      .trim();
    return dirty ? `${head}+local` : head;
  } catch {
    return 'dev';
  }
}

// GitHub Pages serves the site from https://sile16.github.io/NutanixVis/
export default defineConfig({
  base: '/NutanixVis/',
  define: {
    __BUILD_ID__: JSON.stringify(buildId()),
    __BUILD_DATE__: JSON.stringify(
      `${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC`,
    ),
  },
  plugins: [react(), tailwindcss()],
  test: {
    include: ['tests/**/*.test.ts', 'src/**/*.test.ts'],
    exclude: ['tests/e2e/**', 'node_modules/**'],
    environment: 'node',
    // Full-domain simulations (hundreds of ticks) run slower on CI runners than locally.
    testTimeout: 30_000,
  },
});
