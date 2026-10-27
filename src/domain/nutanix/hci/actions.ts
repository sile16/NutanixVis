/** HCI data-path actions (SPEC §5.5): `disk.fail`, `disk.recover`, `hci.set-capacity`. */
import { type ActionDefinition, isLinkView, numberParam } from '../../../engine/actions';
import type { DeviceId } from '../../../engine/types';
import type { DiskDevice } from './disk';
import type { HciStore } from './store';

export const CAPACITY_CHOICES = [10, 20, 50, 70, 80, 90, 94, 95, 98] as const;

export function hciActions(
  store: HciStore,
  disks: ReadonlyMap<DeviceId, DiskDevice>,
): ActionDefinition[] {
  return [
    {
      spec: {
        kind: 'disk.fail',
        label: 'Fail disk',
        description:
          'The disk faults: Stargate marks it offline and Curator re-replicates its data. No HA event (Bible 4i).',
        appliesTo: (t) => !isLinkView(t) && disks.get(t.id)?.isFaulted === false,
      },
      apply: (req, ctx) => ctx.failDevice(req.target),
    },
    {
      spec: {
        kind: 'disk.recover',
        label: 'Recover disk',
        description:
          'Clear the fault: Hades runs a SMART check and returns the disk unless it went offline too often within an hour. On a disk kept offline, an operator re-adds it.',
        appliesTo: (t) => {
          const d = isLinkView(t) ? undefined : disks.get(t.id);
          return d !== undefined && (d.isFaulted || d.diskState === 'failed');
        },
      },
      apply: (req, ctx) => {
        const d = disks.get(req.target);
        if (d === undefined) return;
        if (d.isFaulted) ctx.recoverDevice(req.target);
        else d.reAdd(ctx.emit, ctx.causeIds);
      },
    },
    {
      spec: {
        kind: 'hci.set-capacity',
        label: 'Set storage used %',
        description: `Cluster-wide physical used capacity. Stargate goes read-only at the profile's read-only threshold (Bible 4i).`,
        appliesTo: (t) => !isLinkView(t) && (t.kind === 'cvm' || t.kind === 'disk'),
        params: { usedPct: { label: 'Used (% of raw)', choices: CAPACITY_CHOICES } },
      },
      apply: (req) => store.setUsedCapacityPct(numberParam(req, 'usedPct')),
    },
  ];
}
