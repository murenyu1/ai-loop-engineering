export * from '../core/scripts/roles.mjs';
import { cli } from '../core/scripts/roles.mjs';
import { mainModule, printResult } from './lib.mjs';
if (mainModule(import.meta.url)) printResult(() => cli(process.argv.slice(2)));
