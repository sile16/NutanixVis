/**
 * Why storage IO crosses the ISL (pure): hover text for the ISL label, built from the live model
 * rather than per-topology prose. For each CVM storage interface it reads the bond mode, the member
 * it is pinned to (MAC pinning, active-backup, LACP fallback) and which switch that member is cabled
 * to, and compares it with the switches holding that VLAN's array ports
 * (docs/research/ovs-bond-behavior.md, docs/research/storage-network-configs.md).
 *
 * The forwarding rules it states:
 * - a pinned interface's frames enter its member's switch, and the switches learn its MAC there,
 *   so replies come back the same way: an interface pinned away from its array ports crosses the
 *   ISL in both directions;
 * - LACP across an MLAG pair hashes each connection onto a member (host -> array), while the array
 *   port's switch sends replies out its own member of the port-channel (array -> host stays local).
 */
import type { DeviceView, Snapshot } from '../../engine/types';

type Devices = Snapshot['devices'];

const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);

/** The switch a NIC is cabled to, or null. */
function switchOf(snapshot: Pick<Snapshot, 'devices' | 'links'>, nic: string): string | null {
  const linkId = str(snapshot.devices[nic]?.fields.link);
  const link = linkId ? snapshot.links[linkId] : undefined;
  if (!link) return null;
  const other = link.a.device === nic ? link.b.device : link.a.device;
  return snapshot.devices[other]?.kind === 'switch' ? other : null;
}

const label = (devices: Devices, id: string): string => devices[id]?.label ?? id;

type Placement =
  | { readonly kind: 'pinned'; readonly sw: string; readonly member: string; readonly why: string }
  | { readonly kind: 'lacp' }
  | { readonly kind: 'unknown' };

function placement(
  snapshot: Pick<Snapshot, 'devices' | 'links'>,
  bond: DeviceView | undefined,
  iface: string,
): Placement {
  if (!bond) return { kind: 'unknown' };
  const f = bond.fields;
  const mode = str(f.mode);
  const eligible = (str(f.eligible) ?? '').split(',').filter(Boolean);
  const pinned = (member: string | null, why: string): Placement => {
    const sw = member ? switchOf(snapshot, member) : null;
    return member && sw ? { kind: 'pinned', sw, member, why } : { kind: 'unknown' };
  };
  if (mode === 'no-bond') return pinned(eligible[0] ?? null, 'its only uplink');
  if (mode === 'active-backup') return pinned(str(f.activeMember), 'the active member');
  if (mode === 'balance-tcp') {
    if (str(f.lacpState) === 'fallback') return pinned(str(f.active), 'the LACP fallback member');
    // One aggregated member (e.g. two switches without MLAG): everything uses it.
    if (eligible.length === 1) return pinned(eligible[0] ?? null, 'the only aggregated member');
    return eligible.length > 1 ? { kind: 'lacp' } : { kind: 'unknown' };
  }
  // balance-slb (MAC pinning): the member its MAC + VLAN bucket is on.
  let pins: Record<string, string> = {};
  try {
    pins = JSON.parse(str(f.pinning) ?? '{}') as Record<string, string>;
  } catch {
    pins = {};
  }
  return pinned(pins[iface] ?? null, 'its pinned member');
}

/** Hover lines explaining the ISL share, or [] when there is no storage traffic to explain. */
export function islWhy(snapshot: Pick<Snapshot, 'devices' | 'links'>, islId: string): string[] {
  const devices = snapshot.devices;
  const isl = snapshot.links[islId];
  if (!isl) return [];
  // Switches holding each storage VLAN's array ports.
  const portalSwitches = new Map<number, Set<string>>();
  for (const d of Object.values(devices)) {
    if (d.kind !== 'fa-interface' || d.fields.service !== 'nvme-tcp') continue;
    if (d.fields.enabled === false || d.fields.cabled === false) continue;
    const nic = str(d.fields.nic);
    const sw = nic ? switchOf(snapshot, nic) : null;
    const vlan = typeof d.fields.vlan === 'number' ? d.fields.vlan : null;
    if (sw === null || vlan === null) continue;
    portalSwitches.set(vlan, (portalSwitches.get(vlan) ?? new Set()).add(sw));
  }
  const ifaces = Object.values(devices).filter(
    (d) => d.kind === 'cvm-interface' && d.fields.service === 'external-storage',
  );
  if (ifaces.length === 0 || portalSwitches.size === 0) return [];

  const local: string[] = [];
  const crossing: string[] = [];
  const split: string[] = [];
  let lacp = 0;
  for (const i of ifaces) {
    const vlan = typeof i.fields.vlan === 'number' ? i.fields.vlan : null;
    const ports = vlan === null ? undefined : portalSwitches.get(vlan);
    if (!ports) continue;
    const bond = devices[str(i.fields.vswitch) ?? ''];
    const p = placement(snapshot, bond, i.id);
    const name = `${label(devices, i.parent ?? i.id)} ${label(devices, i.id)}`;
    if (p.kind === 'lacp') lacp++;
    else if (p.kind === 'pinned') {
      if (ports.size > 1) split.push(name);
      else if (ports.has(p.sw)) local.push(name);
      else
        crossing.push(
          `${name} on ${label(devices, p.member)} (${label(devices, p.sw)}, ${p.why}): its VLAN ${vlan} array ports are on ${[...ports].map((s) => label(devices, s)).join(', ')}`,
        );
    }
  }

  const out: string[] = ['Why:'];
  if (lacp > 0) {
    out.push(
      'LACP (balance-tcp) over the MLAG pair. Host to array: each NVMe/TCP connection is hashed onto one bond member, so connections that land on the switch without their array port cross the ISL: about half of the writes and read requests.',
      "Array to host: replies don't cross. The array port's switch sends them out its own member of the port-channel, because MLAG presents the host's bond on both switches.",
      "So the share depends on the read/write mix and on how Stargate's few busy connections hash.",
    );
  }
  if (local.length > 0 || crossing.length > 0) {
    out.push(
      `${local.length} of ${local.length + crossing.length} pinned storage interfaces sit on the switch with their VLAN's array ports and stay local.`,
    );
  }
  if (crossing.length > 0) {
    out.push(
      'These cross the ISL in both directions (the switches learn the interface MAC on its member, so replies come back the same way):',
      ...crossing.map((c) => `- ${c}`),
    );
  }
  if (split.length > 0) {
    out.push(
      `${split.length} pinned storage interface(s) reach array ports on both switches (trunked array ports): wherever an interface is pinned, its paths to the other switch's ports cross, about half (more or less with the paths Stargate favors).`,
    );
  }
  if (out.length === 1) return [];
  if (lacp === 0 && crossing.length === 0 && split.length === 0)
    out.push("Nothing needs the ISL: every storage interface uses its own VLAN's switch.");
  return out;
}
