# Tooling research (2026-10-27)

Versions were checked against the npm registry and GitHub releases on 2026-10-27. The decisions are summarized in `docs/SPEC.md` §3.

## Recommended stack

| Area | Pick | Version |
|---|---|---|
| Language | TypeScript (native `tsc`) | typescript 7.0.2 |
| Runtime | Node LTS | 24.22.1 (Node 26 LTS imminent) |
| Build/dev | Vite (Rolldown-based) | vite 8.3.5, @vitejs/plugin-react 6.1.2 |
| UI | React | react 19.3.1 |
| Diagram | React Flow + own Canvas2D packet overlay | @xyflow/react 12.12.0 |
| UI state | Zustand (UI-only; engine via `useSyncExternalStore`) | zustand 5.0.16 |
| Tests | Vitest + fast-check + Playwright | vitest 5.0.5, fast-check 4.10.2, @playwright/test 1.64.1 |
| Lint/format | Biome | @biomejs/biome 2.6.3 |
| Package manager | pnpm | 12.15.0 |
| Styling | Tailwind v4 + shadcn/ui (Radix) | tailwindcss 4.3.3, shadcn 4.23.0, radix-ui 1.8.1 |
| Schema | Zod | zod 4.6.7 |
| CI/CD | GitHub Actions → Pages | checkout v7, setup-node v7, pnpm/action-setup v6, upload-pages-artifact v5, deploy-pages v5 |

## Graph rendering comparison

| Library | Compound | Parallel edges | Edge geometry (public API) | Many animated dots | License | min/gz | Maintenance |
|---|---|---|---|---|---|---|---|
| **React Flow 12.12** | `parentId` subflows. The parent is sized by us, not auto-fit. | Via custom edges or distinct handles per port | We own the path (custom edge) | The built-in dash animation is CPU-heavy, so use an overlay | MIT | 183/59 KB | Very active |
| Cytoscape.js 3.34.4 | True compound, auto-sized | Auto bundling | `sourceEndpoint/targetEndpoint/controlPoints/segmentPoints/midpoint` and `render`/`viewport` events | Fine with an overlay. WebGL is a preview only. | MIT | 425/134 KB | Active |
| AntV G6 5.1.1 | Combos | Yes | `getKeyPath` | Built-in | MIT | 1368/390 KB | Slower, docs China-centric |
| JointJS core 4.3.4 | Embedding | Yes | `getPointAtLength` | SVG, moderate | MPL-2.0 (Pro paid) | 456/136 KB | Active |
| D3 7.9 + SVG | Do it yourself | Do it yourself | Full | Hundreds of SVG circles is acceptable | ISC | small | Stable |
| PixiJS 8.22 / Konva 10.9 | Do it yourself | Do it yourself | Full | Excellent | MIT | 258 / 55 KB gz | Active |

**Pick:** React Flow for nodes and edges. Edge geometry comes from our own `geometry.ts`, which exposes `path` and `pointAt(t)` and is unit-testable. A single Canvas2D overlay draws the packets using the same geometry and the viewport transform. Ports are React Flow handles. Fall back to Cytoscape if compound auto-sizing or parallel-edge bundling becomes the bottleneck. Read only its documented endpoint and control-point APIs, and avoid `taxi` edges, because their points could not be confirmed as public.

## Alternatives

- **UI framework:**
  - **Svelte 5.57 + @xyflow/svelte 1.7** uses the same xyflow core with less boilerplate. svelte-check does not support TS 7 yet.
  - **Vue Flow** is a viable third option.
  - **Solid** has no mature flow library.
  - **Lit/vanilla** means hand-building every panel.
- **Lint:** ESLint 10.13 flat config + typescript-eslint 8.72 + Prettier 3.9. Choose it if type-aware rules such as `no-floating-promises` are needed. It requires TS ≤6.0 (or the `@typescript/typescript6` alias).
- **Build:** Rsbuild or the Bun bundler. Neither offers a meaningful advantage here.
- **Schema:** Valibot 1.5, if bundle size matters.

## Gotchas

- **TS 7:**
  - It has no programmatic API until 7.1.
  - The typescript-eslint peer range is `<6.1.0`, and svelte-check accepts `^5 || ^6`.
- **Vite 8.1:** it changed some defaults. Read the migration notes when scaffolding.
- **React Flow:**
  - Parent nodes don't auto-fit, so compute group bounds in the layout step.
  - Set edge `zIndex` deliberately, or edges get hidden under groups.
  - Define `nodeTypes`/`edgeTypes` outside components.
  - Avoid `animated: true` at scale.
  - The docs disagree on whether parent nodes must come before children in the nodes array. Test it.
- **Cytoscape:** the WebGL renderer is a preview and doesn't support segments edges.

## Sources

- npm registry (`npm view`), GitHub releases API, bundlephobia, nodejs.org dist index
- https://vite.dev/blog.html
- https://infoq.com/news/2026/08/typescript-7-released/ · https://devblogs.microsoft.com/typescript/announcing-typescript-7-0-rc/
- https://js.cytoscape.org/ · https://blog.js.cytoscape.org/2025/01/13/webgl-preview/
- https://reactflow.dev/learn/customization/custom-edges · https://reactflow.dev/examples/edges/animating-edges
- https://liambx.com/blog/tuning-edge-animations-reactflow-optimal-performance
- https://svelteflow.dev/learn/layouting/sub-flows
- https://g6.antv.antgroup.com/en/manual/element/edge/custom-edge
- https://vitest.dev/guide/browser/why
