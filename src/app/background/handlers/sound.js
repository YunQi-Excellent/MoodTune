import { cloneSoundPreset, findBuiltinSoundPreset } from '../../../core/sound-presets.js';

/**
 * 音效（内置预设）的应用入口。
 *
 * 和 `handlers/eq.js` 分开，是因为它们解决的是不同问题：
 * eq.js 管「EQ 这一个节点」，这里管「一整套听感 = EQ + 效果链」。
 * 内置 id 走这里，用户保存的预设走 eqPresets 仓储，入口对 UI 只有一个。
 *
 * @param {object} options
 * @param {object} options.player
 * @param {object} options.presets 用户预设服务（带 apply）
 */
export function createSoundHandlers({ player, presets } = {}) {
  if (!player) throw new Error('createSoundHandlers 需要 player');
  if (!presets) throw new Error('createSoundHandlers 需要 presets');

  return {
    applySoundPreset: async (req) => {
      const builtin = findBuiltinSoundPreset(req.id);
      if (!builtin) {
        // 不是内置 id 时退回用户预设，保持「同一个入口点谁都能套」
        return { ok: true, ...(await presets.apply(req.id)) };
      }

      const target = cloneSoundPreset(builtin);
      const eqResponse = await player.setEq(target.eq);
      const effectsResponse = await player.setEffects(target.effects);

      return {
        ok: true,
        preset: { id: target.id, name: target.name, tagline: target.tagline, accent: target.accent },
        eq: eqResponse?.eq || target.eq,
        effects: effectsResponse?.effects || target.effects,
      };
    },
  };
}
