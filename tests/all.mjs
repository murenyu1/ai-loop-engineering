// 同一进程加载用例，避免 node --test 为各文件创建子进程。
await import('./install.test.mjs');
await import('./loop.test.mjs');
await import('./hook.test.mjs');

await import('./memory.test.mjs');
await import('./routing.test.mjs');
await import('./upgrade.test.mjs');
await import('./codex-workspaces.test.mjs');
await import('./native-settings.test.mjs');
await import('./settings-server.test.mjs');
await import('./release.test.mjs');
await import('./dsh-plugin.test.mjs');
await import('./dsh-client.test.mjs');
await import('./dsh-release.test.mjs');
await import('./dev-status.test.mjs');
