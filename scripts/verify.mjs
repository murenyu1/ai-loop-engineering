#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { atomicWrite, safePath, assert, args, allowArgs, mainModule } from './lib.mjs';
import { snapshot } from './loop.mjs';
import { inspectWindows } from './windows.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const snapshotPaths = ['core','codex','dsh','scripts','tests','adapters','package.json'];
const terminalStates = new Set(['PASS','FAIL','BLOCKED']);
const validSnapshot = value => value?.algorithm==='sha256' && /^[a-f0-9]{64}$/.test(value.digest) && Number.isInteger(value.files) && value.files>=0;

export function outputDirectory(project, requested) {
  assert(typeof requested === 'string' && requested.trim(), '须提供 --out .ai-loop/专属目录 或 .validation/专属目录');
  const normalized = requested.replaceAll('\\','/');
  assert(!path.isAbsolute(requested) && !/^[A-Za-z]:/.test(requested), '输出目录必须使用项目内相对路径');
  assert(/^\.(?:ai-loop|validation)\/[A-Za-z0-9][A-Za-z0-9._-]{0,100}$/.test(normalized), '输出只能放在 .ai-loop 或 .validation 下的专属目录');
  const directory = safePath(project, normalized);
  if (fs.existsSync(directory)) {
    assert(fs.statSync(directory).isDirectory() && fs.readdirSync(directory).length === 0, '输出目录必须是新的或为空；不会覆盖既有证据');
  } else fs.mkdirSync(directory, {recursive:true});
  return directory;
}

