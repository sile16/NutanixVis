/** Two-level version selector (SPEC §2.1): Nutanix release, then the Purity release (shown as 6.11.8+). */
import type { VersionMatrix } from '../../domain/versions/profile';
import { Select } from '../components/controls';
import { useUi, type VersionChoice } from '../store/ui-store';
import { resolveVersions, selectNutanix, supportedFlashArray } from './versions';

/** The single Purity label the UI shows. */
const PURITY_LABEL = '6.11.8+';

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
          label="Purity"
          value={choice.flasharray ?? ''}
          onChange={(e) => change({ nutanix: choice.nutanix, flasharray: e.target.value })}
          data-testid="flasharray-version"
          disabled={fa.length === 0}
        >
          {/* One Purity version is offered: 6.11.8 and later (display label only). */}
          {fa
            .filter((r) => r.id === choice.flasharray)
            .map((r) => (
              <option key={r.id} value={r.id}>
                {PURITY_LABEL}
              </option>
            ))}
        </Select>
      ) : null}
    </div>
  );
}
