import { cli as coreCli } from '../../scripts/activity-core.mjs';
import { resolveEffectiveProfile } from '../../scripts/profiles.mjs';
import { mainModule, printResult } from '../../scripts/lib.mjs';

export * from '../../scripts/activity-core.mjs';
export function rolePolicy(project, options = {}) {
  return resolveEffectiveProfile(project, options).profile?.roles;
}
export function cli(argv) {
  return coreCli(argv, { rolePolicy });
}
if (mainModule(import.meta.url)) printResult(() => cli(process.argv.slice(2)));
