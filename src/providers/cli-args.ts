import type { CliProviderConfig } from '../config/schema.js';

export type CliPresetName = NonNullable<CliProviderConfig['preset']>;
export type CliOutputFormat = NonNullable<CliProviderConfig['output']>;

export interface CliSpec {
  command: string;
  args: string[];
  output: CliOutputFormat;
}

/** Flags verified against `claude --help`, `opencode run --help` and `agy --help`. */
export const CLI_PRESETS: Record<CliPresetName, CliSpec> = {
  'claude-code': {
    command: 'claude',
    args: ['-p', '{prompt}', '--model', '{model}', '--output-format', 'json', '--effort', '{effort}'],
    output: 'claude-json',
  },
  opencode: {
    command: 'opencode',
    args: ['run', '-m', '{model}', '--format', 'json', '{prompt}'],
    output: 'opencode-json',
  },
  antigravity: {
    command: 'agy',
    args: ['-p', '{prompt}', '--model', '{model}', '--effort', '{effort}'],
    output: 'text',
  },
};

export type CliVars = Record<'model' | 'prompt' | 'effort' | 'sessionId', string | undefined>;

/** Resolves preset defaults; explicit command/args/output in the config win over the preset. */
export function resolveCliSpec(cfg: CliProviderConfig): CliSpec {
  const preset = cfg.preset ? CLI_PRESETS[cfg.preset] : undefined;
  const command = cfg.command ?? preset?.command;
  if (!command) throw new Error('cli provider needs a preset or a command');
  return {
    command,
    args: cfg.args ?? preset?.args ?? [],
    output: cfg.output ?? preset?.output ?? 'text',
  };
}

/**
 * Fills {placeholders} in an argv template. A token whose placeholder has no value is dropped,
 * and so is the flag right before it: ['--effort', '{effort}'] becomes [] when effort is unset.
 */
export function expandArgs(template: readonly string[], vars: Partial<CliVars>): string[] {
  const args: string[] = [];
  for (const token of template) {
    const expanded = fillPlaceholders(token, vars);
    if (expanded !== undefined) {
      args.push(expanded);
    } else if (/^\{\w+\}$/.test(token) && args.at(-1)?.startsWith('-')) {
      args.pop();
    }
  }
  return args;
}

function fillPlaceholders(token: string, vars: Partial<CliVars>): string | undefined {
  let missing = false;
  const filled = token.replace(/\{(\w+)\}/g, (_, key: string) => {
    const value = Object.hasOwn(vars, key) ? vars[key as keyof CliVars] : undefined;
    if (value === undefined) missing = true;
    return value ?? '';
  });
  return missing ? undefined : filled;
}
