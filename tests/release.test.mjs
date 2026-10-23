import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { inflateRawSync } from 'node:zlib';
import { spawnSync } from 'node:child_process';
import { buildRelease } from '../scripts/build-release.mjs';
import { buildPlugin } from '../scripts/build-plugin.mjs';
import { BUNDLE, safePath } from '../scripts/lib.mjs';
import { registerWorkspace, setWorkspaceEnabled } from '../scripts/workspaces.mjs';
import { startupContext } from '../scripts/session-start.mjs';
import { installPlugin } from '../scripts/install-plugin.mjs';

function unpack(file,root) {
  const bytes=fs.readFileSync(file),names=[];let pos=0;
  while(bytes.readUInt32LE(pos)===0x04034b50) {
    const length=bytes.readUInt32LE(pos+18),raw=bytes.readUInt32LE(pos+22),n=bytes.readUInt16LE(pos+26),extra=bytes.readUInt16LE(pos+28);
    const name=bytes.subarray(pos+30,pos+30+n).toString(),start=pos+30+n+extra;
    const content=inflateRawSync(bytes.subarray(start,start+length));assert.equal(content.length,raw);
    const target=safePath(root,name);fs.mkdirSync(path.dirname(target),{recursive:true});fs.writeFileSync(target,content);
    names.push(name);pos=start+length;
  }
  assert.equal(bytes.readUInt32LE(pos),0x02014b50);return names;
}
test('独立发行包可复现、通用与 Codex ZIP 可在仓库外运行',t=>{
  assert.throws(()=>buildPlugin('core/unexpected-output'),/输出仅允许/);
  const first=buildRelease(),second=buildRelease();assert.deepEqual(first,second);
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'ai-loop-release-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const project=path.join(root,'project');fs.mkdirSync(project);
  for(const item of first.packages) {
    const zip=path.join(BUNDLE,'downloads',item.name),bytes=fs.readFileSync(zip);
    assert.equal(crypto.createHash('sha256').update(bytes).digest('hex'),item.sha256);
    if (!item.name.endsWith('.zip')) continue;
    const target=path.join(root,item.name);fs.mkdirSync(target);
    const names=unpack(zip,target);
    assert.ok(names.includes('README.md'));
    assert.ok(!names.some(name=>/(?:^|\/)(?:tests|node_modules|\.ai-loop|\.release|workspaces.json|models.json)(?:\/|$)/.test(name)));
    if(item.name.includes('workflow')) {
      assert.ok(!names.some(name=>name.includes('plugin.json')||name.includes('console')));
      assert.ok(names.includes('scripts/install.mjs') && names.includes('scripts/doctor.mjs') && names.includes('scripts/execution.mjs'));
      const help = spawnSync(process.execPath, [path.join(target, 'scripts/install.mjs'), '--help'], { encoding: 'utf8', windowsHide: true });
      assert.equal(help.status, 0, help.stderr);
    }
    else {
      assert.ok(names.includes('hooks/hooks.json'));assert.ok(names.includes('scripts/install-plugin.mjs'));
      assert.ok(names.includes('mcp.json'));assert.ok(names.includes('.mcp.json'));assert.ok(names.includes('scripts/settings-server.mjs'));
      assert.ok(names.includes('scripts/codex-workspaces.mjs'));
      assert.ok(!names.some(name => name.startsWith('console/') || name.endsWith('/console.mjs') || name === 'open-console.ps1'));
      const mcp=JSON.parse(fs.readFileSync(path.join(target,'mcp.json')));
      assert.equal(mcp.mcpServers['ai-loop-settings'].type,'stdio');
      assert.equal(mcp.mcpServers['ai-loop-settings'].cwd,'./');
      const initialize=spawnSync(process.execPath,[path.join(target,'scripts/settings-server.mjs')],{input:JSON.stringify({jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion:'2025-11-25',capabilities:{},clientInfo:{name:'release-test',version:'1'}}})+'\n',encoding:'utf8',windowsHide:true,timeout:10000});
      assert.equal(initialize.status,0,initialize.stderr);
      assert.equal(JSON.parse(initialize.stdout).result.capabilities.experimental['openai/settings'].readTool,'ai_loop.settings.read');
    }
    const run=spawnSync(process.execPath,[path.join(target,'scripts/memory.mjs'),'bootstrap','--project',project],{encoding:'utf8',windowsHide:true});
    assert.equal(run.status,0,run.stderr);assert.equal(JSON.parse(run.stdout).active_count,0);
    if(item.name.includes('codex')) {
      const home=path.join(root,'home');fs.mkdirSync(home);
      fs.writeFileSync(path.join(home,'.codex-global-state.json'),JSON.stringify({'local-projects':{example:{name:'打包项目',rootPaths:[project]}}}));
      const read=spawnSync(process.execPath,[path.join(target,'scripts/settings-server.mjs')],{input:JSON.stringify({jsonrpc:'2.0',id:2,method:'tools/call',params:{name:'ai_loop.settings.read',arguments:{}}})+'\n',encoding:'utf8',windowsHide:true,timeout:10000,env:{...process.env,CODEX_HOME:home,AI_LOOP_PROJECT:'',AI_LOOP_NATIVE_MODEL_PROBE:'1'}});
      assert.equal(read.status,0,read.stderr);
      const view=JSON.parse(read.stdout).result.structuredContent;
      assert.ok(view.schema.properties.workspace_root.enum.some(value=>value.includes('打包项目')&&value.includes(project)));
      assert.equal(view.schema.properties.workspace_path,undefined);
      assert.equal(fs.existsSync(path.join(home,'ai-loop')),false);
      const preview=spawnSync(process.execPath,[path.join(target,'scripts/install-plugin.mjs'),'--project',project],{encoding:'utf8',windowsHide:true,env:{...process.env,CODEX_HOME:home}});
      assert.equal(preview.status,0,preview.stderr);assert.equal(JSON.parse(preview.stdout).status,'dry-run');
    }
  }
});
test('启动钩子仅匹配已启用的精确工作区，错误事件和关闭项目不注入',t=>{
  const home=fs.mkdtempSync(path.join(os.tmpdir(),'ai-loop-hook-home-')),root=fs.mkdtempSync(path.join(os.tmpdir(),'ai-loop-hook-project-'));
  t.after(()=>{fs.rmSync(home,{recursive:true,force:true});fs.rmSync(root,{recursive:true,force:true});});
  const input={hook_event_name:'SessionStart',cwd:root},options={home,bundle:BUNDLE};
  assert.equal(startupContext(input,options),null);
  registerWorkspace(home,root);
  const context=startupContext(input,options).hookSpecificOutput;
  assert.equal(context.hookEventName,'SessionStart');assert.ok(context.additionalContext.includes('不全量扫描'));
  assert.ok(context.additionalContext.length<4500);
  fs.mkdirSync(path.join(root,'child'));
  assert.equal(startupContext({...input,cwd:path.join(root,'child')},options),null);
  assert.equal(startupContext({...input,hook_event_name:'Stop'},options),null);
  setWorkspaceEnabled(home,root,false);assert.equal(startupContext(input,options),null);
});

