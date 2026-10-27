/**
 * Topology contract — declarative, validated topology data (SPEC §4, §6.5, §13.1).
 * Topologies are data: adding one must not require engine changes.
 * Owned by the integrator; stream D authors topologies against it.
 */
import { z } from 'zod';

const id = z.string().regex(/^[a-z0-9][a-z0-9._-]*$/, 'lower-case id');

export const VlanSchema = z.object({
  id: z.number().int().min(1).max(4094),
  name: z.string(),
  purpose: z.enum(['mgmt', 'storage', 'backplane', 'vm', 'live-migration']),
});

export const BondModeSchema = z.enum(['active-backup', 'balance-slb', 'balance-tcp', 'no-bond']);
export type BondMode = z.infer<typeof BondModeSchema>;

const base = {
  id,
  label: z.string(),
  parent: id.optional(),
};

/** Physical NIC on a host, or a front-end/mgmt port on an array controller. */
const NicSpec = z.object({
  ...base,
  kind: z.literal('nic'),
  speedGbps: z.number().positive(),
  mtu: z.number().int().min(1280).max(9216).default(9000),
});

const SwitchSpec = z.object({
  ...base,
  kind: z.literal('switch'),
  /** VLANs this switch carries (trunked on its ports unless a link overrides). */
  vlans: z.array(z.number().int()),
  mtu: z.number().int().default(9216),
  /** Switches sharing an MLAG domain can form a cross-switch LAG for LACP. */
  mlagDomain: z.string().optional(),
  /**
   * Ethernet flow control. Everpure: "Do not enable Priority Flow Control (PFC) or Global Pause"
   * for NVMe/TCP (NET KB), so anything but `off` is a misconfiguration.
   */
  flowControl: z.enum(['off', 'global-pause', 'pfc']).default('off'),
});

/** AHV host. `role` selects HCI vs compute-only vs storage-only (SPEC §6.3a). */
const HostSpec = z.object({
  ...base,
  kind: z.literal('ahv-host'),
  role: z.enum(['hci', 'compute-only', 'storage-only', 'external-storage-compute']),
  block: z.string().optional(),
  rack: z.string().optional(),
});

/** AHV virtual switch (vs0, vs1…) with its uplink bond. */
const VSwitchSpec = z.object({
  ...base,
  kind: z.literal('vswitch'),
  name: z.string(),
  bondMode: BondModeSchema,
  /** Active bond members. */
  uplinks: z.array(id).min(0),
  /** NICs cabled for this vswitch (superset of `uplinks`); candidates for `vswitch.set-uplinks`. */
  members: z.array(id).optional(),
  lacpRate: z.enum(['fast', 'slow']).optional(),
  mtu: z.number().int().default(1500),
});

/** CVM on an HCI/SO/T1 host. Absent on compute-only hosts. */
const CvmSpec = z.object({ ...base, kind: z.literal('cvm') });

/**
 * A network segment the CVM participates in (e.g. an External Storage internal interface).
 * Each one gives the CVM one vNIC + one IP on that VLAN via the named vswitch.
 */
const CvmInterfaceSpec = z.object({
  ...base,
  kind: z.literal('cvm-interface'),
  vswitch: id,
  vlan: z.number().int(),
  ip: z.string(),
  service: z.enum(['mgmt', 'external-storage', 'backplane']),
});

/** An AHV host IP on a vswitch (e.g. a compute-only host's mgmt IP its redirector uses). */
const HostInterfaceSpec = z.object({
  ...base,
  kind: z.literal('host-interface'),
  vswitch: id,
  vlan: z.number().int(),
  ip: z.string(),
  service: z.enum(['mgmt']),
});

const DiskSpec = z.object({
  ...base,
  kind: z.literal('disk'),
  media: z.enum(['nvme', 'ssd', 'hdd']),
  capacityTiB: z.number().positive(),
});

const VmSpec = z.object({
  ...base,
  kind: z.literal('vm'),
  vdisks: z.number().int().min(1).default(1),
  /** Per-VM force-shutdown timeout on storage path loss (T1), seconds; absent = retry forever. */
  pathLossForceShutdownS: z.number().int().positive().optional(),
});

