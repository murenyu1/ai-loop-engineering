export * from '../plugins/codex/scripts/session-start.mjs';
import { cli } from '../plugins/codex/scripts/session-start.mjs';
import { mainModule } from './lib.mjs';
if (mainModule(import.meta.url)) cli().catch(error => {console.error('AI Loop 启动入口未加载：'+error.message); process.exitCode=1;});