function writeReport(directory, report) {
  assert(terminalStates.has(report.status), '报告状态无效');
  atomicWrite(safePath(directory, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
}

function makeSnapshot(project) {
  return snapshot(project, [], root, snapshotPaths);
}

function appendLog(stream, label, chunk) {
  stream.write(`[${label}] `);
  stream.write(chunk);
  if (!chunk.toString().endsWith('\n')) stream.write('\n');
}

function runChild({project, directory, check, getSnapshot, start, timeoutMs}) {
  const stdoutFile = fs.createWriteStream(safePath(directory, 'stdout.log'), {flags:'wx'});
  const stderrFile = fs.createWriteStream(safePath(directory, 'stderr.log'), {flags:'wx'});
  const combinedFile = fs.createWriteStream(safePath(directory, 'output.log'), {flags:'wx'});
  const report = {
    status:'BLOCKED', command:`${process.execPath} tests/all.mjs`, node:process.version,
    started_at:new Date().toISOString(), finished_at:null, exit_code:null, signal:null,
    revision_before:null, revision_after:null, environment:null, reason:null,
    timed_out:false, launch_error:null, stream_error:null,
    stdout:'stdout.log', stderr:'stderr.log', output:'output.log'
  };
  const finish = result => Promise.all([stdoutFile,stderrFile,combinedFile].map(stream => new Promise(resolve => stream.end(resolve))))
    .then(() => {
      if (result && typeof result === 'object') Object.assign(report,result);
      report.finished_at = new Date().toISOString();
      report.status = decideStatus(report);
      if (report.status === 'PASS') report.reason = '测试退出码为0且前后源码快照一致';
      else if(report.status==='FAIL'&&!report.reason) report.reason='回归失败或源码前后快照不一致';
      writeReport(directory,report);
      return report;
    });
  for(const stream of [stdoutFile,stderrFile,combinedFile]) stream.on('error',error=>{report.stream_error=error.message;});
  const startTests = () => new Promise(resolve => {
    let child, timer, timedOut = false, settled = false, asyncError=null;
    try { child = start(process.execPath,['tests/all.mjs'],{cwd:project,windowsHide:true,stdio:['ignore','pipe','pipe']}); }
    catch (error) { resolve({launch_error:error.message,reason:`无法启动回归：${error.message}`}); return; }
    child.stdout?.on('data',chunk=>{ stdoutFile.write(chunk); appendLog(combinedFile,'stdout',chunk); });
    child.stderr?.on('data',chunk=>{ stderrFile.write(chunk); appendLog(combinedFile,'stderr',chunk); });
    child.once('error',error=>{ asyncError=error.message; });
    if (timeoutMs > 0) timer=setTimeout(()=>{ timedOut=true; report.timed_out=true; try { child.kill(); } catch(error) { report.reason=`超时后停止本子进程失败：${error.message}`; } },timeoutMs);
    child.once('close',(code,signal)=>{
      if (settled) return;
      settled=true;
      if(timer) clearTimeout(timer);
      report.exit_code=Number.isInteger(code)?code:null;
      report.signal=signal??null;
      report.timed_out ||= timedOut;
      const reason=report.timed_out?'回归超过时限；只停止本脚本直接启动的子进程，结果未知':asyncError?`回归进程错误：${asyncError}`:code===0&&!signal?'':`回归结束码为${code??'未知'}${signal?`，信号${signal}`:''}`;
      resolve({reason,launch_error:asyncError});
    });
  });
  return Promise.resolve().then(()=>check(project)).then(async environment=>{
    report.environment=environment;
    if(!environment || !['ready','not-windows'].includes(environment.status)) {
      report.reason='Windows 所有者/用户预检未通过；回归未启动';
      return finish(report);
    }
    report.revision_before=getSnapshot(project);
    if(!validSnapshot(report.revision_before)) return finish({...report,reason:'开始快照缺失或格式无效；回归未启动'});
    const result=await startTests();
    try { report.revision_after=getSnapshot(project); }
    catch(error) { result.reason=`结束快照读取失败：${error.message}`; }
    if(!validSnapshot(report.revision_after)) result.reason ||= '结束快照缺失或格式无效';
    return finish({...report,...result});
  }).catch(error=>finish({...report,reason:`验收前置检查失败：${error.message}`}));
}

function decideStatus(report) {
  if(report.environment && !['ready','not-windows'].includes(report.environment.status)) return 'BLOCKED';
  if(report.timed_out || report.launch_error || report.signal || report.stream_error || !validSnapshot(report.revision_before) || !validSnapshot(report.revision_after)) return 'BLOCKED';
  if(report.exit_code!==0) return Number.isInteger(report.exit_code)?'FAIL':'BLOCKED';
  if(report.revision_before.digest===report.revision_after.digest && report.revision_before.files===report.revision_after.files) return 'PASS';
  return 'FAIL';
}

export async function verify(options={}) {
  const project=fs.realpathSync(options.project||root);
  const directory=outputDirectory(project,options.out);
  const check=options.checkEnvironment||((projectRoot)=>inspectWindows(projectRoot,{purpose:'configure'}));
  const getSnapshot=options.snapshot||makeSnapshot;
  const start=options.spawnProcess||spawn;
  const report=await runChild({project,directory,check,getSnapshot,start,timeoutMs:options.timeoutMs||0});
  return {report,directory,exit_code:report.status==='PASS'?0:report.status==='FAIL'?1:2};
}

export function cli(argv) {
  const parsed=args(argv); allowArgs(parsed,['out','help']);
  assert(!parsed._.length && (parsed.help===undefined || parsed.help===true), '参数无效');
  if(parsed.help) return {usage:'在正常用户宿主中运行：node scripts/verify.mjs --out .ai-loop/verification-4.7.6',note:'先进行Windows用户/所有者只读预检；不通过时不启动测试。'};
  assert(typeof parsed.out==='string','必须显式指定 --out 专属证据目录');
  return {run:true,out:parsed.out};
}

if(mainModule(import.meta.url)) {
  try {
    const options=cli(process.argv.slice(2));
    if(!options.run) console.log(JSON.stringify(options,null,2));
    else {
      const started=Date.now();
      console.log(`验收开始：先检查用户和所有者条件；通过后运行完整回归。日志目录：${options.out}`);
      const progress=setInterval(()=>console.log(`验收仍在进行，已用时 ${Math.floor((Date.now()-started)/1000)} 秒；测试输出持续保存到日志，结束后显示最终结果。`),15000);
      progress.unref();
      let result;
      try { result=await verify(options); }
      finally { clearInterval(progress); }
      console.log(JSON.stringify({status:result.report.status,report:path.relative(root,path.join(result.directory,'report.json')).replaceAll('\\','/'),exit_code:result.exit_code},null,2));
      process.exitCode=result.exit_code;
    }
  } catch(error) { console.error(`验收停止：${error.message}`); process.exitCode=2; }
}
