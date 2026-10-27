import { describe, expect, it } from 'vitest';
import type { VersionMatrix } from '../../domain/versions/profile';
import { fixtureVersionMatrix } from '../../fixtures/version-matrix';
import { playbackSchedule } from '../store/playback';
import { formatSimTime, humanizeKey } from './format';
import {
  defaultVersions,
  resolveVersions,
  selectNutanix,
  supportedFlashArray,
  toVersionSelection,
} from './versions';

const matrix: VersionMatrix = [
  {
    id: 'new',
    label: 'New',
    aos: '2',
    ahv: '2',
    profileId: 'p-new',
    flasharray: [
      { id: 'fa-3', label: 'FA 3', profileId: 'p-fa3' },
      { id: 'fa-2', label: 'FA 2' },
    ],
    cite: [],
  },
  {
    id: 'old',
    label: 'Old',
    aos: '1',
    ahv: '1',
    profileId: 'p-old',
    flasharray: [
      { id: 'fa-2', label: 'FA 2' },
      { id: 'fa-1', label: 'FA 1' },
    ],
    cite: [],
  },
];

describe('version selector', () => {
  it('defaults to the newest Nutanix release and its newest FlashArray release', () => {
    expect(defaultVersions(matrix)).toEqual({ nutanix: 'new', flasharray: 'fa-3' });
    expect(defaultVersions(fixtureVersionMatrix).nutanix).toBe('aos-7.6');
  });

  it('filters FlashArray releases by Nutanix release', () => {
    expect(supportedFlashArray(matrix, 'old').map((f) => f.id)).toEqual(['fa-2', 'fa-1']);
    expect(supportedFlashArray(matrix, 'missing')).toEqual([]);
  });

  it('keeps a still-supported FlashArray selection and resets an unsupported one to newest', () => {
    expect(selectNutanix(matrix, { nutanix: 'new', flasharray: 'fa-2' }, 'old')).toEqual({
      nutanix: 'old',
      flasharray: 'fa-2',
    });
    expect(selectNutanix(matrix, { nutanix: 'new', flasharray: 'fa-3' }, 'old')).toEqual({
      nutanix: 'old',
      flasharray: 'fa-2',
    });
    expect(selectNutanix(matrix, { nutanix: 'old', flasharray: 'fa-1' }, 'new')).toEqual({
      nutanix: 'new',
      flasharray: 'fa-3',
    });
    expect(resolveVersions(matrix, { nutanix: '', flasharray: undefined })).toEqual({
      nutanix: 'new',
      flasharray: 'fa-3',
    });
  });

  it('builds the engine selection, honouring per-pair profile overrides', () => {
    expect(toVersionSelection(matrix, { nutanix: 'new', flasharray: 'fa-3' }, true)).toEqual({
      nutanix: 'new',
      flasharray: 'fa-3',
      profileId: 'p-fa3',
    });
    expect(toVersionSelection(matrix, { nutanix: 'new', flasharray: 'fa-2' }, true).profileId).toBe(
      'p-new',
    );
    expect(toVersionSelection(matrix, { nutanix: 'new', flasharray: 'fa-3' }, false)).toEqual({
      nutanix: 'new',
      profileId: 'p-new',
    });
  });
});

describe('formatSimTime', () => {
  it('formats T+mm:ss and T+h:mm:ss', () => {
    expect(formatSimTime(0)).toBe('T+00:00');
    expect(formatSimTime(75)).toBe('T+01:15');
    expect(formatSimTime(1800)).toBe('T+30:00');
    expect(formatSimTime(3725)).toBe('T+1:02:05');
  });

  it('humanizes field keys', () => {
    expect(humanizeKey('nvmePathsUp')).toBe('Nvme paths up');
    expect(humanizeKey('bond-mode')).toBe('Bond mode');
  });
});

describe('playbackSchedule', () => {
  it('maps speeds to real-time intervals, batching ticks above ×5', () => {
    expect(playbackSchedule(1)).toEqual({ intervalMs: 1000, ticksPerInterval: 1 });
    expect(playbackSchedule(5)).toEqual({ intervalMs: 200, ticksPerInterval: 1 });
    expect(playbackSchedule(20)).toEqual({ intervalMs: 200, ticksPerInterval: 4 });
    expect(playbackSchedule(60)).toEqual({ intervalMs: 200, ticksPerInterval: 12 });
  });
});
