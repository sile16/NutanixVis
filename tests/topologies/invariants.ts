/**
 * Topology invariant checks. Each returns a list of human-readable problems (empty = OK) so a
 * failing test names the offending device.
 */
import type { DeviceSpec, Topology } from '../../src/topologies/schema';

export type Dev<K extends DeviceSpec['kind']> = Extract<DeviceSpec, { kind: K }>;

export function ofKind<K extends DeviceSpec['kind']>(t: Topology, kind: K): Dev<K>[] {
  return t.devices.filter((d): d is Dev<K> => d.kind === kind);
}

export function index(t: Topology): Map<string, DeviceSpec> {
  return new Map(t.devices.map((d) => [d.id, d]));
}

const ID_RULES: Partial<Record<DeviceSpec['kind'], RegExp>> = {
  'ahv-host': /^node-[1-9]\d*$/,
  cvm: /^node-[1-9]\d*\.cvm$/,
  'cvm-interface': /^node-[1-9]\d*\.cvm\.[a-z][a-z-]*$/,
  vswitch: /^node-[1-9]\d*\.vs\d+$/,
  vm: /^node-[1-9]\d*\.vm-[1-9]\d*$/,
  disk: /^node-[1-9]\d*\.disk-[1-9]\d*$/,
  nic: /^(node-[1-9]\d*|fa\.ct[01])\.eth\d+$/,
  switch: /^sw-[a-z]$/,
  'fa-array': /^fa$/,
  'fa-controller': /^fa\.ct[01]$/,
  'fa-interface': /^(fa\.ct[01]\.eth\d+\.v\d+|fa\.vir\d+)$/,
};

export function conventionProblems(t: Topology): string[] {
  const out: string[] = [];
  const ix = index(t);
  for (const d of t.devices) {
    const re = ID_RULES[d.kind];
    if (re && !re.test(d.id)) out.push(`${d.id}: id does not match ${re} for ${d.kind}`);
    if (d.parent && !d.id.startsWith(`${d.parent}.`)) {
      out.push(`${d.id}: id is not prefixed by parent ${d.parent}`);
    }
    const topLevel = d.kind === 'ahv-host' || d.kind === 'switch' || d.kind === 'fa-array';
    if (topLevel && d.parent) out.push(`${d.id}: ${d.kind} must be top-level`);
    if (!topLevel && !d.parent) out.push(`${d.id}: ${d.kind} must have a parent`);
    if (d.kind === 'vswitch') {
      if (d.id !== `${d.parent}.${d.name}`) out.push(`${d.id}: name ${d.name} mismatch`);
      for (const u of d.uplinks) {
        const nic = ix.get(u);
        if (nic?.kind !== 'nic' || nic.parent !== d.parent) {
          out.push(`${d.id}: uplink ${u} is not a NIC of ${d.parent}`);
        }
      }
    }
    if (d.kind === 'cvm-interface') {
      const vs = ix.get(d.vswitch);
      const host = d.parent ? ix.get(d.parent)?.parent : undefined;
      if (vs?.kind !== 'vswitch' || vs.parent !== host) {
        out.push(`${d.id}: vswitch ${d.vswitch} is not on host ${host}`);
      }
    }
    if (d.kind === 'fa-interface') {
      const nic = ix.get(d.nic);
      if (nic?.kind !== 'nic' || !nic.parent?.startsWith('fa.')) {
        out.push(`${d.id}: nic ${d.nic} is not an FA port`);
      }
      if (d.id !== 'fa.vir0' && (d.parent !== d.nic || d.id !== `${d.nic}.v${d.vlan}`)) {
        out.push(`${d.id}: must be ${d.nic}.v${d.vlan} under its port`);
      }
    }
    if ('vlan' in d && !t.vlans.some((v) => v.id === d.vlan)) {
      out.push(`${d.id}: VLAN ${d.vlan} not declared`);
    }
    if (d.kind === 'switch') {
      for (const v of d.vlans) {
        if (!t.vlans.some((x) => x.id === v)) out.push(`${d.id}: VLAN ${v} not declared`);
      }
    }
  }
  const names: Record<number, string> = {
    10: 'storage-a',
    20: 'storage-b',
    30: 'backplane',
    100: 'mgmt',
    200: 'vm',
  };
  for (const v of t.vlans) {
    if (names[v.id] !== v.name) out.push(`VLAN ${v.id}: name ${v.name}, expected ${names[v.id]}`);
  }
  // Hosts numbered 1..N contiguously; VMs and disks per host likewise.
  const hosts = ofKind(t, 'ahv-host').map((h) => Number(h.id.slice(5)));
  if (hosts.some((n, i) => n !== i + 1)) out.push(`hosts not numbered 1..N: ${hosts.join(',')}`);
  for (const kind of ['vm', 'disk'] as const) {
    const perHost = new Map<string, number[]>();
    for (const d of ofKind(t, kind)) {
      const n = Number(d.id.split('-').at(-1));
      perHost.set(d.parent ?? '', [...(perHost.get(d.parent ?? '') ?? []), n]);
    }
    for (const [h, ns] of perHost) {
      if (ns.some((n, i) => n !== i + 1)) out.push(`${h}: ${kind}s not numbered 1..N`);
    }
  }
  return out;
}

