import { assert } from './lib.mjs';

// 只对一个根级字符串做无损修改，不重写其他 TOML 配置；不是完整 TOML 验证器。
function stringAt(text, start) {
  const quote = text[start];
  const triple = text.slice(start, start + 3) === quote.repeat(3);
  const width = triple ? 3 : 1;
  let index = start + width;
  while (index < text.length) {
    if (quote === '"' && text[index] === '\\') { index += 2; continue; }
    if (text[index] === quote) {
      if (!triple) return { end: index + 1, body: text.slice(start + 1, index), quote, triple };
      let end = index;
      while (text[end] === quote) end++;
      if (end - index >= 3) {
        assert(end - index <= 5, 'TOML 字符串引号不明确，停止自动合并');
        return { end, body: text.slice(start + 3, end - 3), quote, triple };
      }
      index = end; continue;
    }
    assert(triple || !/[\r\n]/.test(text[index]), 'TOML 单行字符串未闭合');
    index++;
  }
  throw new Error('TOML 字符串未闭合，停止自动合并');
}

function decodeString(token) {
  let body = token.body;
  if (token.triple) body = body.replace(/^\r?\n/, '').replace(/\r\n/g, '\n');
  if (token.quote === "'") return body;
  let value = '';
  const escapes = { b: '\b', t: '\t', n: '\n', f: '\f', r: '\r', '"': '"', '\\': '\\' };
  for (let index = 0; index < body.length; index++) {
    const character = body[index];
    if (character !== '\\') { value += character; continue; }
    const next = body[++index];
    assert(next !== undefined, 'TOML 字符串转义不完整');
    if (token.triple && /[ \t\r\n]/.test(next)) {
      let end = index;
      while (/[ \t\r\n]/.test(body[end] || '\0')) end++;
      assert(/[\r\n]/.test(body.slice(index, end)), 'TOML 多行续行转义无效');
      index = end - 1; continue;
    }
    if (Object.hasOwn(escapes, next)) value += escapes[next];
    else {
      assert(next === 'u' || next === 'U', '不支持的 TOML 字符串转义，停止自动合并');
      const width = next === 'u' ? 4 : 8;
      const hex = body.slice(index + 1, index + 1 + width);
      assert(hex.length === width && /^[a-fA-F0-9]+$/.test(hex), 'TOML Unicode 转义无效');
      const code = parseInt(hex, 16);
      assert(code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff), 'TOML Unicode 码点无效');
      value += String.fromCodePoint(code); index += width;
    }
  }
  return value;
}

function valueEnd(text, start) {
  let index = start;
  let depth = 0;
  while (index < text.length) {
    const character = text[index];
    if (character === '"' || character === "'") { index = stringAt(text, index).end; continue; }
    if (character === '#') {
      const newline = text.indexOf('\n', index);
      if (!depth) return newline < 0 ? text.length : newline;
      index = newline < 0 ? text.length : newline; continue;
    }
    if (character === '[' || character === '{') depth++;
    if (character === ']' || character === '}') depth--;
    assert(depth >= 0, 'TOML 值的括号不完整，停止自动合并');
    if (character === '\n' && !depth) return index;
    index++;
  }
  assert(!depth, 'TOML 数组或内联表未闭合');
  return index;
}

export function rootString(text, name) {
  let index = text.startsWith('\ufeff') ? 1 : 0;
  let root = true;
  let found = null;
  while (index < text.length) {
    while (/\s/.test(text[index] || '\0')) index++;
    if (index >= text.length) break;
    if (text[index] === '#') { const end = text.indexOf('\n', index); index = end < 0 ? text.length : end + 1; continue; }
    if (text[index] === '[') {
      const end = valueEnd(text, index);
      let start = index + (text[index + 1] === '[' ? 2 : 1);
      while (/[ \t]/.test(text[start] || '\0')) start++;
      const tableKey = text[start] === '"' || text[start] === "'" ? decodeString(stringAt(text, start)) : /^[A-Za-z0-9_-]+/.exec(text.slice(start))?.[0];
      assert(tableKey && tableKey !== name, name + ' 是表，不能自动覆盖为字符串');
      root = false; index = end + 1; continue;
    }
    let key = '';
    if (text[index] === '"' || text[index] === "'") {
      const token = stringAt(text, index); key = decodeString(token); index = token.end;
    } else {
      const match = /^[A-Za-z0-9_-]+/.exec(text.slice(index));
      assert(match, '无法安全定位 TOML 配置项，停止自动合并');
      key = match[0]; index += key.length;
    }
    while (/[ \t]/.test(text[index] || '\0')) index++;
    // 点分键不是目标根级标量；仍跳过其完整值，避免误读多行字符串。
    const direct = text[index] === '=';
    if (!direct) {
      assert(!root || key !== name, name + ' 是点分表，不能自动覆盖为字符串');
      while (index < text.length && text[index] !== '=' && text[index] !== '\n') {
        if (text[index] === '"' || text[index] === "'") index = stringAt(text, index).end;
        else index++;
      }
    }
    assert(text[index] === '=', 'TOML 配置项缺少赋值符号');
    index++;
    while (/[ \t]/.test(text[index] || '\0')) index++;
    const start = index;
    if (root && direct && key === name) {
      assert(!found, 'TOML 根级配置项重复：' + name);
      assert(text[start] === '"' || text[start] === "'", name + ' 须为字符串，不能自动覆盖其他类型');
      const token = stringAt(text, start);
      const tail = text.slice(token.end, valueEnd(text, token.end)).trim();
      assert(!tail || tail.startsWith('#'), 'TOML 字符串后存在无法合并的内容');
      found = { start, end: token.end, value: decodeString(token) };
    }
    index = valueEnd(text, start) + 1;
  }
  return found;
}

export function updateRootString(text, name, update) {
  const found = rootString(text, name);
  const value = update(found?.value || '');
  assert(typeof value === 'string', 'TOML 字符串更新结果无效');
  if (found) {
    if (value === found.value) return text;
    return text.slice(0, found.start) + JSON.stringify(value) + text.slice(found.end);
  }
  const bom = text.startsWith('\ufeff') ? '\ufeff' : '';
  return bom + name + ' = ' + JSON.stringify(value) + '\n\n' + text.slice(bom.length);
}
