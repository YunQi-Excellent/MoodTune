import { describe, expect, it } from 'vitest';
import { EQ_FREQUENCIES } from '../../src/core/constants.js';
import {
  EQ_TUNER_SYSTEM,
  PLANNER_SYSTEM,
  RERANK_SYSTEM,
  ROUTER_SYSTEM,
} from '../../src/agent/prompts.js';

describe('EQ 调音提示词', () => {
  it('频段列表来自 core 常量，避免提示词与音频引擎漂移', () => {
    expect(EQ_TUNER_SYSTEM).toContain(EQ_FREQUENCIES.join(', '));
  });
});

describe('检索提示词', () => {
  it('使用通用工具名，不写死平台', () => {
    expect(PLANNER_SYSTEM).toContain('searchTracks');
    expect(PLANNER_SYSTEM).toContain('getArtistTracks');
    expect(PLANNER_SYSTEM).not.toContain('searchSongs');
    expect(PLANNER_SYSTEM).not.toContain('网易云');
  });

  it('精排允许数字或字符串 id', () => {
    expect(RERANK_SYSTEM).toContain('数字或字符串');
  });

  it('路由 schema 包含 open-eq-panel', () => {
    expect(ROUTER_SYSTEM).toContain('"open-eq-panel"');
  });
});
