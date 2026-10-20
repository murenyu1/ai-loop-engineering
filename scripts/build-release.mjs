import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { deflateRawSync } from 'node:zlib';
import { BUNDLE, VERSION, safePath, atomicWrite, assert, mainModule, printResult } from './lib.mjs';
import { buildPlugin } from './build-plugin.mjs';
import { packDsh } from './build-dsh.mjs';

export function filesUnder(directory) {
  const result=[];
  function walk(relative='') {
    for(const name of fs.readdirSync(path.join(directory,relative)).sort()) {
      const file=relative ? relative+'/'+name : name, target=safePath(directory,file), stat=fs.lstatSync(target);
      assert(!stat.isSymbolicLink(),'发行包不允许链接：'+file);
      if(stat.isDirectory()) walk(file);
      else { assert(stat.isFile(),'发行包仅包含普通文件'); result.push({path:file,bytes:fs.readFileSync(target)}); }
    }
  }
  walk(); return result;
}
const crcTable=Array.from({length:256},(_,n)=>{for(let j=0;j<8;j++) n=n&1?0xedb88320^(n>>>1):n>>>1;return n>>>0;});
const crc32=bytes=>{let crc=0xffffffff;for(const byte of bytes)crc=crcTable[(crc^byte)&255]^(crc>>>8);return (crc^0xffffffff)>>>0;};
export function zip(entries) {
  const locals=[],central=[]; let offset=0;
  for(const entry of entries) {
    assert(!entry.path.includes('\\') && !entry.path.startsWith('/') && !entry.path.split('/').some(part=>!part||part==='.'||part==='..'),'压缩路径无效');
    const name=Buffer.from(entry.path),raw=entry.bytes,data=deflateRawSync(raw),crc=crc32(raw);
    assert(raw.length<0xffffffff && data.length<0xffffffff && name.length<65536,'发行文件过大');
    const head=Buffer.alloc(30); head.writeUInt32LE(0x04034b50); head.writeUInt16LE(20,4); head.writeUInt16LE(0x800,6);head.writeUInt16LE(8,8);head.writeUInt16LE(33,12);head.writeUInt32LE(crc,14);head.writeUInt32LE(data.length,18);head.writeUInt32LE(raw.length,22);head.writeUInt16LE(name.length,26);
    locals.push(head,name,data);
    const index=Buffer.alloc(46);index.writeUInt32LE(0x02014b50);index.writeUInt16LE(20,4);index.writeUInt16LE(20,6);index.writeUInt16LE(0x800,8);index.writeUInt16LE(8,10);index.writeUInt16LE(33,14);index.writeUInt32LE(crc,16);index.writeUInt32LE(data.length,20);index.writeUInt32LE(raw.length,24);index.writeUInt16LE(name.length,28);index.writeUInt32LE(offset,42);
    central.push(index,name);offset+=head.length+name.length+data.length;
  }
  assert(entries.length<65536 && offset<0xffffffff,'发行包超出 ZIP32 范围');
  const directory=Buffer.concat(central),end=Buffer.alloc(22);end.writeUInt32LE(0x06054b50);end.writeUInt16LE(entries.length,8);end.writeUInt16LE(entries.length,10);end.writeUInt32LE(directory.length,12);end.writeUInt32LE(offset,16);
  return Buffer.concat([...locals,directory,end]);
}
export function buildRelease() {
  const plugin=buildPlugin();
  const pluginFiles=filesUnder(plugin.output);
  const lock=JSON.parse(fs.readFileSync(path.join(plugin.output,'bundle.json')));
  const owned=new Set(['bundle.json',...lock.files.map(item=>item.path)]);
  assert(pluginFiles.every(item=>owned.has(item.path)), '插件输出含未登记文件，停止打包；请先核对并移出本机临时文件');
  const packages=[['workflow',filesUnder(safePath(BUNDLE,'core'))],['codex',pluginFiles]];
  const results=[];
  for(const [kind,files] of packages) {
    const bytes=zip(files),name=`ai-loop-${kind}-${VERSION}.zip`;
    atomicWrite(safePath(BUNDLE,'downloads/'+name),bytes);
    results.push({name,files:files.length,bytes:bytes.length,sha256:crypto.createHash('sha256').update(bytes).digest('hex')});
  }
  results.push(packDsh());
  atomicWrite(safePath(BUNDLE,'downloads/SHA256SUMS'),results.map(item=>`${item.sha256}  ${item.name}`).join('\n')+'\n');
  return {version:VERSION,packages:results};
}
if(mainModule(import.meta.url))printResult(buildRelease);
