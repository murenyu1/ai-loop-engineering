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
test('独立发行包可复现、精简核心没有 Codex 依赖、两个包均可在仓库外运行',t=>{
  assert.throws(()=>buildPlugin('core/unexpected-output'),/输出仅允许/);
  const first=buildRelease(),second=buildRelease();assert.deepEqual(first,second);
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'ai-loop-release-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const project=path.join(root,'project');fs.mkdirSync(project);
  for(const item of first.packages) {
    const zip=path.join(BUNDLE,'downloads',item.name),bytes=fs.readFileSync(zip);
    assert.equal(crypto.createHash('sha256').update(bytes).digest('hex'),item.sha256);
    const target=path.join(root,item.name);fs.mkdirSync(target);
    const names=unpack(zip,target);
    assert.ok(names.includes('README.md'));
    assert.ok(!names.some(name=>/(?:^|\/)(?:tests|node_modules|\.ai-loop|\.release|workspaces.json|models.json)(?:\/|$)/.test(name)));
    if(item.name.includes('workflow')) assert.ok(!names.some(name=>name.includes('plugin.json')||name.includes('profiles.mjs')||name.includes('console')));
    else {assert.ok(names.includes('hooks/hooks.json'));assert.ok(names.includes('scripts/install-plugin.mjs'));}
    const run=spawnSync(process.execPath,[path.join(target,'scripts/memory.mjs'),'bootstrap','--project',project],{encoding:'utf8',windowsHide:true});
    assert.equal(run.status,0,run.stderr);assert.equal(JSON.parse(run.stdout).active_count,0);
    if(item.name.includes('codex')) {
      const home=path.join(root,'home');fs.mkdirSync(home);
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
