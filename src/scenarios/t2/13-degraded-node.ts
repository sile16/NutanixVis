import { defineScenario } from '../define';
import {
  alwaysFrom,
  at,
  atCtx,
  baseInvariants,
  cvm,
  derived,
  eventSeen,
  eventsInOrder,
  firstEventAt,
  isRunning,
  isStalled,
  storageAvailable,
  T0,
  vmsOfNode,
} from '../helpers';
import { cvmId, T2 } from '../ids';
import { P } from '../timers';

const FLAPPY = cvmId(3);
const SECOND = cvmId(2);
const BLACKOUT_S = 10;
const WINDOW = P.dnd.scoringWindowS;
const SECOND_AT = T0 + WINDOW + 30;
const FIXED_AT = SECOND_AT + 60;
const END = FIXED_AT + 40;

/**
 * Degraded Node Detection (SPEC §6.2 "Degraded Node Detection"). CVM 3's inter-CVM interface
 * stops answering for a few seconds, then returns: a flapping node. Its peers score it
 * unresponsive, and at the end of the scoring window (`dnd.scoringWindowS`, `assumption`) it is
 * marked Degraded: its Cassandra goes to forwarding mode (metadata store disabled), the cluster's
 * node-failure tolerance drops and an alert is raised. It is not cleared automatically for a
 * long time (`dnd.autoResolveHealthyS`). While it is Degraded, a second CVM outage leaves some
 * metadata ranges without a Paxos majority, so cluster storage goes down, though only one CVM is
 * actually down. Marking the node fixed brings its metadata store back and storage returns.
 */
export default defineScenario({
  id: 't2-13-degraded-node-then-second-cvm',
  title: 'T2: a flapping CVM is marked Degraded, then a second CVM goes down',
  topology: T2.topology,
  durationS: END,
  timeline: [
    {
      at: T0,
      action: { kind: 'cvm.network-flap', target: FLAPPY, params: { durationS: BLACKOUT_S } },
      note: `CVM 3 stops answering its peers for ${BLACKOUT_S} s.`,
    },
    {
      at: SECOND_AT,
      action: { kind: 'power-off', target: SECOND },
      note: 'CVM 2 is powered off while CVM 3 is still Degraded.',
    },
    {
      at: FIXED_AT,
      action: { kind: 'cvm.mark-fixed', target: FLAPPY },
      note: 'The operator marks CVM 3 fixed.',
    },
  ],
  expect: [
    at(
      T0,
      'steady state: storage available, FT 1',
      (s) => storageAvailable(s) && derived(s).nodeFailureTolerance === 1,
    ),
    at(
      T0 + BLACKOUT_S + 3,
      'CVM 3 answers again; it is being scored, not yet Degraded',
      (s) => cvm(s, 3).zkQuorum && cvm(s, 3).dndState === 'scoring',
    ),
    atCtx(
      T0 + WINDOW + 5,
      'at the end of the scoring window CVM 3 is marked Degraded',
      (s, ctx) => {
        const t = firstEventAt(ctx, 'dnd.node.degraded', { device: FLAPPY });
        return t !== null && t >= T0 + WINDOW && cvm(s, 3).dndState === 'degraded';
      },
    ),
    at(
      SECOND_AT - 1,
      'its metadata store is in forwarding mode and the cluster tolerates no failure',
      (s) =>
        cvm(s, 3).ringState === 'forwarding' &&
        derived(s).metadataAvailable &&
        derived(s).nodeFailureTolerance === 0,
    ),
    alwaysFrom(
      T0 + WINDOW + 5,
      'it is not cleared on its own within minutes',
      (s) => s.simTime >= FIXED_AT || cvm(s, 3).dndState === 'degraded',
    ),
    at(
      SECOND_AT + 3,
      'one more CVM down: metadata loses its majority, storage is unavailable',
      (s) => !derived(s).metadataAvailable && !storageAvailable(s),
    ),
    at(FIXED_AT - 1, 'VM IO on the surviving nodes hangs', (s) => vmsOfNode(s, 1).every(isStalled)),
    at(
      FIXED_AT + 3,
      'marked fixed: metadata has its majority again',
      (s) => cvm(s, 3).dndState === 'ok' && derived(s).metadataAvailable,
    ),
    at(
      END,
      'storage is back and VMs on the surviving nodes run',
      (s) => derived(s).metadataAvailable && vmsOfNode(s, 1).every(isRunning),
    ),
    atCtx(
      END,
      'order: blackout, Degraded, metadata lost, cleared',
      (_s, ctx) =>
        eventsInOrder(ctx, [
          { code: 'cvm.network.blackout', device: FLAPPY },
          { code: 'dnd.node.degraded', device: FLAPPY },
          { code: 'dnd.node.cleared', device: FLAPPY },
        ]) && eventSeen(ctx, 'cluster.services.down'),
    ),
    ...baseInvariants(),
  ],
  narrative: `CVM 3's network flaps: its inter-CVM interface stops answering for ${BLACKOUT_S} s and then returns. Degraded Node Detection scores it as unresponsive and, at the end of the ${WINDOW} s window, marks it Degraded: its metadata store goes to forwarding mode, so the cluster no longer tolerates a node failure, and the flag stays for a long time unless an operator clears it. When CVM 2 is then powered off, some metadata ranges are left without a majority and cluster storage stops, although only one CVM is down; marking CVM 3 fixed brings its metadata store back and storage returns.`,
  cite: ['ntnx-community-dnd', 'ntnx-cmdref-aos-7.6', 'ntnx-bible-4i'],
  status: 'active',
});
