export * from '../plugins/codex/scripts/console.mjs';
import {cli} from '../plugins/codex/scripts/console.mjs';
import {mainModule} from './lib.mjs';
if(mainModule(import.meta.url)) cli().catch(error=>{console.error('操作停止：'+error.message);process.exitCode=1;});
