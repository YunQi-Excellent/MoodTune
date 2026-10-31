import { describe, expect, it, vi } from 'vitest';
import { createEqPresetService, createPlaylistService } from '../../../src/app/services/assets.js';
import { createAssetStore } from '../../../src/app/storage/assets.js';
import { createMemoryArea } from '../../helpers/memory-area.js';

const NOW = 1_700_000_000_000;

function setupPlaylists() {
  const area = createMemoryArea();
  let seq = 0;
  const store = createAssetStore({
    area,
    key: 'savedPlaylists',
    idPrefix: 'pl',
    notFoundMessage: '找不到这个播放列表',
    now: () => NOW,
    newId: prefix => `${prefix}-${++seq}`,
  });
  const player = { setPlaylist: vi.fn(async () => ({ ok: true })) };
  const service = createPlaylistService({
    store,
    player,
    normalizeSong: song => ({ ...song, normalized: true }),
  });
  return { store, player, service };
}

function setupEqPresets() {
  const area = createMemoryArea();
  let seq = 0;
  const store = createAssetStore({
    area,
    key: 'eqPresets',
    idPrefix: 'eq',
    notFoundMessage: '找不到这个调音',
    now: () => NOW,
    newId: prefix => `${prefix}-${++seq}`,
  });
  const player = {
    setEq: vi.fn(async eq => ({ ok: true, eq })),
    setEffects: vi.fn(async effects => ({ ok: true, effects })),
  };
  const service = createEqPresetService({
    store,
    player,
    normalizeEq: eq => ({ ...eq, normalized: true }),
    normalizeEffects: effects => ({ ...effects, normalized: true }),
  });
  return { store, player, service };
}

describe('createPlaylistService', () => {
  it('拒绝空歌单', async () => {
    const { service } = setupPlaylists();
    await expect(service.save({ name: 'x', songs: [] })).rejects.toThrow('播放列表为空');
    await expect(service.save({ name: 'x' })).rejects.toThrow('播放列表为空');
  });

  it('保存时归一化歌曲并落库', async () => {
    const { store, service } = setupPlaylists();
    const saved = await service.save({ name: '夜跑', songs: [{ id: 1 }, { id: 2 }] });

    expect(saved).toMatchObject({ id: 'pl-1', name: '夜跑', source: 'manual' });
    expect(saved.songs.every(song => song.normalized)).toBe(true);
    expect(await store.list()).toHaveLength(1);
  });

  it('play 把歌单推给播放器，找不到时报错', async () => {
    const { player, service } = setupPlaylists();
    const saved = await service.save({ name: 'x', songs: [{ id: 1 }] });

    await expect(service.play(saved.id)).resolves.toMatchObject({ id: saved.id });
    expect(player.setPlaylist).toHaveBeenCalledWith([{ id: 1, normalized: true }], true);
    await expect(service.play('不存在')).rejects.toThrow('找不到这个播放列表');
  });
});

describe('createEqPresetService', () => {
  it('没有 eq 时拒绝保存', async () => {
    const { service } = setupEqPresets();
    await expect(service.save({ name: 'x' })).rejects.toThrow('没有可保存的调音');
  });

  it('保存时归一化 EQ', async () => {
    const { service } = setupEqPresets();
    const eq = { preampDb: 0, bands: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10] };
    const saved = await service.save({ name: '低音', eq });

    expect(saved.eq).toEqual({ ...eq, normalized: true });
  });

  it('可以同时保存效果链，套用时一起生效', async () => {
    const { service, player } = setupEqPresets();
    const eq = { preampDb: 0, bands: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10] };
    const saved = await service.save({ name: '环绕', eq, effects: { enabled: true } });

    expect(saved.effects).toEqual({ enabled: true, normalized: true });

    const result = await service.apply(saved.id);
    expect(player.setEffects).toHaveBeenCalledWith({ enabled: true, normalized: true });
    expect(result.effects).toEqual({ enabled: true, normalized: true });
  });

  it('老预设只有 EQ 时不碰效果链', async () => {
    const { service, player } = setupEqPresets();
    const saved = await service.save({ name: '旧', eq: { preampDb: 0, bands: [] } });

    const result = await service.apply(saved.id);

    expect(player.setEffects).not.toHaveBeenCalled();
    expect(result.effects).toBeUndefined();
  });

  it('apply 套用预设并回传应用后的 EQ', async () => {
    const { service } = setupEqPresets();
    const eq = { preampDb: 1, bands: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0] };
    const saved = await service.save({ name: 'x', eq });

    const result = await service.apply(saved.id);

    expect(result.preset.id).toBe(saved.id);
    expect(result.eq).toEqual({ ...eq, normalized: true });
    await expect(service.apply('不存在')).rejects.toThrow('找不到这个调音');
  });
});
