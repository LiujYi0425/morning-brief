/**
 * src/renderer/diagnostics.js —— 渲染层"自己报告失败"的通道（经典脚本 · 必须第一个加载）
 * =====================================================================
 * 为什么需要它（m0-probe 真机实测的教训）：
 *   有一轮日志里**一行渲染层输出都没有**、stderr 是空的 ——
 *   即 card.js 初始化就没跑起来，**而没有任何地方说明原因**。
 *   排查被迫靠猜。加上这个文件之后，同一类问题一次就定位了：
 *   `Uncaught SyntaxError: Unexpected token 'export' @ interaction.js:77:1`。
 *
 * 它捕获四类：
 *   ① window.onerror            脚本抛错
 *   ② unhandledrejection        异步里没接住的 promise（含 IPC 被拒）
 *   ③ **资源加载失败**（捕获阶段）—— `<script src>` 失败时后续脚本照常执行，
 *      只在控制台留一行；不常开 DevTools 的话真因会被掩盖成"card.js 有 bug"
 *   ④ **开机自检**：关键对象在不在（mb 桥 / MB_INTERACTION / 各 DOM 节点）
 * =====================================================================
 */
(function installRendererDiagnostics() {
  'use strict';

  var pending = [];
  var bridgeReady = false;
  /** 同类错误只报前 N 次 —— 不接住的话每帧一条，会把真正有用的日志淹掉 */
  var LIMIT_PER_KIND = 3;
  var counts = {};

  function send(line, kind) {
    var k = kind || 'misc';
    counts[k] = (counts[k] || 0) + 1;
    if (counts[k] > LIMIT_PER_KIND) return;
    var suffix = counts[k] === LIMIT_PER_KIND ? '（同类错误后续不再重复报）' : '';
    var text = '[diag-renderer] ' + line + suffix;
    try {
      if (bridgeReady && window.mb && typeof window.mb.log === 'function') {
        window.mb.log(text);
      } else {
        pending.push(text);
      }
    } catch (e) {
      /* 报错通道自己出错就到此为止 —— 绝不让它掩盖真正的错误 */
    }
  }

  function flush() {
    if (!window.mb || typeof window.mb.log !== 'function') return;
    bridgeReady = true;
    for (var i = 0; i < pending.length; i += 1) {
      try {
        window.mb.log(pending[i]);
      } catch (e) {
        /* 同上 */
      }
    }
    pending.length = 0;
  }

  window.onerror = function (message, source, lineno, colno, error) {
    send(
      '脚本错误: ' + message + ' @ ' + String(source).split('/').pop() + ':' + lineno + ':' + colno +
        (error && error.stack ? ' | ' + String(error.stack).split('\n')[1] : ''),
      'onerror',
    );
    return false;
  };

  window.addEventListener('unhandledrejection', function (e) {
    var r = e.reason;
    send('未处理的 rejection: ' + (r && r.message ? r.message : String(r)), 'rejection');
  });

  window.addEventListener(
    'error',
    function (e) {
      var t = e.target;
      if (!t || t === window) return;
      var what = t.tagName === 'SCRIPT' ? '脚本' : t.tagName === 'LINK' ? '样式' : String(t.tagName);
      send('资源加载失败: ' + what + ' src=' + (t.src || t.href || '(未知)'), 'resource');
    },
    true,
  );

  /** 开机自检：关键对象到底在不在 */
  function selfCheck(phase) {
    var report = {
      phase: phase,
      hasBridge: !!window.mb,
      hasInteraction: !!(window.MB_INTERACTION && typeof window.MB_INTERACTION.createInteractionGate === 'function'),
      grip: !!document.getElementById('grip'),
      bar: !!document.getElementById('bar'),
      list: !!document.getElementById('list'),
      readyState: document.readyState,
    };
    var problems = [];
    if (!report.hasBridge) problems.push('window.mb 缺失（preload 桥没建起来）');
    if (!report.hasInteraction) problems.push('window.MB_INTERACTION 缺失（interaction.js 没加载成功）');
    if (!report.grip) problems.push('#grip 缺失');
    if (!report.bar) problems.push('#bar 缺失');
    if (!report.list) problems.push('#list 缺失');

    send(
      '开机自检(' + phase + '): ' + JSON.stringify(report) +
        (problems.length ? '  ❌ ' + problems.join(' / ') : '  ✅ 关键对象齐全'),
      'selfcheck-' + phase,
    );
    return report;
  }

  flush();
  document.addEventListener('DOMContentLoaded', function () {
    flush();
    selfCheck('DOMContentLoaded');
  });
  window.addEventListener('load', function () {
    flush();
    selfCheck('load');
  });

  window.MB_RENDERER_DIAG = { send: send, selfCheck: selfCheck, flush: flush };
})();
