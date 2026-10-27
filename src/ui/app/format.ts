/** Sim clock label (SPEC §5.1): `T+mm:ss`, or `T+h:mm:ss` past an hour. */
export function formatSimTime(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, '0');
  return h > 0
    ? `T+${h}:${String(m).padStart(2, '0')}:${ss}`
    : `T+${String(m).padStart(2, '0')}:${ss}`;
}

/** Humanise a camelCase / kebab-case field key for the inspector. */
export function humanizeKey(key: string): string {
  const spaced = key.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/[-_]/g, ' ');
  return spaced.charAt(0).toUpperCase() + spaced.slice(1).toLowerCase();
}
