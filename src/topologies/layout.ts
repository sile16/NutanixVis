/**
 * Layout helper: computes React Flow positions from the topology's structure.
 * Convention: top-level nodes are absolute; children are relative to their parent's top-left.
 * Every box sits on a 20 px grid. Rows: hosts (top), switches (middle), FlashArray (bottom).
 * Without an array the switches are the bottom row.
 */
import type { z } from 'zod';
import type { LayoutSchema } from './schema';

export type Layout = z.input<typeof LayoutSchema>;
export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

export const GRID = 20;
const PAD = 20;
const GAP = 20;
const HEADER = 40;
const ROW_GAP = 160;
const HOST_GAP = 40;

const VM = { w: 100, h: 40 };
const DISK = { w: 40, h: 40 };
const NIC = { w: 60, h: 40 };
const CVM_IF = { w: 80, h: 20 };
const HOST_IF = { w: 80, h: 20 };
const CVM_H = HEADER + CVM_IF.h + PAD;
const VSWITCH_H = 40;
const NIC_GROUP_GAP = 40;
const SWITCH = { w: 240, h: 60 };
const FA_PORT_W = 100;
const FA_IF = { w: 60, h: 20 };
const FA_HEADER = 60;
const FA_VIP = { w: 80, h: 20 };

const snapDown = (v: number) => Math.floor(v / GRID) * GRID;
const snapUp = (v: number) => Math.ceil(v / GRID) * GRID;

/** Width of `n` items of width `w` separated by `gap`. */
const rowWidth = (n: number, w: number, gap = GAP) => (n > 0 ? n * w + (n - 1) * gap : 0);

export interface HostBoxSpec {
  id: string;
  vms: readonly string[];
  cvm?: { id: string; ifaces: readonly string[] };
  disks: readonly string[];
  /** Host IPs (`host-interface`), drawn in a row just above their vswitch. */
  hostIfaces?: readonly { id: string; vswitch: string }[];
  /** NICs grouped under the vswitch they nominally belong to (stable across bond-mode changes). */
  groups: readonly { vswitch: string; nics: readonly string[] }[];
}

export interface FaBoxSpec {
  id: string;
  vip?: string;
  controllers: readonly {
    id: string;
    ports: readonly { id: string; ifaces: readonly string[] }[];
  }[];
}

export interface LayoutSpec {
  hosts: readonly HostBoxSpec[];
  switches: readonly string[];
  fa?: FaBoxSpec;
}

const cvmWidth = (n: number) => Math.max(160, rowWidth(n, CVM_IF.w) + 2 * PAD);
const groupWidth = (nics: number) => Math.max(NIC.w, rowWidth(nics, NIC.w));

function hostMetrics(h: HostBoxSpec) {
  const nicRow =
    rowWidth(h.groups.length, 0, NIC_GROUP_GAP) +
    h.groups.reduce((s, g) => s + groupWidth(g.nics.length), 0);
  const content = Math.max(
    rowWidth(h.vms.length, VM.w),
    h.cvm ? cvmWidth(h.cvm.ifaces.length) : 0,
    rowWidth(h.disks.length, DISK.w),
    nicRow,
  );
  let top = HEADER;
  if (h.vms.length) top += VM.h + GAP;
  if (h.cvm) top += CVM_H + GAP;
  if (h.disks.length) top += DISK.h + GAP;
  if (h.hostIfaces?.length) top += HOST_IF.h + GAP;
  const bottom = VSWITCH_H + GAP + NIC.h;
  return { w: snapUp(Math.max(200, content + 2 * PAD)), h: snapUp(top + bottom), nicRow };
}

/** Lay out one host group of fixed size `w`×`h`; returns child boxes (relative). */
function layoutHost(h: HostBoxSpec, w: number, hh: number, nicRow: number, out: Layout): void {
  const center = (rw: number) => snapDown((w - rw) / 2);
  let y = HEADER;
  if (h.vms.length) {
    const x0 = center(rowWidth(h.vms.length, VM.w));
    h.vms.forEach((id, i) => {
      out[id] = { x: x0 + i * (VM.w + GAP), y, ...VM };
    });
    y += VM.h + GAP;
  }
  if (h.cvm) {
    const cw = cvmWidth(h.cvm.ifaces.length);
    out[h.cvm.id] = { x: center(cw), y, w: cw, h: CVM_H };
    const ix0 = snapDown((cw - rowWidth(h.cvm.ifaces.length, CVM_IF.w)) / 2);
    h.cvm.ifaces.forEach((id, i) => {
      out[id] = { x: ix0 + i * (CVM_IF.w + GAP), y: HEADER, ...CVM_IF };
    });
    y += CVM_H + GAP;
  }
  if (h.disks.length) {
    const x0 = center(rowWidth(h.disks.length, DISK.w));
    h.disks.forEach((id, i) => {
      out[id] = { x: x0 + i * (DISK.w + GAP), y, ...DISK };
    });
  }
  // NICs flush with the bottom edge; each vswitch spans its NIC group just above.
  const nicY = hh - NIC.h;
  const vsY = nicY - GAP - VSWITCH_H;
  let gx = center(nicRow);
  for (const g of h.groups) {
    const gw = groupWidth(g.nics.length);
    out[g.vswitch] = { x: gx, y: vsY, w: gw, h: VSWITCH_H };
    // Host IPs on this vswitch sit side by side above it, left-aligned with the group.
    (h.hostIfaces ?? [])
      .filter((hi) => hi.vswitch === g.vswitch)
      .forEach((hi, i) => {
        out[hi.id] = { x: gx + i * (HOST_IF.w + GAP), y: vsY - GAP - HOST_IF.h, ...HOST_IF };
      });
    g.nics.forEach((id, i) => {
      out[id] = { x: gx + i * (NIC.w + GAP), y: nicY, ...NIC };
    });
    gx += gw + NIC_GROUP_GAP;
  }
}

