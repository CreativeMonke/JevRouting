/**
 * Maps a provider model id to a Slopalytics family slug.
 * "anthropic/claude-opus-5-5" -> "claude-opus-5-5"; "openrouter/z-ai/glm-5.3-flash" -> "glm-5-3-flash";
 * "opencode/glm-5.3-flash-free" -> "glm-5-3-flash"; "gpt-6.1-sol" -> "gpt-6-1-sol".
 */
export function familyFromModelId(modelId: string): string {
  const name = modelId.trim().toLowerCase().split('/').pop() ?? '';
  return name.replace(/:free$/, '').replace(/-free$/, '').replace(/\./g, '-');
}

/**
 * Maps a family slug to the display name Slopalytics uses in usage data and prices.
 * Heuristic covering the current naming scheme: "claude-opus-5-5" -> "Opus 5.5", "gpt-6-1-sol" -> "GPT-6.1 Sol".
 */
export function usageNameForFamily(family: string): string {
  const words = family.toLowerCase().replace(/^claude-/, '').split('-').filter(Boolean);
  const versionStart = words.findIndex(isNumeric);
  if (versionStart === -1) return words.map(titleWord).join(' ');

  const rest = words.slice(versionStart);
  const versionLength = rest.findIndex((word) => !isNumeric(word));
  const version = (versionLength === -1 ? rest : rest.slice(0, versionLength)).join('.');
  const tail = versionLength === -1 ? [] : rest.slice(versionLength);
  const tailLabel = tail.map(titleWord).join(' ');

  const head = words.slice(0, versionStart);
  if (head.length === 0) return [tailLabel, version].filter(Boolean).join(' ');
  const headLabel = head.map(titleWord).join(' ');
  const joiner = head.at(-1) === 'gpt' ? '-' : ' ';
  return [`${headLabel}${joiner}${version}`, tailLabel].filter(Boolean).join(' ');
}

const isNumeric = (word: string): boolean => /^\d+$/.test(word);

const titleWord = (word: string): string => (word === 'gpt' ? 'GPT' : word.charAt(0).toUpperCase() + word.slice(1));
