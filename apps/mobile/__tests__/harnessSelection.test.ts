import { defaultModelForHarness } from '../src/screens/harnessSelection';

test.each([
  ['glm', 'deepseek-v4-flash', 'GLM-5.3'],
  ['glm', 'GLM-5.3-Flash', 'GLM-5.3-Flash'],
  ['dsh', 'deepseek-v4-pro', 'deepseek-v4-pro'],
  ['claude-code', 'deepseek-v4-pro', 'claude-sonnet-5'],
  ['codex', 'deepseek-v4-pro', 'gpt-5.6'],
] as const)('seeds %s with a compatible preferred model', (harness, preferred, expected) => {
  expect(defaultModelForHarness(harness, preferred)).toBe(expected);
});
