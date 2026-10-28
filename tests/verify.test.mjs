import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { outputDirectory, verify } from '../scripts/verify.mjs';

function fixture(t) {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'ai-loop-verify-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  fs.writeFileSync(path.join(root,'marker.txt'),'source');
  return root;
}
function child(code,signal=null) {
  const proc=new EventEmitter(); proc.stdout=new PassThrough(); proc.stderr=new PassThrough(); proc.kill=()=>true;
  queueMicrotask(()=>{proc.stdout.end('test output\n');proc.stderr.end('test diagnostic\n');proc.emit('close',code,signal);});
  return proc;
}
const ready=async()=>({status:'ready',issues:[]});
const revision=value=>({algorithm:'sha256',digest:Buffer.from(value).toString('hex').padEnd(64,'0').slice(0,64),files:1});

test('非零测试退出码保存日志并判定失败',async t=>{
  const root=fixture(t),result=await verify({project:root,out:'.ai-loop/result',checkEnvironment:ready,snapshot:()=>revision('a'),spawnProcess:()=>child(7)});
  assert.equal(result.report.status,'FAIL');assert.equal(result.report.exit_code,7);assert.equal(result.exit_code,1);
  assert.match(fs.readFileSync(path.join(result.directory,'stdout.log'),'utf8'),/test output/);
  assert.match(fs.readFileSync(path.join(result.directory,'stderr.log'),'utf8'),/test diagnostic/);
  assert.match(fs.readFileSync(path.join(result.directory,'output.log'),'utf8'),/stdout/);
});

test('正常退出但前后快照变化不能通过',async t=>{
  const root=fixture(t),changes=[revision('before'),revision('after')];let index=0;
  const result=await verify({project:root,out:'.validation/changed',checkEnvironment:ready,snapshot:()=>changes[index++],spawnProcess:()=>child(0)});
  assert.equal(result.report.status,'FAIL');assert.equal(result.report.exit_code,0);assert.equal(result.exit_code,1);
});

test('符合预检、测试和快照要求后才通过',async t=>{
  const root=fixture(t);let started=0;
  const result=await verify({project:root,out:'.ai-loop/pass',checkEnvironment:ready,snapshot:()=>revision('same'),spawnProcess:()=>{started++;return child(0);}});
  assert.equal(started,1);assert.equal(result.report.status,'PASS');assert.equal(result.exit_code,0);
  assert.ok(result.report.started_at&&result.report.finished_at);assert.equal(result.report.signal,null);
});

test('所有者预检阻断时不启动测试进程',async t=>{
  const root=fixture(t);let started=0;
  const result=await verify({project:root,out:'.ai-loop/blocked',checkEnvironment:async()=>({status:'needs-repair',issues:[{type:'sandbox-creator'}]}),snapshot:()=>revision('same'),spawnProcess:()=>{started++;return child(0);}});
  assert.equal(started,0);assert.equal(result.report.status,'BLOCKED');assert.match(result.report.reason,/预检未通过/);
});

test('进程启动异常和被信号中断均不会通过',async t=>{
  const root=fixture(t),failed=await verify({project:root,out:'.ai-loop/start-error',checkEnvironment:ready,snapshot:()=>revision('same'),spawnProcess:()=>{throw new Error('denied');}});
  assert.equal(failed.report.status,'BLOCKED');assert.match(failed.report.reason,/denied/);
  const signalled=await verify({project:root,out:'.ai-loop/signalled',checkEnvironment:ready,snapshot:()=>revision('same'),spawnProcess:()=>child(null,'SIGTERM')});
  assert.equal(signalled.report.status,'BLOCKED');assert.equal(signalled.report.signal,'SIGTERM');
});

test('超时后即使子进程以退出码0结束仍为阻塞',async t=>{
  const root=fixture(t);let stopped=0;
  const delayed=()=>{const proc=new EventEmitter();proc.stdout=new PassThrough();proc.stderr=new PassThrough();proc.kill=()=>{stopped++;proc.emit('close',0,null);return true;};setImmediate(()=>setTimeout(()=>{if(stopped===0)proc.emit('close',0,null);},10));return proc;};
  const result=await verify({project:root,out:'.ai-loop/timeout',timeoutMs:1,checkEnvironment:ready,snapshot:()=>revision('same'),spawnProcess:delayed});
  assert.equal(stopped,1);assert.equal(result.report.exit_code,0);assert.equal(result.report.timed_out,true);assert.equal(result.report.status,'BLOCKED');
});

test('异步启动错误在close后保留并阻止通过',async t=>{
  const root=fixture(t),bad=()=>{const proc=new EventEmitter();proc.stdout=new PassThrough();proc.stderr=new PassThrough();queueMicrotask(()=>{proc.emit('error',new Error('late spawn failure'));proc.emit('close',0,null);});return proc;};
  const result=await verify({project:root,out:'.ai-loop/async-error',checkEnvironment:ready,snapshot:()=>revision('same'),spawnProcess:bad});
  assert.equal(result.report.exit_code,0);assert.match(result.report.launch_error,/late spawn failure/);assert.equal(result.report.status,'BLOCKED');
});

test('格式无效的快照会在启动回归前阻断',async t=>{
  const root=fixture(t);let started=0;
  const result=await verify({project:root,out:'.ai-loop/no-snapshot',checkEnvironment:ready,snapshot:()=>({}),spawnProcess:()=>{started++;return child(0);}});
  assert.equal(started,0);assert.equal(result.report.status,'BLOCKED');assert.equal(result.report.revision_after,null);
});

test('输出目录只允许仓库内新的元数据目录',t=>{
  const root=fixture(t);
  for(const bad of ['tests/results','.ai-loop/../escape','.git/backup','C:/outside','.validation/a/b']) assert.throws(()=>outputDirectory(root,bad));
  const valid=outputDirectory(root,'.validation/evidence');assert.equal(path.basename(valid),'evidence');
  fs.writeFileSync(path.join(valid,'keep.json'),'{}');assert.throws(()=>outputDirectory(root,'.validation/evidence'),/不会覆盖/);
});
