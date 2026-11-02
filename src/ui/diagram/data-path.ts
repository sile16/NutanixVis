/**
 * The I/O data path of a compute node that uses an external array (pure; the renderer only reads
 * the result). One VM's I/O runs:
 *
 *   VM -> AHV IO redirector (frodo) -> Stargate inside the CVM -> CVM storage interface
 *      -> vswitch (bond) -> member NIC -> cable -> switch -> array port -> controller
 *
 * The first hops are inside a host, so they have no cable in the topology. This module derives them
 * from device views, as hops between boxes, so the diagram can draw them as internal links and
 * animate I/O along them. A hop is `active` (carrying I/O), `idle` (healthy, nothing to carry),
 * `standby` (a bond member that takes over when the active one fails), `stalled` (the VM waits) or
 * `down` (failed or lost). Every hop carries a reason for its hover card.
 *
 * Redirect: when the local Stargate no longer serves a VM, AHV logs the VM in to another CVM. The
 * path then leaves the host through its management vswitch to the other host's management interface
 * and that CVM's Stargate, which reaches the array over its own storage NICs.
 *
 * Only the view fields documented in `docs/view-fields.md` are read. No simulation state is changed.
 */
import type { DeviceView, LinkView, TrafficCategory } from '../../engine/types';
import { DATA_PATH_BAND, VM_ROW, VM_TO_IFACE_ROW } from '../../topologies/layout';
import type { LayoutMap } from './layout';
import type { LinkFlow } from './link-flow';

export type HopState = 'active' | 'idle' | 'standby' | 'stalled' | 'down';
export type HopLane = 'iscsi' | 'nvme';

export interface IoHop {
  readonly id: string;
  readonly from: string;
  readonly to: string;
  /** Short name of the hop (hover title). */
  readonly name: string;
  readonly state: HopState;
  /** Why the hop is in this state (hover text). */
  readonly reason: string;
  /** VMs whose I/O crosses it right now. */
  readonly vms: readonly string[];
  readonly lane: HopLane;
  /** On the redirected path (to a CVM on another host). */
  readonly redirected: boolean;
}

export interface Note {
  readonly text: string;
  readonly tone: 'ok' | 'muted' | 'bad';
}

export interface DataPathModel {
  readonly enabled: boolean;
  /** Derived boxes (Stargate, redirector), as device views. */
  readonly devices: Readonly<Record<string, DeviceView>>;
  readonly hops: readonly IoHop[];
  /** Physical cables that carry I/O now (highlighted). */
  readonly activeLinks: ReadonlySet<string>;
  /** Short labels under cards: bond member roles, array ports without a path. */
  readonly notes: ReadonlyMap<string, Note>;
}

export const EMPTY_DATA_PATH: DataPathModel = {
  enabled: false,
  devices: {},
  hops: [],
  activeLinks: new Set(),
  notes: new Map(),
};

export const IO_PREFIX = 'io:';
export const isIoLink = (id: string): boolean => id.startsWith(IO_PREFIX);
export const stargateId = (cvm: string): string => `${cvm}.stargate`;
export const vmSpacerId = (host: string): string => `${host}.vm-spacer`;
export const redirectorId = (host: string): string => `${host}.redirector`;

const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);

function parseJson<T>(v: unknown, fallback: T): T {
  if (typeof v !== 'string') return fallback;
  try {
    return JSON.parse(v) as T;
  } catch {
    return fallback;
  }
}

const DOWN_STATUS = new Set(['failed', 'offline', 'fenced']);

interface Input {
  readonly devices: Readonly<Record<string, DeviceView>>;
  readonly links: Readonly<Record<string, LinkView>>;
}

/** The host a VM runs on now (HA restarts change it). */
const hostOf = (vm: DeviceView): string | null => str(vm.fields.host) ?? vm.parent ?? null;

const short = (d: DeviceView | undefined, id: string): string => d?.label ?? id;

