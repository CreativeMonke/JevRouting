import { describe, expect, it } from 'vitest';
import { familyFromModelId, usageNameForFamily } from '../../src/catalog/index.js';

describe('familyFromModelId', () => {
  it.each([
    ['claude-opus-5-5', 'claude-opus-5-5'],
    ['anthropic/claude-opus-5-5', 'claude-opus-5-5'],
    ['opencode/glm-5.3-flash-free', 'glm-5-3-flash'],
    ['openrouter/z-ai/glm-5.3-flash', 'glm-5-3-flash'],
    ['openrouter/z-ai/glm-4.5-air:free', 'glm-4-5-air'],
    ['gpt-6.1-sol', 'gpt-6-1-sol'],
    ['opencode/deepseek-v4.1-flash-free', 'deepseek-v4-1-flash'],
    ['  Claude-Fable-5.1 ', 'claude-fable-5-1'],
  ])('%s -> %s', (modelId, family) => {
    expect(familyFromModelId(modelId)).toBe(family);
  });
});

describe('usageNameForFamily', () => {
  it.each([
    ['claude-opus-5-5', 'Opus 5.5'],
    ['claude-fable-5-1', 'Fable 5.1'],
    ['claude-sonnet-5-5', 'Sonnet 5.5'],
    ['claude-haiku-4-5', 'Haiku 4.5'],
    ['gpt-6-1-sol', 'GPT-6.1 Sol'],
    ['gpt-6-luna', 'GPT-6 Luna'],
    ['gpt-5-3-codex', 'GPT-5.3 Codex'],
  ])('%s -> %s', (family, name) => {
    expect(usageNameForFamily(family)).toBe(name);
  });

  it('round-trips with familyFromModelId for usage display names in the fixture', () => {
    expect(usageNameForFamily(familyFromModelId('anthropic/claude-opus-5-5'))).toBe('Opus 5.5');
  });
});