const ArraySpec = z.object({
  ...base,
  kind: z.literal('fa-array'),
  model: z.string(),
});

const ControllerSpec = z.object({
  ...base,
  kind: z.literal('fa-controller'),
  slot: z.enum(['ct0', 'ct1']),
  initialRole: z.enum(['primary', 'secondary']),
});

/** An IP on an FA port (one port may carry several, e.g. VLAN interfaces). */
const FaInterfaceSpec = z.object({
  ...base,
  kind: z.literal('fa-interface'),
  nic: id,
  vlan: z.number().int(),
  ip: z.string(),
  service: z.enum(['nvme-tcp', 'mgmt', 'replication']),
  /** Floating IP (e.g. the array mgmt VIP) that moves to whichever controller is primary. */
  floating: z.boolean().default(false),
});

const ExternalSpec = z.object({
  ...base,
  kind: z.enum(['site', 'cluster', 'prism-central', 'witness']),
});

export const DeviceSpecSchema = z.discriminatedUnion('kind', [
  NicSpec,
  SwitchSpec,
  HostSpec,
  VSwitchSpec,
  CvmSpec,
  CvmInterfaceSpec,
  HostInterfaceSpec,
  DiskSpec,
  VmSpec,
  ArraySpec,
  ControllerSpec,
  FaInterfaceSpec,
  ExternalSpec,
]);
export type DeviceSpec = z.infer<typeof DeviceSpecSchema>;

export const LinkSpecSchema = z.object({
  id,
  /** Device ids of the two NIC/switch endpoints; switch ports are created on demand. */
  a: id,
  b: id,
  kind: z.enum(['cable', 'isl']).default('cable'),
  mtu: z.number().int().optional(),
  latencyMs: z.number().min(0).default(0),
  /** Restrict the VLANs carried on this switch port (strict A/B, VLAN pruning). */
  allowedVlans: z.array(z.number().int()).optional(),
});
export type LinkSpec = z.infer<typeof LinkSpecSchema>;

/** A user-selectable variant knob (bond mode, fabric layout, node count…). */
export const OptionSpecSchema = z.object({
  id,
  label: z.string(),
  choices: z.array(z.union([z.string(), z.number(), z.boolean()])).min(1),
  default: z.union([z.string(), z.number(), z.boolean()]),
  /** Value this topology instance was built with; absent means `default`. */
  value: z.union([z.string(), z.number(), z.boolean()]).optional(),
  /** Option values may be changed mid-scenario as runtime actions (SPEC §5.5). */
  runtime: z.boolean().default(false),
});

export const LayoutSchema = z.record(
  z.string(),
  z.object({
    x: z.number(),
    y: z.number(),
    w: z.number().positive().optional(),
    h: z.number().positive().optional(),
  }),
);

export const TopologySchema = z
  .object({
    id,
    title: z.string(),
    family: z.enum(['t1', 't1-lab', 't2', 't3']),
    description: z.string(),
    vlans: z.array(VlanSchema),
    devices: z.array(DeviceSpecSchema).min(1),
    links: z.array(LinkSpecSchema),
    options: z.array(OptionSpecSchema).default([]),
    layout: LayoutSchema.default({}),
  })
  .superRefine((t, ctx) => {
    const ids = new Set<string>();
    for (const d of t.devices) {
      if (ids.has(d.id)) ctx.addIssue({ code: 'custom', message: `duplicate device id ${d.id}` });
      ids.add(d.id);
    }
    for (const d of t.devices) {
      if (d.parent && !ids.has(d.parent)) {
        ctx.addIssue({ code: 'custom', message: `${d.id}: unknown parent ${d.parent}` });
      }
    }
    for (const l of t.links) {
      for (const end of [l.a, l.b]) {
        if (!ids.has(end)) ctx.addIssue({ code: 'custom', message: `${l.id}: unknown end ${end}` });
      }
    }
  });

export type Topology = z.infer<typeof TopologySchema>;
export type TopologyInput = z.input<typeof TopologySchema>;

/** Author helper: validates at load time and returns the parsed (defaults-filled) topology. */
export function defineTopology(input: TopologyInput): Topology {
  return TopologySchema.parse(input);
}