/** The cable of a NIC (host NIC or array port), if any. */
export function nicLink(s: Input, nic: string): LinkView | undefined {
  return Object.values(s.links).find((l) => l.a.device === nic || l.b.device === nic);
}

/** A NIC is down when it, its cable or an ancestor failed. */
export function nicIsDown(s: Input, nic: string): boolean {
  const d = s.devices[nic];
  if (!d) return true;
  if (DOWN_STATUS.has(d.status) || d.fields.link === 'down' || d.fields.down === true) return true;
  return nicLink(s, nic)?.status === 'down';
}

export function buildDataPath(s: Input): DataPathModel {
  const all = Object.values(s.devices);
  const cvms = all.filter((d) => d.kind === 'cvm');
  const enabled = cvms.some((c) => typeof c.fields.nvmePaths === 'string');
  if (!enabled) return EMPTY_DATA_PATH;

  const byKind = (kind: string) => all.filter((d) => d.kind === kind);
  const vswitches = all.filter((d) => d.kind === 'bond' || d.kind === 'vswitch');
  const hostCvm = new Map<string, DeviceView>();
  for (const c of cvms) if (c.parent) hostCvm.set(c.parent, c);
  // A CVM that is down, or whose Stargate has exited, carries no I/O: nothing is drawn as running
  // through it, whatever its NICs and links still look like ("nobody home").
  const cvmDead = (c: DeviceView | undefined): boolean =>
    !c || DOWN_STATUS.has(c.status) || (str(c.fields.stargate) ?? 'up') === 'down';
  const cvmWhy = (c: DeviceView): string =>
    DOWN_STATUS.has(c.status) ? 'CVM down' : `Stargate is ${str(c.fields.stargate) ?? 'down'}`;
  const stranded = new Set<string>();

  const linkOfNic = (nic: string): LinkView | undefined => nicLink(s, nic);
  const nicDown = (nic: string): boolean => nicIsDown(s, nic);

  // ── Demand: which VMs each CVM serves, locally and from other hosts ─────────────────────────
  const vms = byKind('vm');
  const localDemand = new Map<string, string[]>();
  const remoteDemand = new Map<string, string[]>();
  const remoteOut = new Map<string, string[]>();
  const stalledBy = new Set<string>();
  const push = (m: Map<string, string[]>, k: string, v: string) =>
    m.set(k, [...(m.get(k) ?? []), v]);
  for (const vm of vms) {
    const state = str(vm.fields.state);
    const owner = str(vm.fields.ownerCvm);
    const host = hostOf(vm);
    if (!owner || !host || (state !== 'running' && state !== 'io-stalled')) continue;
    if (state === 'io-stalled') stalledBy.add(vm.id);
    const ownerCvm = s.devices[owner];
    const localOwner = hostCvm.get(host)?.id === owner;
    // The VM still points at a CVM that cannot serve it (or cannot be reached): it waits there,
    // and no hop behind that CVM carries its I/O until the redirector logs in elsewhere.
    if (cvmDead(ownerCvm) || (localOwner && ownerCvm?.fields.internalLink === 'down')) {
      stranded.add(vm.id);
      continue;
    }
    if (localOwner) push(localDemand, owner, vm.id);
    else {
      push(remoteDemand, owner, vm.id);
      push(remoteOut, host, vm.id);
    }
  }
  const demandOf = (cvm: string): string[] => [
    ...(localDemand.get(cvm) ?? []),
    ...(remoteDemand.get(cvm) ?? []),
  ];

  const hops = new Map<string, IoHop>();
  const addHop = (h: Omit<IoHop, 'id'>) => {
    const id = `${IO_PREFIX}${h.from}>${h.to}`;
    hops.set(id, { id, ...h });
  };
  const notes = new Map<string, Note>();
  const activeLinks = new Set<string>();
  const devices: Record<string, DeviceView> = {};

  const stateOfDemand = (ids: readonly string[]): HopState =>
    ids.length === 0 ? 'idle' : ids.some((v) => stalledBy.has(v)) ? 'stalled' : 'active';

  // ── Hosts: VM -> redirector, redirector -> local Stargate or out through the uplink ──────────
  const hosts = byKind('ahv-host');
  for (const host of hosts) {
    const here = vms.filter((v) => hostOf(v) === host.id);
    const cvm = hostCvm.get(host.id);
    if (here.length === 0 && !cvm) continue;
    if (here.length === 0 && cvm && typeof cvm.fields.nvmePaths === 'string') {
      // Keeps the VM row (and so the CVM) at the same height as on hosts that run VMs.
      const sid = vmSpacerId(host.id);
      devices[sid] = {
        id: sid,
        kind: 'vm-spacer',
        label: 'no VMs',
        parent: host.id,
        status: 'healthy',
        badges: [],
        fields: { note: 'No VMs run on this node; the area is kept so every node lines up.' },
      };
    }
    const rid = redirectorId(host.id);
    const out = remoteOut.get(host.id) ?? [];
    if (here.length > 0) {
      const stalled = here.some((v) => stalledBy.has(v.id));
      devices[rid] = {
        id: rid,
        kind: 'redirector',
        label: 'frodo · IO redirector',
        parent: host.id,
        status: stalled ? 'stalled' : out.length > 0 ? 'degraded' : 'healthy',
        badges: [],
        fields: {
          role: 'AHV IO redirector (frodo)',
          sessions: here
            .map((v) => {
              const o = str(v.fields.ownerCvm);
              return `${v.label} to ${o ? short(s.devices[o], o) : 'none'}`;
            })
            .join('; '),
          redirected: out.length,
        },
      };
    }
    for (const vm of here) {
      const state = str(vm.fields.state);
      const owner = str(vm.fields.ownerCvm);
      let hop: HopState;
      let reason: string;
      if (state === 'io-stalled') {
        hop = 'stalled';
        reason = 'I/O is outstanding and none completes: waiting for a Stargate to serve the disk';
      } else if (state === 'running' && stranded.has(vm.id)) {
        hop = 'stalled';
        reason = `${short(s.devices[owner ?? ''], owner ?? 'its CVM')} cannot serve this VM: ${cvm && owner === cvm.id ? cvmWhy(cvm) : 'CVM down'}`;
      } else if (state === 'running' && owner) {
        hop = 'active';
        reason = `virtual disk I/O to ${short(s.devices[owner], owner)}`;
      } else {
        hop = 'idle';
        reason = state === 'running' ? 'no Stargate serves this VM' : `VM is ${state ?? 'unknown'}`;
      }
      addHop({
        from: vm.id,
        to: rid,
        name: `${vm.label} to the redirector`,
        state: hop,
        reason,
        vms: [vm.id],
        lane: 'iscsi',
        redirected: false,
      });
    }
    if (cvm && here.length > 0) {
      const local =
        localDemand.get(cvm.id)?.filter((v) => hostOf(s.devices[v] as DeviceView) === host.id) ??
        [];
      let state: HopState = stateOfDemand(local);
      let reason = local.length
        ? 'IO over the host-internal link to the local Stargate'
        : 'no VM on this host is served by the local Stargate';
      if (cvm.fields.internalLink === 'down') {
        state = 'down';
        reason = 'host-CVM internal link is down';
      } else if (cvmDead(cvm) && local.length === 0) {
        state = 'down';
        reason = `${cvmWhy(cvm)}: no I/O goes through it, the redirector moves its VMs to another CVM`;
      }
      addHop({
        from: rid,
        to: stargateId(cvm.id),
        name: 'Redirector to the local Stargate',
        state,
        reason,
        vms: local,
        lane: 'iscsi',
        redirected: false,
      });
    }
    // Redirected: leaves through the host's management interface.
    if (out.length > 0) {
      const hi = byKind('host-interface').find((d) => d.parent === host.id);
      if (hi) {
        addHop({
          from: rid,
          to: hi.id,
          name: 'Redirected out through the management uplink',
          state: stateOfDemand(out),
          reason: `AHV logged ${out.length} VM session(s) in to another CVM; the I/O leaves through the host management interface`,
          vms: out,
          lane: 'iscsi',
          redirected: true,
        });
      }
    }
  }

  // ── CVMs: Stargate -> interfaces ────────────────────────────────────────────────────────────
  for (const cvm of cvms) {
    const sg = str(cvm.fields.stargate) ?? 'up';
    const sgId = stargateId(cvm.id);
    const paths = parseJson<Record<string, string>>(cvm.fields.nvmePaths, {});
    const demand = demandOf(cvm.id);
    const remote = remoteDemand.get(cvm.id) ?? [];
    devices[sgId] = {
      id: sgId,
      kind: 'stargate',
      label: 'Stargate',
      parent: cvm.id,
      status: DOWN_STATUS.has(cvm.status)
        ? 'failed'
        : sg === 'up'
          ? 'healthy'
          : sg === 'hung'
            ? 'stalled'
            : sg === 'unhealthy'
              ? 'degraded'
              : 'failed',
      badges: [],
      fields: {
        state: sg,
        role: 'serves the vDisks; talks NVMe/TCP to the array',
        vdisksOwned: typeof cvm.fields.ownedVdisks === 'number' ? cvm.fields.ownedVdisks : null,
        servingVms: demand.length,
        remoteVms: remote.length,
        arrayPathsLive: typeof cvm.fields.nvmePathsUp === 'number' ? cvm.fields.nvmePathsUp : null,
        arrayPathsTotal:
          typeof cvm.fields.nvmePathsTotal === 'number' ? cvm.fields.nvmePathsTotal : null,
      },
    };
    for (const iface of byKind('cvm-interface').filter((d) => d.parent === cvm.id)) {
      const service = str(iface.fields.service);
      const mine = Object.entries(paths).filter(([p]) => p.startsWith(`${iface.id}~`));
      let state: HopState = 'idle';
      let reason = '';
      let lane: HopLane = 'nvme';
      if (service === 'external-storage') {
        const live = mine.filter(([, st]) => st === 'live').length;
        if (sg !== 'up' || DOWN_STATUS.has(cvm.status)) {
          state = 'down';
          reason = `${cvmWhy(cvm)}: no I/O leaves through ${iface.label}`;
        } else if (mine.length === 0) {
          reason = 'no array paths configured on this interface';
        } else if (live === 0) {
          state = 'down';
          reason = `all ${mine.length} array paths via ${iface.label} are lost`;
        } else if (demand.length > 0) {
          state = stateOfDemand(demand);
          reason = `${live} of ${mine.length} array paths live (NVMe/TCP)`;
        } else {
          reason = `${live} of ${mine.length} array paths live; no VM I/O to carry`;
        }
      } else {
        lane = 'iscsi';
        if (sg !== 'up' || DOWN_STATUS.has(cvm.status)) {
          state = 'down';
          reason = cvmWhy(cvm);
        } else if (remote.length > 0) {
          state = stateOfDemand(remote);
          reason = `serves ${remote.length} VM session(s) redirected from other hosts over this interface`;
        } else {
          reason =
            'management interface; carries redirected VM I/O only when another host redirects here';
        }
      }
      addHop({
        from: sgId,
        to: iface.id,
        name: `Stargate to ${iface.label}`,
        state,
        reason,
        vms: service === 'external-storage' ? demand : remote,
        lane,
        redirected: service !== 'external-storage',
      });
    }
  }

  // ── Interface -> vswitch -> member NICs ─────────────────────────────────────────────────────
  const vswitchDemand = new Map<string, string[]>();
  const vswitchRedirected = new Map<string, boolean>();
  const vswitchStorage = new Set<string>();
  for (const iface of [...byKind('cvm-interface'), ...byKind('host-interface')]) {
    const vs = str(iface.fields.vswitch);
    if (!vs) continue;
    let ids: string[] = [];
    let redirected = false;
    if (iface.kind === 'cvm-interface' && iface.parent) {
      if (str(iface.fields.service) === 'external-storage') {
        ids = demandOf(iface.parent);
        if (ids.length) vswitchStorage.add(vs);
      } else {
        ids = remoteDemand.get(iface.parent) ?? [];
        redirected = true;
      }
    } else if (iface.parent) {
      ids = remoteOut.get(iface.parent) ?? [];
      redirected = true;
    }
    vswitchDemand.set(vs, [...new Set([...(vswitchDemand.get(vs) ?? []), ...ids])]);
    if (redirected && ids.length) vswitchRedirected.set(vs, true);
  }
  const usable = (vs: DeviceView): string[] =>
    parseJson<string[]>(vs.fields.members, []).filter((n) => !nicDown(n));

  for (const iface of [...byKind('cvm-interface'), ...byKind('host-interface')]) {
    const vs = str(iface.fields.vswitch);
    const vsDev = vs ? s.devices[vs] : undefined;
    if (!vs || !vsDev) continue;
    const up = usable(vsDev);
    const own =
      iface.kind === 'cvm-interface' && iface.parent
        ? str(iface.fields.service) === 'external-storage'
          ? demandOf(iface.parent)
          : (remoteDemand.get(iface.parent) ?? [])
        : iface.parent
          ? (remoteOut.get(iface.parent) ?? [])
          : [];
    const ifaceCvm =
      iface.kind === 'cvm-interface' && iface.parent ? s.devices[iface.parent] : undefined;
    const gone = ifaceCvm !== undefined && cvmDead(ifaceCvm);
    const state: HopState =
      up.length === 0 || gone ? 'down' : own.length > 0 ? stateOfDemand(own) : 'idle';
    addHop({
      from: iface.id,
      to: vs,
      name: `${iface.label} to ${vsDev.label}`,
      state,
      reason: gone
        ? `${cvmWhy(ifaceCvm as DeviceView)}: nothing enters ${vsDev.label} from ${iface.label}`
        : up.length === 0
          ? `${vsDev.label} has no member NIC with link: nothing leaves this host`
          : own.length > 0
            ? `traffic enters ${vsDev.label} and leaves on its member NIC`
            : `${vsDev.label} is ready; no I/O on this interface`,
      vms: own,
      lane:
        iface.kind === 'cvm-interface' && str(iface.fields.service) === 'external-storage'
          ? 'nvme'
          : 'iscsi',
      redirected:
        iface.kind !== 'cvm-interface' || str(iface.fields.service) !== 'external-storage',
    });
  }

  for (const vs of vswitches) {
    const members = parseJson<string[]>(vs.fields.members, []);
    if (members.length === 0) continue;
    const mode = str(vs.fields.bondMode) ?? str(vs.fields.mode) ?? 'no-bond';
    const pinning = parseJson<Record<string, string>>(vs.fields.pinning, {});
    const active = str(vs.fields.activeMember);
    const pinned = new Set(Object.values(pinning));
    const demand = vswitchDemand.get(vs.id) ?? [];
    const redirected = vswitchRedirected.get(vs.id) === true;
    const roles: string[] = [];
    for (const nic of members) {
      const dev = s.devices[nic];
      const down = nicDown(nic);
      const carrying =
        !down &&
        (pinned.has(nic) ||
          active === nic ||
          mode === 'balance-tcp' ||
          (members.length === 1 && !pinned.size));
      let state: HopState;
      let reason: string;
      if (down) {
        state = 'down';
        reason = `${short(dev, nic)} has no link${members.length > 1 ? ': the bond carries on the surviving member' : ': nothing else to carry this traffic'}`;
      } else if (carrying && demand.length > 0) {
        state = stateOfDemand(demand);
        reason = pinned.has(nic)
          ? `${vs.label} pins this traffic to ${short(dev, nic)}`
          : mode === 'balance-tcp'
            ? `${vs.label} (LACP) spreads flows over its members`
            : `${short(dev, nic)} is the active member of ${vs.label}`;
      } else if (carrying) {
        state = 'idle';
        reason = `${short(dev, nic)} is the carrying member; no I/O now`;
      } else {
        state = 'standby';
        reason = `standby member of ${vs.label}: takes over only if the active member fails`;
      }
      addHop({
        from: vs.id,
        to: nic,
        name: `${vs.label} to ${short(dev, nic)}`,
        state,
        reason,
        vms: state === 'active' || state === 'stalled' ? demand : [],
        lane: 'nvme',
        redirected: redirected && !vswitchStorage.has(vs.id),
      });
      const link = linkOfNic(nic);
      if (state === 'active' && link) activeLinks.add(link.id);
      if (members.length > 1 || down) {
        notes.set(nic, {
          text: down ? 'down' : carrying ? 'active' : 'standby',
          tone: down ? 'bad' : carrying ? 'ok' : 'muted',
        });
      }
      roles.push(`${short(dev, nic)} ${down ? 'down' : carrying ? 'active' : 'standby'}`);
    }
    if (members.length > 1) {
      notes.set(vs.id, {
        text: roles.join(' · '),
        tone: members.some(nicDown) ? 'bad' : 'muted',
      });
    }
  }

  // ── Array side: live paths light the port cable; ports with no path are "not connected" ──────
  const everPath = new Set<string>();
  for (const cvm of cvms) {
    const demand = demandOf(cvm.id);
    const paths = parseJson<Record<string, string>>(cvm.fields.nvmePaths, {});
    for (const [p, st] of Object.entries(paths)) {
      const fa = p.split('~')[1];
      if (!fa) continue;
      everPath.add(fa);
      if (st !== 'live' || demand.length === 0) continue;
      const nic = s.devices[fa]?.parent;
      const link = nic ? linkOfNic(nic) : undefined;
      if (link && link.status === 'up') activeLinks.add(link.id);
    }
  }
  for (const d of byKind('fa-interface')) {
    if (str(d.fields.service) !== 'nvme-tcp') continue;
    if (!everPath.has(d.id)) notes.set(d.id, { text: 'not connected (by design)', tone: 'muted' });
  }

  return { enabled, devices, hops: [...hops.values()], activeLinks, notes };
}

