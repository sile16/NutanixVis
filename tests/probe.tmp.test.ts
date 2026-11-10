import { readFileSync } from 'node:fs';
import { it } from 'vitest';
import { loadSimulation } from '../src/loader/simulation';

it('probe', () => {
  const doc = readFileSync('docs/view-fields.md', 'utf8');
  const documented = new Set([...doc.matchAll(/^\| `([A-Za-z0-9.]+)`/gm)].map((m) => m[1]));
  const missing = new Map<string, Set<string>>();
  for (const [topo, options] of [
    [
      't1-ahv-flasharray',
      { 'node-count': 3, 'vm-layout': 'two-plus-spare', 'vm-load-gbps': 'line-rate' },
    ],
    ['t1-ahv-flasharray', { 'vs1-bond-mode': 'balance-tcp' }],
    ['t2-hci-ahv', {}],
    ['t3-co-so', {}],
  ] as const) {
    const s = loadSimulation({ topologyId: topo, options: options as never, seed: 1 }).sim.tick(5);
    for (const d of Object.values(s.devices))
      for (const k of Object.keys(d.fields))
        if (!documented.has(k)) {
          const set = missing.get(k) ?? new Set();
          set.add(d.kind);
          missing.set(k, set);
        }
    for (const [k, v] of Object.entries(s.derived)) {
      if (v !== null && typeof v === 'object') {
        for (const k2 of Object.keys(v))
          if (!documented.has(k2) && !documented.has(`${k}.${k2}`)) {
            const set = missing.get(`${k}.${k2}`) ?? new Set();
            set.add('derived');
            missing.set(`${k}.${k2}`, set);
          }
      } else if (!documented.has(k)) {
        const set = missing.get(k) ?? new Set();
        set.add('derived');
        missing.set(k, set);
      }
    }
  }
  console.log('MISSING', [...missing].map(([k, s]) => `${k}(${[...s].join('/')})`).join(' '));
});
