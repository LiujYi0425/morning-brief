// diag-electron-api.mjs —— B11 取证脚本
// 目的：在 Electron 主进程 + ESM 环境下，逐条验证「怎样才能拿到 electron API」
// 结论见 docs/04-项目审查报告.md · B11
import { createRequire } from 'node:module';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const OUT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)), '..', 'report', 'diag-electron-api.txt'
);

const L = [];
L.push(`process.versions.electron = ${process.versions.electron}`);
L.push(`process.versions.node     = ${process.versions.node}`);
L.push(`process.type              = ${process.type}`);
L.push(`import.meta.url           = ${import.meta.url}`);
L.push('');

// 路径 1：createRequire + 'electron'
const r = createRequire(import.meta.url);
let v1;
try {
  v1 = r('electron');
  L.push('[1] createRequire("electron")   => typeof ' + typeof v1);
  if (typeof v1 === 'string') L.push('    ✗ 拿到的是字符串（二进制路径）: ' + v1);
  if (v1 && typeof v1 === 'object') {
    L.push('    keys: ' + Object.keys(v1).slice(0, 12).join(','));
    L.push('    v1.app  = ' + (v1.app ? 'OK  name=' + v1.app.getName() : 'UNDEFINED'));
    L.push('    v1.screen = ' + (v1.screen ? 'OK' : 'UNDEFINED'));
  }
} catch (e) {
  L.push('[1] createRequire("electron")   => THROW ' + e.message);
}
L.push('');

// 路径 2：createRequire + 'electron/main'
try {
  const v2 = r('electron/main');
  L.push('[2] createRequire("electron/main") => typeof ' + typeof v2);
  if (v2 && v2.app) L.push('    v2.app = OK');
} catch (e) {
  L.push('[2] createRequire("electron/main") => THROW ' + e.message);
}
L.push('');

// 路径 3：createRequire 的 resolve 结果（看它到底解析到哪个文件）
try {
  L.push('[3] resolve("electron") = ' + r.resolve('electron'));
} catch (e) {
  L.push('[3] resolve("electron") THROW ' + e.message);
}
try {
  L.push('[3] resolve("electron/main") = ' + r.resolve('electron/main'));
} catch (e) {
  L.push('[3] resolve("electron/main") THROW ' + e.message);
}
L.push('');

// 路径 4：动态 import('electron')
try {
  const m = await import('electron');
  const k = Object.keys(m);
  L.push('[4] await import("electron") keys = ' + (k.length ? k.slice(0, 12).join(',') : '(空)'));
  L.push('    m.default typeof = ' + typeof m.default);
  L.push('    m.default?.app   = ' + (m.default && m.default.app ? 'OK' : (typeof m.default === 'string' ? 'UNDEF (string!)' : 'UNDEF')));
  L.push('    m.app            = ' + (m.app ? 'OK' : 'UNDEF'));
} catch (e) {
  L.push('[4] await import("electron") THROW ' + e.message);
}
L.push('');

// 路径 5：模块内建的 module.builtinModules 是否含 electron
try {
  const mb = r('node:module');
  const bi = mb.builtinModules || [];
  L.push('[5] builtinModules 含 "electron" = ' + bi.includes('electron'));
  L.push('[5] isBuiltin("electron")         = ' + (mb.isBuiltin ? mb.isBuiltin('electron') : 'n/a'));
  L.push('[5] isBuiltin("electron/main")    = ' + (mb.isBuiltin ? mb.isBuiltin('electron/main') : 'n/a'));
} catch (e) {
  L.push('[5] module 探测 THROW ' + e.message);
}
L.push('');

// 路径 6：require('electron/main') 与 require('electron/main-process') 全试
for (const spec of ['electron', 'electron/main', 'electron/main-process', 'electron/common', 'electron/renderer']) {
  try {
    const v = r(spec);
    L.push(`[6] r("${spec}") => ${typeof v}` + (typeof v === 'string' ? ' (string)' : (v && v.app ? ' app=OK' : '')));
  } catch (e) {
    L.push(`[6] r("${spec}") THROW ${e.message.slice(0, 80)}`);
  }
}

writeFileSync(OUT, L.join('\n'), 'utf8');
process.exit(0);