// ── Derived diagram data ───────────────────────────────────────────────────────────────────────

/** Hops as links, so the diagram's anchors, routing and edges treat them like cables. */
export function hopLinks(model: DataPathModel): Record<string, LinkView> {
  const out: Record<string, LinkView> = {};
  for (const h of model.hops) {
    out[h.id] = {
      id: h.id,
      a: { device: h.from, port: `${h.id}:a` },
      b: { device: h.to, port: `${h.id}:b` },
      status: h.state === 'down' ? 'down' : 'up',
      mtu: 0,
      latencyMs: 0,
      util: {},
    };
  }
  return out;
}

/**
 * Slow continuous dots on every hop that carries I/O: redirector hops show writes toward the array and
 * reads coming back, NVMe/TCP hops show both directions in one category. Stalled, down, idle and
 * standby hops carry no dots.
 */
export function hopFlows(
  model: DataPathModel,
  visible: (category: TrafficCategory) => boolean = () => true,
): LinkFlow[] {
  const out: LinkFlow[] = [];
  for (const h of model.hops) {
    if (h.state !== 'active') continue;
    const streams: { category: TrafficCategory; forward: boolean }[] =
      h.lane === 'iscsi'
        ? [
            { category: 'io-write', forward: true },
            { category: 'io-read', forward: false },
          ]
        : [
            { category: 'nvme-io', forward: true },
            { category: 'nvme-io', forward: false },
          ];
    for (const st of streams) {
      if (!visible(st.category)) continue;
      out.push({
        linkId: h.id,
        category: st.category,
        forward: st.forward,
        end: 1,
        age: 0,
        count: 1,
      });
    }
  }
  return out;
}

