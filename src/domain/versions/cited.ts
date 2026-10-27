import type { Cited, Confidence } from '../../engine/types';
import type { KnownCitationId } from '../citations';

/** Build a `Cited` value; cite ids are checked against the registry at compile time. */
export function cited<T>(
  value: T,
  confidence: Confidence,
  cite: readonly KnownCitationId[],
  note?: string,
): Cited<T> {
  return note === undefined ? { value, cite, confidence } : { value, cite, confidence, note };
}

/** `SPDK ctrlr_loss_timeout_sec` semantics: -1 means reconnect forever, never delete the controller. */
export const RECONNECT_FOREVER = -1;
