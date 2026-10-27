/**
 * Layer boundaries (SPEC §4 "Boundary rule"):
 * - engine/ imports nothing from domain/, ui/, topologies/, scenarios/, fixtures/ or React.
 * - domain/ imports only engine/ (no ui/, topologies/, scenarios/, React).
 * - topologies/ and scenarios/ never import ui/.
 * - loader/ (topology + domain → engine wiring) never imports ui/.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC = resolve(__dirname, '../src');

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return files(p);
    return /\.(ts|tsx)$/.test(name) ? [p] : [];
  });
}

function imports(file: string): string[] {
  const text = readFileSync(file, 'utf8');
  return [...text.matchAll(/(?:import|export)[^'"]*?from\s+['"]([^'"]+)['"]/g)].map(
    (m) => m[1] ?? '',
  );
}

/** Top-level src/ area an import resolves to, or the bare package name. */
function area(fromFile: string, spec: string): string {
  if (!spec.startsWith('.')) return `pkg:${spec.split('/')[0]}`;
  const rel = relative(SRC, resolve(fromFile, '..', spec));
  return rel.split(sep)[0] ?? '';
}

const rules: Record<string, string[]> = {
  engine: ['domain', 'ui', 'topologies', 'scenarios', 'fixtures', 'pkg:react', 'pkg:react-dom'],
  domain: ['ui', 'topologies', 'scenarios', 'fixtures', 'pkg:react', 'pkg:react-dom'],
  topologies: ['ui', 'scenarios', 'fixtures', 'pkg:react'],
  scenarios: ['ui', 'fixtures', 'pkg:react'],
  loader: ['ui', 'fixtures', 'pkg:react', 'pkg:react-dom'],
};

describe('architecture boundaries', () => {
  for (const [layer, forbidden] of Object.entries(rules)) {
    it(`${layer}/ does not import ${forbidden.join(', ')}`, () => {
      const violations: string[] = [];
      const dir = join(SRC, layer);
      for (const f of files(dir)) {
        for (const spec of imports(f)) {
          if (forbidden.includes(area(f, spec))) violations.push(`${relative(SRC, f)} → ${spec}`);
        }
      }
      expect(violations).toEqual([]);
    });
  }
});
