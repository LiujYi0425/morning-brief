/**
 * src/renderer/welcome.js —— 「第一次使用：配一个 API Key」窗口的界面
 * =====================================================================
 * ⚠️ 与 card.js 同一套约束 —— 每一条都对应一次真机失败，不是风格问题：
 *
 *   ① **经典脚本**：本文件里不许出现 import/export。本工程的 CSP 是
 *      `default-src 'none'`，模块脚本的获取走 `connect-src`（没列出）⇒ 会被拦；
 *      m0-probe 上踩过"离线用 import 加载全绿、真机整个文件不执行"。
 *   ② 只通过 `window.mb`（preload 的白名单）与主进程说话 ——
 *      本文件里没有 require / ipcRenderer / fs。
 *   ③ **Key 明文只在这一刻被读出来**（`inp.value` → `api.ai.setKey`），用完即弃：
 *      不进日志、不落 DOM 属性、保存成功后立刻清空输入框。
 *      架构文档 §4.2 / R-E05：通道里没有"读回 Key"，所以这里也不可能回显。
 *   ④ 三条关闭路径（✕ / Esc / 「先不配，先看新闻」）走**同一段代码**：
 *      记一行"用户选了什么"（**不记内容**），然后 window.close()。
 *
 * ⚠️ 为什么这个窗口不是卡片的一部分：卡片是**置底、不抢焦点**的
 *    （SetWindowPos HWND_BOTTOM + WS_EX_NOACTIVATE）——把"第一件该做的事"
 *    放进一个会沉到所有窗口下面的地方，等于没做。详见 src/main/index.js
 *    里 maybeShowWelcome() 的说明。
 * =====================================================================
 */
