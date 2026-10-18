import fs from 'node:fs';

// 不调整 Windows 权限。只跳过确实不能创建链接的用例，并在结果中公开原因。
export function link(t, target, destination, type) {
  try { fs.symlinkSync(target, destination, type); return true; }
  catch (error) {
    if (process.platform === 'win32' && ['EPERM', 'EACCES'].includes(error.code)) {
      t.skip(`Windows 不允许创建符号链接（${error.code}），此用例未验证`);
      return false;
    }
    throw error;
  }
}