export function linkProblems(t: Topology): string[] {
  const out: string[] = [];
  const ix = index(t);
  const used = new Map<string, string>();
  for (const l of t.links) {
    if (l.id !== `l-${l.a}--${l.b}`) out.push(`${l.id}: expected id l-${l.a}--${l.b}`);
    const ka = ix.get(l.a)?.kind;
    const kb = ix.get(l.b)?.kind;
    for (const [end, k] of [
      [l.a, ka],
      [l.b, kb],
    ] as const) {
      if (k !== 'nic' && k !== 'switch') out.push(`${l.id}: end ${end} is ${k}, not nic/switch`);
      if (k === 'nic') {
        const prev = used.get(end);
        if (prev) out.push(`${end}: cabled twice (${prev}, ${l.id})`);
        used.set(end, l.id);
      }
    }
    const isl = ka === 'switch' && kb === 'switch';
    if (isl !== (l.kind === 'isl')) out.push(`${l.id}: kind ${l.kind} but isl=${isl}`);
    if (ka === 'nic' && kb === 'nic') out.push(`${l.id}: NIC-to-NIC cable`);
  }
  return out;
}

export function roleProblems(t: Topology): string[] {
  const out: string[] = [];
  const children = (id: string, kind: DeviceSpec['kind']) =>
    t.devices.filter((d) => d.parent === id && d.kind === kind);
  for (const h of ofKind(t, 'ahv-host')) {
    const cvms = children(h.id, 'cvm').length;
    const vms = children(h.id, 'vm').length;
    const disks = children(h.id, 'disk').length;
    if (h.role === 'compute-only') {
      if (cvms) out.push(`${h.id}: compute-only host has a CVM`);
      if (disks) out.push(`${h.id}: compute-only host has disks`);
    } else if (cvms !== 1) out.push(`${h.id}: ${h.role} host has ${cvms} CVMs`);
    if (h.role === 'storage-only' && vms) out.push(`${h.id}: storage-only host has VMs`);
    if ((h.role === 'hci' || h.role === 'storage-only') && !disks) {
      out.push(`${h.id}: ${h.role} host has no disks`);
    }
    if (h.role === 'external-storage-compute' && disks) out.push(`${h.id}: T1 host has disks`);
  }
  return out;
}

/** Storage VLANs present on both FA controllers (nvme-tcp interfaces). */
export function faProblems(t: Topology): string[] {
  const out: string[] = [];
  const ix = index(t);
  const storage = t.vlans.filter((v) => v.purpose === 'storage').map((v) => v.id);
  for (const ct of ofKind(t, 'fa-controller')) {
    const vlans = new Set(
      ofKind(t, 'fa-interface')
        .filter((i) => i.service === 'nvme-tcp' && ix.get(i.nic)?.parent === ct.id)
        .map((i) => i.vlan),
    );
    for (const v of storage) if (!vlans.has(v)) out.push(`${ct.id}: no interface on VLAN ${v}`);
  }
  return out;
}

/**
 * VLAN-aware L2 reachability: switches that carry `vlan` and are reachable from `nics` over
 * links that admit it (switch VLAN sets + link allowedVlans), following ISLs.
 */