(function () {
  'use strict';

  var api = window.mb;
  var $ = function (id) { return document.getElementById(id); };

  var elMsg = $('msg');
  var inp = $('keyInput');
  var modeRow = $('modeRow');
  var modeSel = $('modeSel');
  var footA = $('footA');
  var footB = $('footB');
  var btnSave = $('btnSave');
  var btnSkip = $('btnSkip');
  var btnClose = $('btnClose');
  var btnApply = $('btnApply');
  var btnGen = $('btnGen');
  var btnTest = $('btnTest');
  var btnDone = $('btnDone');

  var busy = false;

  /* 「打开申请页面」的落点。默认指向 DeepSeek 的建 Key 页面；
     如果这台机器上配的供应商是别家（endpoint 改过），boot() 会把它换掉 ——
     给一个打不开的申请页面，比不给更糟。 */
  var APPLY_HOST = 'platform.deepseek.com';
  var applyUrl = 'https://platform.deepseek.com/api_keys';

  /** 只记"发生了什么"，**绝不带 Key 内容**（这条边界由离线判据钉着） */
  function say(msg) {
    try { api.log('[welcome] ' + msg); } catch (e) { /* 记不上不影响功能 */ }
  }

  function setMsg(level, text) {
    elMsg.textContent = text;
    elMsg.setAttribute('data-level', level);
  }

  function modeText(mode) {
    return mode === 'encrypted' ? '系统加密存储'
      : mode === 'memory' ? '只在内存里，重启要重填'
        : '明文落盘';
  }

  function paintBusy() {
    btnSave.disabled = busy;
    btnGen.disabled = busy;
    btnTest.disabled = busy;
    btnSkip.disabled = busy;
    btnSave.textContent = busy ? '保存中…' : '保存 Key';
    btnTest.textContent = busy ? '测着…' : '测一下能不能用';
    btnGen.textContent = busy ? '生成中…' : '生成今天的精选';
  }

  /* ---------------- 三条关闭路径共用的那一段 ---------------- */
  function leave(reason) {
    say(reason);
    try {
      /* ⚠️ window.close() 在 Electron 里就是关掉这扇 BrowserWindow。
         主进程那边**不需要**为此新开一条 IPC 通道（少一条通道少一处边界）。 */
      window.close();
    } catch (e) {
      say('关不掉窗口，只能靠用户自己关：' + String((e && e.message) || e));
    }
  }

  /* ---------------- 启动：读一次状态与配置，把界面摆成该有的样子 ---------------- */
  function boot() {
    if (!api || !api.ai) {
      setMsg('bad', '✗ 界面没能连上主进程（preload 没加载）。请关掉这个窗口，'
        + '用托盘菜单里的「退出晨报机」重新启动一次。');
      return;
    }

    /* 精选条数用**主进程给的配置**，不在这里抄一份默认值 ——
       抄了就会出现"设置里改成 8、这句话还写着 10"的漂移。 */
    try {
      api.ai.getConfig().then(function (cfg) {
        if (!cfg) return;
        if (cfg.pickCount) $('pickCount').textContent = String(cfg.pickCount);
        /* 步骤 ① 的落点跟着**真实配置**走（默认供应商是 DeepSeek） */
        var host = '';
        try { host = new URL(String(cfg.endpoint || '')).host; } catch (e2) { host = ''; }
        if (!host) return;
        if (host !== APPLY_HOST) {
          applyUrl = 'https://' + host;
          btnApply.textContent = '打开 ' + host;
          $('host').textContent = '（这台机器上配的不是 DeepSeek：请到它的控制台建 Key）';
        } else {
          $('host').textContent = host;
        }
      }, function () { /* 读不到就用 HTML 里那些默认值 */ });
    } catch (e) { /* 同上 */ }

    try {
      api.ai.keyStatus().then(function (st) {
        /* 已经配过（或文件坏了）——两种都要如实说，别让用户以为自己记错了 */
        if (st && st.configured) {
          setMsg('ok', '✔ 这台机器上已经配过一个 Key（' + (st.maskedTail || '') + '，'
            + modeText(st.mode) + '）。要换就直接粘新的，下面的框是空的。');
        } else if (st && st.broken) {
          setMsg('bad', '✗ 上次存的 Key 读不出来了（换过机器或系统钥匙串变了），重新粘一个就好。');
        }
        /* 系统加密不可用 ⇒ 必须让用户**显式选**存法（不许静默明文） */
        if (st && st.encryption === false) {
          modeRow.hidden = false;
          setMsg('bad', '⚠️ 这台机器没有可用的系统加密，Key 没法加密保存 —— '
            + '请在下面选一种存法，再点「保存 Key」。');
        }
      }, function () { /* 状态读不到不影响填 Key */ });
    } catch (e) { /* 同上 */ }
  }

  /* ---------------- 保存 Key ---------------- */
  function save() {
    if (busy) return;
    /* ★ 全文件唯一一次读 Key 明文的地方：用完即弃（见文件头 ③） */
    var v = inp.value;
    if (!v) {
      setMsg('bad', '✗ 先把 Key 粘进上面的框里');
      inp.focus();
      return;
    }
    busy = true;
    paintBusy();
    setMsg('busy', '正在保存…');
    api.ai.setKey(v, modeRow.hidden ? undefined : modeSel.value).then(function (r) {
      busy = false;
      paintBusy();
      if (r && r.ok) {
        inp.value = ''; // ★ 存下来了就别再留在界面上
        setMsg('ok', '✔ 已保存（' + modeText(r.mode) + '）。'
          + '想现在就看到 AI 精选，点左边的按钮；也可以直接关掉这个窗口。');
        footA.hidden = true;
        footB.hidden = false;
        say('保存成功，存法=' + (r.mode || '?'));
        if (r.warn) setMsg('ok', '✔ 已保存，但有一点要提醒：' + r.warn);
        return;
      }
      if (r && r.needsChoice) {
        modeRow.hidden = false;
        setMsg('bad', '✗ ' + (r.reason || '需要你选一种存法') + '（在下面选好，再点一次「保存 Key」）');
        say('保存被拒：需要用户选存法');
        return;
      }
      /* ⚠️ 存失败时**不清空输入框** —— 让用户重新粘一遍是最劝退的事之一 */
      setMsg('bad', '✗ 没存上：' + ((r && r.reason) || '未知原因'));
      say('保存失败：' + ((r && r.reason) || '未知原因'));
    }, function (err) {
      busy = false;
      paintBusy();
      setMsg('bad', '✗ 没存上：' + String((err && err.message) || err));
      say('保存抛错（内容不入日志）');
    });
  }

  /* ---------------- 保存之后：生成今天的精选 / 测一下 ---------------- */
  function generate() {
    if (busy) return;
    busy = true;
    paintBusy();
    setMsg('busy', '正在让模型从今天的条目里挑（要十几秒，别关这个窗口）…');
    api.ai.generate(true).then(function (r) {
      busy = false;
      paintBusy();
      if (r && r.ok) {
        var kept = (r.brief && r.brief.keptCount != null) ? r.brief.keptCount : r.kept;
        setMsg('ok', '✔ 今天的精选生成好了' + (kept ? '（' + kept + ' 条）' : '')
          + (r.tokenUsed ? '，用了 ' + r.tokenUsed + ' tokens' : '')
          + '。卡片已经刷新，可以关掉这个窗口了。');
        say('生成成功：kept=' + (kept == null ? '?' : kept) + ' tokens=' + (r.tokenUsed == null ? '?' : r.tokenUsed));
        return;
      }
      setMsg('bad', '✗ 没生成：' + ((r && (r.detail || r.reason)) || '未知原因'));
      say('生成失败：' + ((r && (r.reason || r.detail)) || '未知原因'));
    }, function (err) {
      busy = false;
      paintBusy();
      setMsg('bad', '✗ 没生成：' + String((err && err.message) || err));
      say('生成抛错');
    });
  }

  function test() {
    if (busy) return;
    busy = true;
    paintBusy();
    setMsg('busy', '正在连一次模型端点…');
    api.ai.testKey().then(function (r) {
      busy = false;
      paintBusy();
      var ok = r && r.ok !== false;
      setMsg(ok ? 'ok' : 'bad', (ok ? '✔ ' : '✗ ')
        + String((r && (r.message || r.reason)) || (ok ? '连得上' : '连不上')));
      say('测连通性：' + (ok ? '成功' : '失败'));
    }, function (err) {
      busy = false;
      paintBusy();
      setMsg('bad', '✗ 测试失败：' + String((err && err.message) || err));
      say('测连通性抛错');
    });
  }

  /* ---------------- 自检：把"这扇窗到底长什么样"变成日志里的一行 JSON ----------------
     ⚠️ 两条教训都在这里落地：
       · **按渲染结果判**（getComputedStyle + getBoundingClientRect），不按 hidden
         属性判 —— 2026-09-30 审查 #3：诊断按属性判的时候，给出的正好是相反的
         结论（"已藏好"，而屏幕上那个按钮就在那儿），会把人引去改本来正确的代码；
       · 这扇窗**只弹一次**：出问题连"再看一眼"的机会都没有 ⇒ 必须留证据。
         所以主进程会在 did-finish-load 之后来问一次，结果进统一日志。 */
  function facts(el) {
    var out = { exists: false, hidden: true, w: 0, h: 0, top: 0, bottom: 0 };
    if (!el) return out;
    var cs = window.getComputedStyle(el);
    var r = el.getBoundingClientRect();
    out.exists = true;
    out.hidden = cs.display === 'none' || cs.visibility === 'hidden';
    out.w = Math.round(r.width);
    out.h = Math.round(r.height);
    out.top = Math.round(r.top);
    out.bottom = Math.round(r.bottom);
    return out;
  }

  /* 两个方向都点名：该显示的被藏了 / 该藏起来的还在显示 */
  function dirLine(name, f, shouldShow) {
    if (!f.exists) return '✗ ' + name + '：元素不存在';
    if (shouldShow && f.hidden) return '✗ ' + name + '：该显示却被藏了（点不到）';
    if (!shouldShow && !f.hidden) return '✗ ' + name + '：该藏起来却还在显示（点了没反应）';
    return shouldShow
      ? '✔ ' + name + '=shown(w=' + f.w + ',y=' + f.top + ')'
      : '· ' + name + '=hidden';
  }

  function check(tag) {
    var sheet = facts(document.querySelector('.sheet'));
    var foot = facts(document.querySelector('.sheet__foot'));
    var elBody = $('body');
    var out = {
      tag: tag || 'manual',
      hasBridge: !!api,
      win: { w: window.innerWidth, h: window.innerHeight },
      sheet: { w: sheet.w, h: sheet.h, top: sheet.top, bottom: sheet.bottom },
      bodyScroll: {
        scrollH: elBody ? elBody.scrollHeight : 0,
        clientH: elBody ? elBody.clientHeight : 0,
      },
      el: {
        keyInput: facts(inp),
        btnSave: facts(btnSave),
        btnSkip: facts(btnSkip),
        btnGen: facts(btnGen),
        modeRow: facts(modeRow),
        foot: foot.hidden ? 'hidden' : 'shown',
        footTop: foot.top,
        footBottom: foot.bottom,
      },
      msgText: elMsg ? String(elMsg.textContent || '').slice(0, 80) : '',
      verdict: [],
    };
    /* ① 底栏必须在**面板之内** —— 真机上出过"窗口太矮把底栏切掉、按钮点不到"
       （卡片第三轮返工就是它）。 */
    out.verdict.push(
      foot.exists && foot.bottom <= sheet.bottom && foot.top >= sheet.top
        ? '✔ 底栏在面板内（' + foot.top + '–' + foot.bottom + '，面板 ' + sheet.top + '–' + sheet.bottom + '）'
        : '✗ 底栏被裁：' + foot.top + '–' + foot.bottom + '，面板 ' + sheet.top + '–' + sheet.bottom + ' —— 按钮点不到',
    );
    /* ② 面板必须落在窗口之内（inset: --win-pad ⇒ 四周留白应等于 20） */
    out.verdict.push(
      sheet.top === 20 && sheet.w === out.win.w - 40
        ? '✔ 面板按 --win-pad 居中（四周留白 20）'
        : '✗ 面板与窗口不吻合：留白=' + sheet.top + ' 宽=' + sheet.w + '（窗口宽 ' + out.win.w + '）',
    );
    /* ③ 元素的显隐（两个方向） */
    out.verdict.push(dirLine('Key 输入框', out.el.keyInput, true));
    out.verdict.push(dirLine('保存 Key', out.el.btnSave, true));
    out.verdict.push(dirLine('先不配，先看新闻', out.el.btnSkip, true));
    out.verdict.push(dirLine('生成今天的精选（保存成功后才该出现）', out.el.btnGen, false));
    out.verdict.push(dirLine('存法选择（系统加密不可用时才该出现）', out.el.modeRow, false));
    /* ④ 正文可滚动是设计（内容比一屏高），只如实记录，不算失败 */
    out.verdict.push(
      out.bodyScroll.scrollH <= out.bodyScroll.clientH
        ? '✔ 正文一屏装得下（' + out.bodyScroll.scrollH + '≤' + out.bodyScroll.clientH + '）'
        : '· 正文需要滚动（' + out.bodyScroll.scrollH + '>' + out.bodyScroll.clientH + '）—— 底栏仍在面板内，属正常',
    );
    if (!out.hasBridge) out.verdict.push('✗ 连不上主进程（window.mb 不在）—— preload 没加载');
    var text = JSON.stringify(out);
    try { if (api) api.log('[welcome] 自检 ' + text); } catch (e) { /* 记不上不影响功能 */ }
    return text;
  }

  window.MB_WELCOME_CHECK = check;

  /* ---------------- 接线 ---------------- */
  btnSave.addEventListener('click', save);
  btnGen.addEventListener('click', generate);
  btnTest.addEventListener('click', test);
  btnDone.addEventListener('click', function () { leave('用户填完了 Key，关掉欢迎窗'); });
  btnSkip.addEventListener('click', function () { leave('用户选了「先不配」'); });
  btnClose.addEventListener('click', function () { leave('用户点了 ✕（等同于先不配）'); });
  btnApply.addEventListener('click', function () {
    /* ⚠️ 走**同一条跳转通道**（item:open，主进程做协议白名单）；
       第一个参数传 null：那不是一条资讯，不该被标成「已读」。 */
    api.openItem(null, applyUrl);
    say('用户点了「打开申请页面」');
  });
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') leave('用户按了 Esc（等同于先不配）');
  });
  inp.addEventListener('keydown', function (e) {
    if (e.key === 'Enter') { e.preventDefault(); save(); }
  });

  boot();
})();
