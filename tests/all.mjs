// 同一进程加载用例，避免 node --test 为各文件创建子进程。
await import('./install.test.mjs');
await import('./loop.test.mjs');
await import('./hook.test.mjs');

await import('./memory.test.mjs');
await import('./routing.test.mjs');
await import('./upgrade.test.mjs');
await import('./console.test.mjs');
await import('./release.test.mjs');