export function switchesReaching(t: Topology, nics: readonly string[], vlan: number): Set<string> {
  const ix = index(t);
  const carries = (sw: string, allowed?: readonly number[]) => {
    const d = ix.get(sw);
    return d?.kind === 'switch' && d.vlans.includes(vlan) && (!allowed || allowed.includes(vlan));
  };
  const seen = new Set<string>();
  const queue: string[] = [];
  for (const l of t.links) {
    for (const [n, sw] of [
      [l.a, l.b],
      [l.b, l.a],
    ] as const) {
      if (nics.includes(n) && carries(sw, l.allowedVlans) && !seen.has(sw)) {
        seen.add(sw);
        queue.push(sw);
      }
    }
  }
  while (queue.length) {
    const cur = queue.shift() ?? '';
    for (const l of t.links) {
      if (l.kind !== 'isl') continue;
      const other = l.a === cur ? l.b : l.b === cur ? l.a : undefined;
      if (other && !seen.has(other) && carries(other, l.allowedVlans)) {
        seen.add(other);
        queue.push(other);
      }
    }
  }
  return seen;
}

/** Switches a NIC is cabled to, filtered by VLAN admission on that cable. */
function attachedSwitch(t: Topology, nic: string, vlan: number): string | undefined {
  for (const l of t.links) {
    const sw = l.a === nic ? l.b : l.b === nic ? l.a : undefined;
    if (sw && (!l.allowedVlans || l.allowedVlans.includes(vlan))) return sw;
  }
  return undefined;
}

export function reachabilityProblems(t: Topology): string[] {
  const out: string[] = [];
  const ix = index(t);
  const faIfaces = ofKind(t, 'fa-interface').filter((i) => i.service === 'nvme-tcp');
  for (const i of ofKind(t, 'cvm-interface')) {
    const vs = ix.get(i.vswitch);
    if (vs?.kind !== 'vswitch') continue;
    const reach = switchesReaching(t, vs.uplinks, i.vlan);
    if (!reach.size) out.push(`${i.id}: VLAN ${i.vlan} not carried by any reachable switch`);
    if (i.service !== 'external-storage') continue;
    // Each storage vNIC must reach an array IP on its VLAN on both controllers.
    for (const ct of ['fa.ct0', 'fa.ct1']) {
      const ok = faIfaces.some((f) => {
        if (f.vlan !== i.vlan || ix.get(f.nic)?.parent !== ct) return false;
        const sw = attachedSwitch(t, f.nic, f.vlan);
        return sw !== undefined && reach.has(sw);
      });
      if (!ok) out.push(`${i.id}: no path to ${ct} on VLAN ${i.vlan}`);
    }
  }
  return out;
}

export function layoutProblems(t: Topology, grid = 20): string[] {
  const out: string[] = [];
  const ix = index(t);
  for (const d of t.devices) if (!t.layout[d.id]) out.push(`${d.id}: no layout entry`);
  for (const id of Object.keys(t.layout)) if (!ix.has(id)) out.push(`${id}: layout for unknown id`);
  for (const [id, b] of Object.entries(t.layout)) {
    if (b.w === undefined || b.h === undefined) {
      out.push(`${id}: missing w/h`);
      continue;
    }
    for (const v of [b.x, b.y, b.w, b.h]) {
      if (v % grid !== 0) out.push(`${id}: ${v} off the ${grid}px grid`);
    }
    if (b.x < 0 || b.y < 0) out.push(`${id}: negative position`);
    const parent = ix.get(id)?.parent;
    const pb = parent ? t.layout[parent] : undefined;
    if (pb?.w !== undefined && pb.h !== undefined) {
      if (b.x + b.w > pb.w || b.y + b.h > pb.h) out.push(`${id}: outside parent ${parent}`);
    }
  }
  // Siblings (same parent, top level included) must not overlap.
  const groups = new Map<string, string[]>();
  for (const d of t.devices) {
    const k = d.parent ?? '';
    groups.set(k, [...(groups.get(k) ?? []), d.id]);
  }
  for (const ids of groups.values()) {
    for (let i = 0; i < ids.length; i++) {
      for (let j = i + 1; j < ids.length; j++) {
        const a = t.layout[ids[i] ?? ''];
        const b = t.layout[ids[j] ?? ''];
        if (!a?.w || !a.h || !b?.w || !b.h) continue;
        const overlap = a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
        if (overlap) out.push(`${ids[i]} overlaps ${ids[j]}`);
      }
    }
  }
  return out;
}

/** Checks that hold for every variant (not just the default configuration). */
export function structuralProblems(t: Topology): string[] {
  return [
    ...conventionProblems(t),
    ...linkProblems(t),
    ...roleProblems(t),
    ...(ofKind(t, 'fa-array').length ? faProblems(t) : []),
    ...layoutProblems(t),
  ];
}