test('插件目录中未登记的本机文件不得混入发行包',()=>{
  const target=path.join(BUNDLE,'dist/codex/unowned-private-test.txt');
  assert.equal(fs.existsSync(target),false);
  fs.writeFileSync(target,'本机临时资料');
  try { assert.throws(()=>buildRelease(),/未登记文件/); }
  finally { fs.unlinkSync(target); }
});

test('本地市场升级仅允许已登记旧版本变化，其他人工修改仍拒绝', t => {
  buildPlugin();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'loop-market-upgrade-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, 'home'), project = path.join(root, 'project');
  fs.mkdirSync(home); fs.mkdirSync(project);
  const location = path.join(home, 'plugins/local/ai-loop-engineering/plugins/ai-loop-engineering');
  fs.cpSync(path.join(BUNDLE, 'dist/codex'), location, { recursive: true });
  const lockPath = path.join(location, 'bundle.json'), lock = JSON.parse(fs.readFileSync(lockPath));
  lock.version = '4.5.2'; fs.writeFileSync(lockPath, JSON.stringify(lock));
  const metadata = JSON.parse(fs.readFileSync(path.join(BUNDLE, 'codex/marketplace.json')));
  metadata.plugins[0].version = '4.5.2'; metadata.plugins[0].source.path = './plugins/ai-loop-engineering';
  const market = path.join(home, 'plugins/local/ai-loop-engineering/.agents/plugins/marketplace.json');
  fs.mkdirSync(path.dirname(market), { recursive: true }); fs.writeFileSync(market, JSON.stringify(metadata, null, 2));
  const before = fs.readFileSync(market, 'utf8');
  const preview = installPlugin(project, { home });
  assert.equal(preview.status, 'dry-run'); assert.ok(preview.changes.includes(market)); assert.equal(fs.readFileSync(market, 'utf8'), before);
  metadata.plugins[0].source.path = './someone-else'; fs.writeFileSync(market, JSON.stringify(metadata));
  assert.throws(() => installPlugin(project, { home }), /市场内容被修改/);
});
