/**
 * The external-storage backend one CVM gets in T1/T1-lab: the NVMe/TCP initiator (data path) plus
 * the FlashArray management-API client (Nutanix drives the array through its REST API at the
 * mgmt VIP: DEPLOY-GUIDE; Bible 8c). If the API is unreachable or slow, snapshot and provisioning
 * tasks fail but running IO is unaffected (SPEC §6.4 "Management").
 */
import { asEngineContext, type EngineTickContext } from '../../engine/context';
import type { DeviceId, EndpointId, Message, SimTime, ViewField } from '../../engine/types';
import type { KnownCitationId } from '../citations';
import type {
  ClusterView,
  Ctx,
  CvmComponent,
  IoCompletion,
  IoRequest,
  StorageBackend,
} from '../contracts';
import type { CauseIndex } from '../nvme-tcp/causes';
import { NvmeTcpInitiator } from '../nvme-tcp/initiator';
import { FA_MGMT_PORT, type MgmtPayload, NVME_MSG } from '../nvme-tcp/protocol';
import type { Profile } from '../versions/profile';
import { warnFlowControl } from './devices';
import type { FaFacts } from './facts';
import type { FlashArrayModel, SnapshotRequest } from './model';

/** Ephemeral source port of this CVM's API session to the array. */
const MGMT_SRC_PORT = 50443;
const MGMT_CITE = ['ntnx-ncp-everpure-deploy-7.6', 'ntnx-bible-8c'] satisfies KnownCitationId[];

interface Call {
  readonly msgId: string;
  readonly sentAt: SimTime;
  readonly task: SnapshotRequest | null;
}

/** Array API calls from this CVM's mgmt interface to the VIP: a per-tick session poll + tasks. */
export class FaMgmtClient implements CvmComponent {
  readonly name = 'fa-mgmt-client';
  private calls: Call[] = [];

  constructor(
    private readonly cvm: DeviceId,
    private readonly model: FlashArrayModel,
    private readonly facts: FaFacts,
  ) {}

  private get endpoint(): EndpointId | undefined {
    return this.facts.mgmtEndpoint.get(this.cvm);
  }

  /** The CVM that runs a VM's array task: its host's CVM, else the first up CVM. */
  private ownerOf(vm: DeviceId, ctx: EngineTickContext<Profile>): DeviceId | undefined {
    const live = ctx.prev.devices[vm]?.fields.host;
    const host = typeof live === 'string' ? live : this.facts.hostOfVm.get(vm);
    const mine = host === undefined ? undefined : this.facts.cvmOfHost.get(host);
    if (mine !== undefined && ctx.isUp(mine)) return mine;
    return this.facts.cvms.find((c) => ctx.isUp(c));
  }

  emit(c: Ctx): void {
    const ctx = asEngineContext(c);
    const ep = this.endpoint;
    const vip = this.facts.vip;
    if (ep === undefined || vip === null) return;
    const call = (task: SnapshotRequest | null) => {
      const payload: MgmtPayload = {
        task: task ? 'snapshot' : 'poll',
        host: this.cvm,
        ...(task ? { vm: task.vm } : {}),
      };
      const msgId = ctx.send({
        kind: NVME_MSG.mgmt,
        src: ep,
        dst: vip,
        size: 'small',
        flow: ctx.flow(ep, vip, { srcPort: MGMT_SRC_PORT, dstPort: FA_MGMT_PORT }),
        payload,
      });
      this.calls.push({ msgId, sentAt: ctx.now, task });
    };
    call(null);
    const reqs = this.model.snapshotRequests;
    for (let i = 0; i < reqs.length; ) {
      const r = reqs[i] as SnapshotRequest;
      if (this.ownerOf(r.vm, ctx) === this.cvm) {
        reqs.splice(i, 1);
        call(r);
      } else i++;
    }
  }

