/**
 * Vendor logos (public/brand/README.md). Logos identify the simulated products; the Nutanix logo is
 * only ever charcoal gray or white per Nutanix guidelines, so each logo swaps variant by theme.
 */
import clsx from 'clsx';

const base = `${import.meta.env.BASE_URL}brand/`;

const LOGOS = {
  nutanix: { light: 'nutanix-logo-charcoal.svg', dark: 'nutanix-logo-white.svg', alt: 'Nutanix' },
  everpure: { light: 'everpure-logo.svg', dark: 'everpure-logo-white.svg', alt: 'Everpure' },
} as const;

export function VendorLogo({
  vendor,
  height,
  className,
}: {
  vendor: keyof typeof LOGOS;
  height: number;
  className?: string;
}) {
  const l = LOGOS[vendor];
  return (
    <span className={clsx('inline-flex shrink-0 items-center', className)}>
      <img src={`${base}${l.light}`} alt={l.alt} style={{ height }} className="nv-logo-light" />
      <img
        src={`${base}${l.dark}`}
        alt=""
        aria-hidden="true"
        style={{ height }}
        className="nv-logo-dark"
      />
    </span>
  );
}

/** The Everpure icon mark (same in both themes), for compact spots like the array card header. */
export function EverpureMark({ size }: { size: number }) {
  return (
    <img
      src={`${base}everpure-mark.svg`}
      alt="Everpure"
      style={{ height: size, width: size }}
      className="shrink-0"
    />
  );
}
