import { cli as coreCli } from './activity-core.mjs';
import { resolveEffectiveProfile } from './profiles.mjs';
import { mainModule, printResult } from './lib.mjs';

export * from './activity-core.mjs';
export function rolePolicy(project, options = {}) {
  return resolveEffectiveProfile(project, options).profile?.roles;
}
export function cli(argv) {
  return coreCli(argv, { rolePolicy });
}
if (mainModule(import.meta.url)) printResult(() => cli(process.argv.slice(2)));
