import { describe, expect, it } from 'vitest';
import { extractJson } from '../../src/core/json.js';

describe('extractJson', () => {
  it('提取 ```json 代码块', () => {
    const text = '先分析一下。\n```json\n{"mode":"search","reply":"收到"}\n```\n';

    expect(extractJson(text)).toEqual({ mode: 'search', reply: '收到' });
  });

  it('提取前后带解释文字的对象', () => {
    const text = '好的：{"picks":[{"id":1}]} 以上。';

    expect(extractJson(text)).toEqual({ picks: [{ id: 1 }] });
  });

  it('保留嵌套对象', () => {
    const text = '{"eq":{"preampDb":0,"bands":[{"frequencyHz":31,"gainDb":3}]}}';

    expect(extractJson(text)).toEqual({
      eq: { preampDb: 0, bands: [{ frequencyHz: 31, gainDb: 3 }] },
    });
  });

  it('解析失败返回 null', () => {
    expect(extractJson('这不是 JSON')).toBeNull();
    expect(extractJson('{"broken": }')).toBeNull();
    expect(extractJson('')).toBeNull();
  });
});
