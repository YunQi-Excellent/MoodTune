import { describe, expect, it, vi } from 'vitest';
import { createSoundHandlers } from '../../../src/app/background/handlers/sound.js';

function setup() {
  const player = {
    setEq: vi.fn(async eq => ({ ok: true, eq })),
    setEffects: vi.fn(async effects => ({ ok: true, effects })),
  };
  const presets = {
    apply: vi.fn(async id => ({ preset: { id }, eq: { bands: [] } })),
  };
  return { player, presets, handlers: createSoundHandlers({ player, presets }) };
}

describe('applySoundPreset', () => {
  it('内置音效把 EQ 与效果链一起落下', async () => {
    const { handlers, player } = setup();

    const response = await handlers.applySoundPreset({ id: 'clean-vocal' });

    expect(response.ok).toBe(true);
    expect(response.preset).toMatchObject({ id: 'clean-vocal', name: '清澈人声' });
    expect(player.setEq).toHaveBeenCalledWith(
      expect.objectContaining({ bands: expect.any(Array) }),
    );
    expect(player.setEffects).toHaveBeenCalledWith(
      expect.objectContaining({ width: expect.any(Object), reverb: expect.any(Object) }),
    );
    expect(response.eq).toBeTruthy();
  });

  it('不是内置 id 时退回用户预设', async () => {
    const { handlers, presets } = setup();

    const response = await handlers.applySoundPreset({ id: 'eq-1' });

    expect(presets.apply).toHaveBeenCalledWith('eq-1');
    expect(response.ok).toBe(true);
    expect(response.preset).toEqual({ id: 'eq-1' });
  });

  it('缺依赖时直接报错', () => {
    expect(() => createSoundHandlers({ presets: {} })).toThrow('需要 player');
    expect(() => createSoundHandlers({ player: {} })).toThrow('需要 presets');
  });
});
