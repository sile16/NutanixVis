import type { ScenarioDef } from '../define';
import s01 from './01-cvm-power-off';
import s02 from './02-host-power-loss';
import s03 from './03-host-isolation';
import s04 from './04-acropolis-leader-host';
import s05 from './05-uplink-or-tor';
import s06 from './06-lacp-rate';
import s07 from './07-disk-failure';
import s08 from './08-second-node-failure';
import s09 from './09-ft2-two-failures';
import s10 from './10-block-failure';
import s11 from './11-partition-3-2';
import s12 from './12-total-partition';
import s13 from './13-degraded-node';

/** T2 (Nutanix HCI on AHV): SPEC §7.2 items 1–13. */
export const t2Scenarios: readonly ScenarioDef[] = [
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
].flat();
