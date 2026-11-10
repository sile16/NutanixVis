import { describe, expect, it } from 'vitest';
import type { VersionMatrix } from '../../domain/versions/profile';
import { fixtureVersionMatrix } from '../../fixtures/version-matrix';
import { playbackSchedule } from '../store/playback';
import { formatField, humanizeKey } from './format';
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

describe('humanizeKey', () => {
  it('humanizes field keys', () => {
    expect(humanizeKey('nvmePathsUp')).toBe('NVMe paths up');
    expect(humanizeKey('bond-mode')).toBe('Bond mode');
    expect(humanizeKey('haStatus')).toBe('HA status');
    expect(humanizeKey('zkQuorum')).toBe('ZK quorum');
    expect(humanizeKey('acropolisLeader')).toBe('Acropolis leader');
    expect(humanizeKey('engine.queuedActions')).toBe('Queued actions');
    expect(humanizeKey('throughputGbps')).toBe('Throughput Gb/s');
    expect(humanizeKey('ioLatencyUs')).toBe('IO latency µs');
    expect(humanizeKey('stuckIoPct')).toBe('Stuck IO %');
    expect(humanizeKey('iops')).toBe('IOPS');
  });
});

describe('formatField', () => {
  it('reads JSON lists and records as text, not raw JSON', () => {
    expect(formatField('["node-1.cvm","node-2.cvm"]')).toBe('node-1.cvm, node-2.cvm');
    expect(formatField('[]')).toBe('none');
    expect(formatField('{"ZOOKEEPER":1,"FREE_SPACE":2}')).toBe('Zookeeper 1, Free space 2');
    expect(formatField('{"a~b":"live"}')).toBe('a~b live');
    expect(formatField('10,20,100,200')).toBe('10,20,100,200');
    expect(formatField(true)).toBe('yes');
    expect(formatField(null)).toBe('—');
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