  tick(c: Ctx): void {
    const ctx = asEngineContext(c);
    const keep: Call[] = [];
    for (const call of this.calls) {
      const t = ctx.trace(call.msgId);
      if (!t && ctx.now - call.sentAt < 1) {
        keep.push(call);
        continue;
      }
      const ok = t?.result === 'delivered';
      if (call.task === null) {
        if (ok) this.model.mgmtSeen.set(this.cvm, ctx.now);
        continue;
      }
      ctx.emit({
        severity: ok ? 'info' : 'warn',
        deviceId: call.task.vm,
        code: ok ? 'mgmt.task.succeeded' : 'mgmt.task.failed',
        text: ok
          ? `Snapshot of ${call.task.vm} taken on the array`
          : `Snapshot of ${call.task.vm} failed: array management API unreachable from ${this.cvm} (running IO is unaffected)`,
        causeIds: call.task.causes,
        cite: MGMT_CITE,
        confidence: 'verified',
      });
    }
    this.calls = keep;
  }

  onFail(): void {
    this.calls = [];
    this.model.mgmtSeen.delete(this.cvm);
  }
}

/** `StorageBackend` (kind `external-nvme`) for one CVM: NVMe/TCP initiator + array API client. */
export class ExternalStorageBackend implements StorageBackend {
  readonly kind = 'external-nvme' as const;
  readonly name = 'external-storage';
  readonly nvme: NvmeTcpInitiator;
  readonly mgmt: FaMgmtClient;

  constructor(
    readonly cvm: DeviceId,
    private readonly model: FlashArrayModel,
    facts: FaFacts,
    profile: Profile,
    causes: CauseIndex,
  ) {
    const pathsFor = (eps: readonly EndpointId[]) =>
      eps.flatMap((local) => {
        const vlan = facts.cvmIfaceVlan.get(local);
        return facts.interfaces
          .filter((i) => i.service === 'nvme-tcp' && i.vlan === vlan)
          .map((i) => ({ local, remote: i.id }));
      });
    this.nvme = new NvmeTcpInitiator({
      cvm,
      profile,
      policy: facts.multipathPolicy,
      selector: facts.pathSelector,
      paths: pathsFor(facts.storageEndpoints.get(cvm) ?? []),
      pathsFor,
      causes,
    });
    this.mgmt = new FaMgmtClient(cvm, model, facts);
  }

  attach(cluster: ClusterView): void {
    this.nvme.attach(cluster);
  }
  acquire(vdisk: string, ctx: Ctx): void {
    this.nvme.acquire(vdisk, ctx);
  }
  release(vdisk: string, ctx: Ctx): void {
    this.nvme.release(vdisk, ctx);
  }
  submit(req: IoRequest, ctx: Ctx): void {
    this.nvme.submit(req, ctx);
  }
  drain(): readonly IoCompletion[] {
    return this.nvme.drain();
  }
  health(): 'ok' | 'degraded' | 'unavailable' {
    return this.nvme.health();
  }
  lostByTarget(): boolean {
    return this.nvme.lostByTarget();
  }
  /**
   * NVMe path ids, then the bond member NICs those paths' frames egressed on, during the last
   * tick. The contract allows links/endpoints here; the Nutanix registry splits path ids (`~`)
   * from NIC ids to fill the VM's `ioPaths` / `ioUplinks` (docs/view-fields.md).
   */
  pathsFor(vdisk: string): readonly string[] {
    return this.nvme.pathsFor(vdisk);
  }
  /** Bond member NICs its IO egressed on during the last tick (vm `ioUplinks`). */
  uplinksFor(vdisk: string): readonly string[] {
    return this.nvme.uplinksFor(vdisk);
  }

  preTick(ctx: Ctx): void {
    this.model.observe(ctx.now);
    warnFlowControl(this.model, ctx);
    this.nvme.preTick(ctx);
  }
  emit(ctx: Ctx): void {
    this.nvme.emit(ctx);
    this.mgmt.emit(ctx);
  }
  onMessage(msg: Message, ctx: Ctx): boolean {
    return this.nvme.onMessage(msg, ctx);
  }
  tick(ctx: Ctx): void {
    this.nvme.tick(ctx);
    this.mgmt.tick(ctx);
  }
  onFail(): void {
    this.nvme.onFail();
    this.mgmt.onFail();
  }
  onRecover(ctx: Ctx): void {
    this.nvme.onRecover(ctx);
  }
  viewFields(): Readonly<Record<string, ViewField>> {
    return this.nvme.viewFields();
  }
}
