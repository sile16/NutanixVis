/** Two-level version selector (SPEC §2.1): Nutanix release, then supported FlashArray releases. */
import type { VersionMatrix } from '../../domain/versions/profile';
import { Select } from '../components/controls';
import { useUi, type VersionChoice } from '../store/ui-store';
import { resolveVersions, selectNutanix, supportedFlashArray } from './versions';

export function VersionSelector({
  matrix,
  hasFlashArray,
}: {
  matrix: VersionMatrix;
  hasFlashArray: boolean;
}) {
  const stored = useUi((s) => s.versions);
  const setVersions = useUi((s) => s.setVersions);
  const choice = resolveVersions(matrix, stored);
  const fa = supportedFlashArray(matrix, choice.nutanix);

  const change = (next: VersionChoice) => {
    const { actionsApplied } = useUi.getState();
    if (
      actionsApplied > 0 &&
      !window.confirm(
        'Changing versions resets the simulation and discards applied actions. Continue?',
      )
    ) {
      return;
    }
    setVersions(next);
  };

  return (
    <div className="flex items-end gap-2" data-testid="version-selector">
      <Select
        label="Nutanix"
        value={choice.nutanix}
        onChange={(e) => change(selectNutanix(matrix, choice, e.target.value))}
        data-testid="nutanix-version"
      >
        {matrix.map((r) => (
          <option key={r.id} value={r.id}>
            {r.label}
          </option>
        ))}
      </Select>
      {hasFlashArray ? (
        <Select
          label="FlashArray"
          value={choice.flasharray ?? ''}
          onChange={(e) => change({ nutanix: choice.nutanix, flasharray: e.target.value })}
          data-testid="flasharray-version"
          disabled={fa.length === 0}
        >
          {fa.map((r) => (
            <option key={r.id} value={r.id}>
              {r.label}
            </option>
          ))}
        </Select>
      ) : null}
    </div>
  );
}