function faMetrics(fa: FaBoxSpec) {
  const maxIfaces = Math.max(
    1,
    ...fa.controllers.flatMap((c) => c.ports.map((p) => p.ifaces.length)),
  );
  const portH = GRID + maxIfaces * FA_IF.h + PAD;
  const maxPorts = Math.max(1, ...fa.controllers.map((c) => c.ports.length));
  const ctW = 2 * PAD + rowWidth(maxPorts, FA_PORT_W);
  const ctH = portH + 3 * GRID;
  const w = 2 * PAD + rowWidth(fa.controllers.length, ctW, 2 * GAP);
  return { portH, ctW, ctH, w, h: FA_HEADER + ctH + PAD };
}

function layoutFa(fa: FaBoxSpec, out: Layout): void {
  const m = faMetrics(fa);
  if (fa.vip) out[fa.vip] = { x: m.w - PAD - FA_VIP.w, y: GRID, ...FA_VIP };
  fa.controllers.forEach((c, ci) => {
    out[c.id] = { x: PAD + ci * (m.ctW + 2 * GAP), y: FA_HEADER, w: m.ctW, h: m.ctH };
    // Ports along the controller's top edge, their IPs stacked inside.
    c.ports.forEach((p, pi) => {
      out[p.id] = { x: PAD + pi * (FA_PORT_W + GAP), y: 0, w: FA_PORT_W, h: m.portH };
      p.ifaces.forEach((id, ii) => {
        out[id] = { x: GRID, y: GRID + ii * FA_IF.h, ...FA_IF };
      });
    });
  });
}

export function computeLayout(spec: LayoutSpec): Layout {
  const out: Layout = {};
  const metrics = spec.hosts.map(hostMetrics);
  const hostH = Math.max(0, ...metrics.map((m) => m.h));
  const hostsW =
    metrics.reduce((s, m) => s + m.w, 0) + Math.max(0, spec.hosts.length - 1) * HOST_GAP;
  const fa = spec.fa ? faMetrics(spec.fa) : undefined;
  const switchesMinW = rowWidth(spec.switches.length, SWITCH.w, 4 * GAP);
  const total = Math.max(hostsW, fa?.w ?? 0, switchesMinW);

  let x = snapDown((total - hostsW) / 2);
  spec.hosts.forEach((h, i) => {
    const m = metrics[i];
    if (!m) return;
    out[h.id] = { x, y: 0, w: m.w, h: hostH };
    layoutHost(h, m.w, hostH, m.nicRow, out);
    x += m.w + HOST_GAP;
  });

  // Switches spread evenly under the hosts (A left, B right).
  const swY = hostH + ROW_GAP;
  const n = spec.switches.length;
  let prevRight = Number.NEGATIVE_INFINITY;
  spec.switches.forEach((id, i) => {
    const centerX = (total * (i + 1)) / (n + 1);
    const sx = Math.max(snapDown(centerX - SWITCH.w / 2), prevRight + 4 * GAP);
    out[id] = { x: sx, y: swY, ...SWITCH };
    prevRight = sx + SWITCH.w;
  });

  if (spec.fa && fa) {
    out[spec.fa.id] = {
      x: snapDown((total - fa.w) / 2),
      y: swY + SWITCH.h + ROW_GAP,
      w: fa.w,
      h: fa.h,
    };
    layoutFa(spec.fa, out);
  }
  return out;
}

/** Stable, sorted JSON for the dev-only "Copy layout JSON" button (SPEC §6.5). */
export function layoutJson(layout: Layout): string {
  const sorted = Object.fromEntries(Object.entries(layout).sort(([a], [b]) => a.localeCompare(b)));
  return JSON.stringify(sorted, null, 2);
}
