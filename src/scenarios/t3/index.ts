import type { ScenarioDef } from '../define';
import s01 from './01-so-node-fails';
import s02 from './02-co-node-fails';
import s03 from './03-co-nic-down';
import s04 from './04-co-all-uplinks';
import s05 from './05-hci-vs-co-nic';
import s06 from './06-bond-mode-change';
import s07 from './07-misconfig-sizing';

/** T3 (CO+SO / CO+HCI): SPEC §7.2 items 1–7. */
export const t3Scenarios: readonly ScenarioDef[] = [s01, s02, s03, s04, s05, s06, s07].flat();
