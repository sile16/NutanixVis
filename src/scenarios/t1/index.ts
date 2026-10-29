import type { ScenarioDef } from '../define';
import s01 from './01-storage-nic';
import s02 from './02-switch-a';
import s03 from './03-fa-primary-crash';
import s04 from './04-fa-secondary-crash';
import s05 from './05-purity-ndu';
import s06 from './06-fa-io-stall';
import s07 from './07-host-power-loss';
import s08 from './08-cvm-fails';
import s09 from './09-node-storage-uplinks-lost';
import s10 from './10-array-unreachable';
import s11 from './11-single-vlan';
import s12 from './12-mtu-mismatch';
import s13 from './13-fa-mgmt-unreachable';
import s14 from './14-bond-comparison-steady';
import s15 from './15-bond-comparison-nic-down';
import s16 from './16-slb-rebalance-strict-ab';
import s17 from './17-lacp-no-mlag';
import s18 from './18-lacp-rate-hung-switch';
import s19 from './19-flow-control';
import s20 from './20-hung-switch-vs0';
import s21 from './21-hung-switch-alternate';
import s22 from './22-qd-bound-silent-loss';
import s23 from './23-fa-port-flap';
import s24 from './24-lossy-link';
import s25 from './25-slow-link';
import s26 from './26-whole-array-loss-vms';
import s27 from './27-stargate-failure-modes';
import s28 from './28-whole-array-blip';
import s29 from './29-degraded-cvm-cascade';

/** T1 (AHV + FlashArray): SPEC §7.2 items 1–28 (19: flow-control misconfiguration). */
export const t1Scenarios: readonly ScenarioDef[] = [
  s01,
  s02,
  s03,
  s04,
  s05,
  s06,
  s07,
  s08,
  s09,
  s10,
  s11,
  s12,
  s13,
  s14,
  s15,
  s16,
  s17,
  s18,
  s19,
  s20,
  s21,
  s22,
  s23,
  s24,
  s25,
  s26,
  s27,
  s28,
  s29,
].flat();
