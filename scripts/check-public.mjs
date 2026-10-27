#!/usr/bin/env node
// Public-repo guard (SPEC §2, §11): fail if any tracked file references internal-only sources
// or if vendor documents slipped past .gitignore.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const FORBIDDEN = [
  /[a-z0-9-]+\.slack\.com/i,
  /jira\.purestorage\.com/i,
  /confluence\.purestorage\.com/i,
  /docs\.google\.com\/(document|presentation|spreadsheets)/i,
  /drive\.google\.com\/file/i,
  /groups\.google\.com\/a\/purestorage\.com/i,
];
const FORBIDDEN_PATHS = [
  /^docs\/internal\//,
  /^NutanixDocs\//,
  /^EverpureDocs\//,
  /\.(pdf|pptx?|docx|key)$/i,
];
const SELF = 'scripts/check-public.mjs';

const tracked = execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8' })
  .split('\0')
  .filter(Boolean);
const problems = [];
for (const file of tracked) {
  if (FORBIDDEN_PATHS.some((re) => re.test(file))) problems.push(`${file}: must not be tracked`);
  if (file === SELF) continue;
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    continue;
  }
  text.split('\n').forEach((line, i) => {
    for (const re of FORBIDDEN)
      if (re.test(line)) problems.push(`${file}:${i + 1}: internal source (${re})`);
  });
}
if (problems.length) {
  console.error(
    `check:public failed — internal or vendor material in tracked files:\n${problems.join('\n')}`,
  );
  process.exit(1);
}
console.log(`check:public ok (${tracked.length} tracked files)`);
