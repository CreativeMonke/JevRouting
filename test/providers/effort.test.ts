import { describe, expect, it } from 'vitest';
import { inferFamily, normalizeEffort } from '../../src/providers/index.js';

describe('normalizeEffort', () => {
  it('passes efforts through for families that accept the full scale', () => {
    const cfg = { model: 'claude-opus-5-5' };
    expect(normalizeEffort('xhigh', cfg)).toBe('xhigh');
    expect(normalizeEffort('medium', cfg)).toBe('medium');
  });

  it('maps deepseek efforts onto low|high|max', () => {
    const cfg = { model: 'deepseek-v4' };
    expect(normalizeEffort('low', cfg)).toBe('low');
    expect(normalizeEffort('medium', cfg)).toBe('high');
    expect(normalizeEffort('xhigh', cfg)).toBe('high');
    expect(normalizeEffort('high', cfg)).toBe('high');
    expect(normalizeEffort('max', cfg)).toBe('max');
  });

  it('applies an explicit effortMap before the family default', () => {
    const cfg = { model: 'deepseek-v4', effortMap: { max: 'maximum' } };
    expect(normalizeEffort('max', cfg)).toBe('maximum');
    expect(normalizeEffort('medium', cfg)).toBe('high');
  });

  it('honours an explicit family over the inferred one', () => {
    expect(normalizeEffort('xhigh', { model: 'custom-7', family: 'deepseek' })).toBe('high');
  });

  it('returns undefined when no effort was requested', () => {
    expect(normalizeEffort(undefined, { model: 'deepseek-v4' })).toBeUndefined();
  });
});

describe('inferFamily', () => {
  it.each([
    ['claude-opus-5-5', 'anthropic'],
    ['opencode/claude-sonnet-5-5', 'anthropic'],
    ['anthropic/claude-haiku-5-5', 'anthropic'],
    ['fable-5-1', 'anthropic'],
    ['gpt-6-1-sol', 'openai'],
    ['openrouter/openai/o3-mini', 'openai'],
    ['o1', 'openai'],
    ['gemini-3-pro', 'google'],
    ['gemma-3-27b', 'google'],
    ['deepseek-v4', 'deepseek'],
    ['openrouter/deepseek/deepseek-r1', 'deepseek'],
    ['glm-4.6', 'zhipu'],
    ['openrouter/openrouter/free', 'other'],
    ['jev-1.13-free', 'other'],
  ])('infers %s as %s', (model, family) => {
    expect(inferFamily(model)).toBe(family);
  });
});
