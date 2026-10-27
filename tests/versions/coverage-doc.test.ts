/**
 * Keeps docs/research/profile-coverage.md in sync with the profile.
 * Regenerate with: UPDATE_COVERAGE=1 npx vitest run tests/versions/coverage-doc.test.ts
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { current } from '../../src/domain/versions/profiles/current';
import { CONFIDENCES, formatValue, leaves } from './helpers';

const DOC = resolve(__dirname, '../../docs/research/profile-coverage.md');
const BEGIN = '<!-- coverage:begin -->';
const END = '<!-- coverage:end -->';

function cell(s: string): string {
  return s.replace(/\|/g, '\\|');
}

function summary(): string {
  const all = leaves(current);
  const rows = CONFIDENCES.map(
    (c) => `| ${c} | ${all.filter((l) => l.cited.confidence === c).length} |`,
  );
  return ['| Confidence | Count |', '|---|---|', ...rows, `| **Total** | **${all.length}** |`].join(
    '\n',
  );
}

function table(): string {
  const rows = leaves(current).map(
    ({ path, cited }) =>
      `| \`${path}\` | ${cell(formatValue(cited.value))} | ${cited.confidence} | ${cited.cite
        .map((id) => `\`${id}\``)
        .join(', ')} | ${cell(cited.note ?? '')} |`,
  );
  return [
    '| Field | Value | Confidence | Citations | Note |',
    '|---|---|---|---|---|',
    ...rows,
  ].join('\n');
}

describe('profile coverage doc', () => {
  it('matches the current profile', () => {
    const doc = readFileSync(DOC, 'utf8');
    const start = doc.indexOf(BEGIN);
    const end = doc.indexOf(END);
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    const expected = `${BEGIN}\n${summary()}\n\n${table()}\n${END}`;
    const actual = doc.slice(start, end + END.length);
    if (actual !== expected && process.env.UPDATE_COVERAGE === '1') {
      writeFileSync(DOC, doc.slice(0, start) + expected + doc.slice(end + END.length));
      return;
    }
    expect(actual, 'profile-coverage.md is stale; regenerate with UPDATE_COVERAGE=1').toBe(
      expected,
    );
  });
});