/**
 * Put the derived boxes into the layout: the redirector in the row between the VMs and the CVM,
 * Stargate in the row above the CVM interfaces (rows reserved by `DATA_PATH_BAND`).
 */
export function placeDataPath(
  model: DataPathModel,
  devices: Readonly<Record<string, DeviceView>>,
  layout: LayoutMap,
): { devices: Readonly<Record<string, DeviceView>>; layout: LayoutMap } {
  if (!model.enabled) return { devices, layout };
  const outDevices: Record<string, DeviceView> = { ...devices };
  const outLayout: Record<string, LayoutMap[string]> = { ...layout };
  const boxes = (ids: readonly string[]) =>
    ids.map((id) => layout[id]).filter((b): b is NonNullable<typeof b> => b !== undefined);
  for (const d of Object.values(model.devices)) {
    const parent = d.parent ?? '';
    if (d.kind === 'stargate') {
      const ifaces = boxes(
        Object.values(devices)
          .filter((x) => x.kind === 'cvm-interface' && x.parent === parent)
          .map((x) => x.id),
      );
      if (ifaces.length === 0) continue;
      const x0 = Math.min(...ifaces.map((b) => b.x));
      const x1 = Math.max(...ifaces.map((b) => b.x + (b.w ?? 0)));
      const top = Math.min(...ifaces.map((b) => b.y));
      const { h, gap } = DATA_PATH_BAND.stargate;
      outDevices[d.id] = d;
      outLayout[d.id] = { x: x0, y: top - gap - h, w: x1 - x0, h };
    } else if (d.kind === 'vm-spacer') {
      const ifaces = boxes(
        Object.values(devices)
          .filter((x) => x.kind === 'cvm-interface' && x.parent === `${parent}.cvm`)
          .map((x) => x.id),
      );
      if (ifaces.length === 0) continue;
      const x0 = Math.min(...ifaces.map((b) => b.x));
      const x1 = Math.max(...ifaces.map((b) => b.x + (b.w ?? 0)));
      const top = Math.min(...ifaces.map((b) => b.y));
      outDevices[d.id] = d;
      outLayout[d.id] = { x: x0, y: top - VM_TO_IFACE_ROW, w: x1 - x0, h: VM_ROW.h };
    } else {
      const own = Object.values(devices).filter((x) => x.kind === 'vm' && x.parent === parent);
      const vmBoxes = boxes(own.map((x) => x.id));
      if (vmBoxes.length === 0) continue;
      const cvm = Object.values(devices).find((x) => x.kind === 'cvm' && x.parent === parent);
      const ifaceBoxes = boxes(
        Object.values(devices)
          .filter((x) => x.kind === 'cvm-interface' && x.parent === cvm?.id)
          .map((x) => x.id),
      );
      const span = ifaceBoxes.length > 0 ? ifaceBoxes : vmBoxes;
      const x0 = Math.min(...span.map((b) => b.x));
      const x1 = Math.max(...span.map((b) => b.x + (b.w ?? 0)));
      const bottom = Math.max(...vmBoxes.map((b) => b.y + (b.h ?? 0)));
      outDevices[d.id] = d;
      outLayout[d.id] = {
        x: x0,
        y: bottom + 20,
        w: x1 - x0,
        h: DATA_PATH_BAND.redirector.h,
      };
    }
  }
  return { devices: outDevices, layout: outLayout };
}
