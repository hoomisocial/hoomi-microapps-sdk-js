/** Named mock-host scenarios, also selectable via ?hoomi_scenario=<name>. */

export const SCENARIO_NAMES = [
  'happy',
  'deny-all',
  'deny-forever',
  'cancel-everything',
  'slow-3g',
  'offline',
  'rate-limited',
  'no-scopes',
] as const;

export type ScenarioName = (typeof SCENARIO_NAMES)[number];

export function isScenarioName(v: string): v is ScenarioName {
  return (SCENARIO_NAMES as readonly string[]).includes(v);
}
