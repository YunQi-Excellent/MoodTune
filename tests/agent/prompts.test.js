import { describe, expect, it } from 'vitest';
import { EQ_FREQUENCIES } from '../../src/core/constants.js';
import {
  DECIDE_SYSTEM,
  EQ_TUNER_SYSTEM,
  RERANK_SYSTEM,
} from '../../src/agent/prompts.js';

describe('EQ 调音提示词', () => {
  it('频段列表来自 core 常量，避免提示词与音频引擎漂移', () => {
    expect(EQ_TUNER_SYSTEM).toContain(EQ_FREQUENCIES.join(', '));
  });
});

describe('检索提示词', () => {
  it('决策提示词同时覆盖意图与检索工具，且不写死平台', () => {
    expect(DECIDE_SYSTEM).toContain('searchTracks');
    expect(DECIDE_SYSTEM).toContain('getArtistTracks');
    expect(DECIDE_SYSTEM).not.toContain('searchSongs');
    expect(DECIDE_SYSTEM).not.toContain('网易云');
  });

  it('精排允许数字或字符串 id', () => {
    expect(RERANK_SYSTEM).toContain('数字或字符串');
  });

  it('决策 schema 包含 open-eq-panel', () => {
    expect(DECIDE_SYSTEM).toContain('"open-eq-panel"');
  });

  it('决策 schema 带 carryOver，支持「再找一些」的追加检索', () => {
    expect(DECIDE_SYSTEM).toContain('"carryOver"');
    expect(DECIDE_SYSTEM).toContain('上一轮');
  });

  it('两类提示词都要求纯 JSON，避免模型输出分析文字拖慢链路', () => {
    expect(DECIDE_SYSTEM).toContain('不要任何分析文字');
    expect(RERANK_SYSTEM).toContain('不要任何分析文字');
  });
});
