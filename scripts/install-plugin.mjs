// 4.1 命令兼容入口；维护源码见目标文件。
export * from '../plugins/codex/scripts/install-plugin.mjs';
import { cli } from '../plugins/codex/scripts/install-plugin.mjs';
import { mainModule } from './lib.mjs';
if (mainModule(import.meta.url)) {
  try { console.log(JSON.stringify(await cli(process.argv.slice(2)), null, 2)); }
  catch (error) { console.error('操作停止：' + error.message); process.exitCode = 1; }
}
