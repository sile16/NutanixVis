import type { ScenarioDef } from '../define';
import s01 from './01-disable-one-fa-ip';
import s02 from './02-disable-vlan-ips';
import s03 from './03-prune-storage-vlans';

/** T1-lab (test drive mirror): SPEC §7.2 items 1–3. */
export const t1LabScenarios: readonly ScenarioDef[] = [s01, s02, s03].flat();
