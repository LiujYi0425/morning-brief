/**
 * src/renderer/card.js —— 渲染进程：**唯一**碰 DOM 的文件
 * =====================================================================
 * 职责边界：不抓取、不解析、不网络 —— 那些全在主进程。
 *
 * ---------------------------------------------------------------------
 * 第三轮返工：为什么这个文件被重写成"单管线"
 * ---------------------------------------------------------------------
 * 真机反馈（用户原话）："筛选 chips、展开更多、看今天全部、收起这几个交互
 * 的逻辑仍有问题：不同点击路径会触发不同的逻辑漏洞，且行为不统一。"
 *
 * 旧版是**事件处理器各写各的** —— 四个按钮 + chips 各自直接改 `state`
 * 再各自决定要不要重绘。这必然出三类问题：
 *   · 按钮可见性自指（点了「看今天全部」→ 它把自己藏了）
 *   · `if (state.busy) return` 把忙碌期间的意图**静默丢掉**
 *   · 每个处理器只重绘它"以为"变了的那一块，于是顺序不同结果不同
 *
 * 现在的形状（**唯一**的一条路径，任何交互都走它）：
 *
 *     dispatch(action)  →  view = MB_VIEW.reduce(view, action)   （纯函数）
 *                       →  render(view)                          （全部从 derive 取）
 *                       →  syncWindow(view)                      （幂等）
 *                       →  syncFetch(view)                       （合并，不丢弃）
 *
 * 由此得到的可验证性质：
 *   · 界面上的每一个字、每一个 hidden 都来自 `MB_VIEW.derive(view)`，
 *     没有任何一处再从"上次渲染的结果"反推 —— 顺序无关性的前提。
 *   · `syncFetch` 用 fetchKey 做**合并**（conflation）：同一时刻至多一个
 *     在途请求，且**永远收敛到最后一个意图**，不存在"点了没反应"。
 *   · 窗口大小（expanded）**不进 fetchKey** ⇒ 收起/展开不触发任何网络请求。
 *
 * ⚠️ 经典脚本（非 module）。不许出现 import/export。所有失败经 diagnostics 报出。
 * =====================================================================
 */
(function main() {
  'use strict';

  var api = window.mb;
  var diag = window.MB_RENDERER_DIAG;
  var VM = window.MB_VIEW;

  function fatal(msg, why) {
    if (diag) diag.send('❌ ' + msg, why || 'card-fatal');
    /* 界面不能白着：把话说到脸上 —— 空白界面 + 空 stderr 是最难查的形态 */
    try {
      var n = document.getElementById('headline');
      if (n) { n.textContent = '渲染层启动失败：' + msg; n.setAttribute('data-empty', 'on'); }
    } catch (e) { /* 已经没救了 */ }
  }

  if (!api) { fatal('window.mb 缺失（preload 没接上）', 'no-bridge'); return; }
  if (!VM) { fatal('MB_VIEW 缺失（view-model.js 没加载）', 'no-view-model'); return; }

  /* ---------------- 手势闸 ---------------- */
  var gate = (function () {
    var I = window.MB_INTERACTION;
    if (I && typeof I.createInteractionGate === 'function') return I.createInteractionGate();
    api.log('[card] ❌ MB_INTERACTION 缺失（interaction.js 没加载）—— 拖动/点击分流退化为兜底');
    return {
      down: function () {},
      isDragGesture: function () { return false; },
      up: function () { return false; },
      shouldSwallowClick: function () { return false; },
      consumeSwallow: function () { return false; },
      canExpand: function () { return true; },
      snapshot: function () { return { fallback: true }; },
    };
  })();

  /* ---------------- 状态：整个界面只有这一份 ---------------- */
  var view = VM.createView();

  /* ---------------- DOM ---------------- */
  var $ = function (id) { return document.getElementById(id); };
  var elDate = $('date');
  var elHealth = $('health');
  var elHealthText = $('healthText');
  var elHeadline = $('headline');
  var elFilters = $('filters');
  var elCatSlider = $('catSlider');
  var elCatLabel = $('catLabel');
  var elCatPrev = $('catPrev');
  var elCatNext = $('catNext');
  var btnAddCat = $('btnAddCat');
  var btnEditCat = $('btnEditCat');
  var elCatPanel = $('catPanel');
  var elList = $('list');
  var elFoot = $('foot');
  var elToast = $('toast');
  var btnMore = $('btnMore');
  var btnAll = $('btnAll');
  var btnRefresh = $('btnRefresh');
  var btnAi = $('btnAi');
  var elAiPanel = $('aiPanel');
  var btnCollapse = $('btnCollapse');

  /* ---------------- 轻提示 ---------------- */
  var toastTimer = null;
  function toast(text) {
    if (!elToast) return;
    elToast.textContent = text;
    elToast.setAttribute('data-on', 'on');
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(function () {
      toastTimer = null;
      elToast.removeAttribute('data-on');
    }, 2000);
  }

  /* ---------------- 小工具 ---------------- */
  var WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
  function fmtDate(iso) {
    var d = iso ? new Date(iso) : new Date();
    return d.getMonth() + 1 + '月' + d.getDate() + '日 ' + WEEKDAYS[d.getDay()];
  }

  /** 相对时间：常驻卡片上"多久以前"比绝对时间更有用 */
  function relTime(iso) {
    if (!iso) return '时间未知';
    var t = Date.parse(iso);
    if (!Number.isFinite(t)) return '时间未知';
    var min = Math.round((Date.now() - t) / 60000);
    if (min < 1) return '刚刚';
    if (min < 60) return min + ' 分钟前';
    var h = Math.round(min / 60);
    if (h < 24) return h + ' 小时前';
    return Math.round(h / 24) + ' 天前';
  }

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  function setShown(node, visible) {
    if (!node) return;
    if (visible) node.removeAttribute('hidden');
    else node.setAttribute('hidden', 'hidden');
  }

  /* ================================================================== */
  /* 渲染：全部从 derive(view) 取值，分块记忆化（避免拖动滑动条时重绘列表）  */
  /* ================================================================== */
  var memo = { chips: null, slider: null, list: null, listArr: null, foot: null, head: null, health: null, ai: null };
  var lastDerived = null;

  function renderHealth(d) {
    var h = d.health;
    var key = h ? h.total + '/' + h.ok + '/' + h.bad + '/' + h.never + '|' + d.lastIngestAt : 'none|' + d.lastIngestAt;
    if (memo.health === key) return;
    memo.health = key;
    if (!h || !h.total) {
      elHealth.setAttribute('data-level', 'warn');
      elHealthText.textContent = '无源';
      elHealth.title = '还没有配置信息源';
      return;
    }
    var level = h.bad > 0 ? 'warn' : 'ok';
    if (h.bad >= h.total) level = 'bad';
    elHealth.setAttribute('data-level', level);
    /* ★ 把「从未抓过」和「异常」分开说（阶段 C）。
       ⚠️ 原来只说 `ok/total 正常`：用户看到「21/47 正常」会读成
          "只有 21 个源有用"，而真相是**一条都没坏**，只是那 26 条本机源
          还没被跑过（刷新是按当前类型范围的）。
          诊断指错方向比没有诊断更糟 —— 这句文案就是那个"方向"。 */
    var neverN = Number(h.never) || 0;
    var badN = Number(h.bad) || 0;
    if (!badN && !neverN) {
      elHealthText.textContent = h.total + ' 源';
    } else {
      var bits = [h.ok + ' 正常'];
      if (badN) bits.push(badN + ' 异常');
      if (neverN) bits.push(neverN + ' 未跑');
      elHealthText.textContent = bits.join(' · ');
    }
    elHealth.title =
      '正常 ' + h.ok + ' 个 · 异常 ' + h.bad + ' 个 · 从未抓过 ' + h.never + ' 个' +
      (d.lastIngestAt ? '\n上次抓取：' + relTime(d.lastIngestAt) : '\n尚未抓取过');
  }

  function renderHeadline(d) {
    /* ★ 降级/失败的原因挂在 tooltip 上：总览句那一行只有 360px 宽，
       把「API Key 被拒绝（HTTP 401）…」塞进去会把整行挤爆 ——
       但**不写出来**又违反「失败必须可见」。⇒ 一行短标记 ＋ 悬停看全文。
       ⚠️ 它必须进 memo 键：不进的话，简报从「降级」变成「正常」时
          tooltip 会留着上一次的旧原因（而正文已经变了）。 */
    var detail = (view.ai && view.ai.brief && view.ai.brief.detail) || '';
    var key = d.headline.text + '|' + (d.headline.empty ? 'e' : 'n') + '|' + detail;
    if (memo.head === key) return;
    memo.head = key;
    elHeadline.textContent = d.headline.text;
    if (detail) elHeadline.title = detail;
    else elHeadline.removeAttribute('title');
    if (d.headline.empty) elHeadline.setAttribute('data-empty', 'on');
    else elHeadline.removeAttribute('data-empty');
  }

  /**
   * 类型 chips（需求 2 上半）。
   *
   * ★ 与旧版最大的区别：**这里不再有任何"要不要显示筛选条"的判断**。
   *   存在性由 view-model 保证（chips 永远有「全部」这一项），
   *   显示与否是 CSS 的事（收起态也在，只是排得更紧）。
   *   真机反馈"一收起类型选项就没了"的病根就是旧版把这个判断放在了 CSS 里。
   */
  function renderChips(d) {
    var sig = d.chips.map(function (c) { return c.id + ':' + c.name + ':' + (c.on ? 1 : 0) + ':' + c.pref; }).join('|');
    if (memo.chips === sig) return;
    var prevIndex = memo.chipsIndex;
    memo.chips = sig;
    memo.chipsIndex = d.activeIndex;

    /* ★ 焦点保持（R4 无障碍契约：不许因为重绘把焦点丢到 body）。
       重绘会重建整排 chip，而重建时若焦点正在其中某个 chip 上，
       浏览器会把 activeElement 掉回 <body> —— 键盘用户就此"迷路"。
       ⇒ 先记住焦点在第几个，重建完再还回去。 */
    var focusIdx = -1;
    if (document.activeElement && elFilters.contains(document.activeElement)) {
      focusIdx = Number(document.activeElement.dataset.index);
      if (!Number.isFinite(focusIdx)) focusIdx = -1;
    }

    elFilters.textContent = '';
    d.chips.forEach(function (c, i) {
      var b = el('button', 'chip', c.name);
      b.type = 'button';
      b.id = 'chip-' + i;
      /* 单选组语义（见 card.html 里的说明）：是 radio 不是 tab */
      b.setAttribute('role', 'radio');
      b.setAttribute('aria-checked', c.on ? 'true' : 'false');
      /* roving tabindex：整排在 Tab 序列里只占一格（APG Radio Group） */
      b.tabIndex = c.on ? 0 : -1;
      b.dataset.index = String(i);
      if (c.on) b.setAttribute('data-on', 'on');
      /* ★ 偏好标记（本次功能）：让"这个类型是我不喜欢的"在导轨上就看得见。
         用户设完之后如果界面上完全没有痕迹，"设了"与"没设"在他眼里是一样的。
         ⚠️ 只加一个属性、不新增颜色：样式复用现有的 --state-ok / --state-bad
            与 accent（见 card.css 里 .chip[data-pref] 那一段）。 */
      if (c.pref === 1) b.setAttribute('data-pref', 'like');
      else if (c.pref === -1) b.setAttribute('data-pref', 'dislike');
      b.addEventListener('click', function () {
        api.log('[card] 点击类型 chip「' + c.name + '」');
        dispatch({ type: 'setCategory', id: c.id });
      });
      elFilters.appendChild(b);
    });

    if (focusIdx >= 0 && elFilters.children[focusIdx]) elFilters.children[focusIdx].focus();

    /* 选中项滚进视野（横向导轨可能装不下全部 chip）。
       ⚠️ 不用 scrollIntoView：它会连带滚动祖先，在一个 overflow:hidden 的
          body 里行为不可预期。手算偏移是确定的。 */
    if (prevIndex !== d.activeIndex) scrollChipIntoView(d.activeIndex);
  }

  function scrollChipIntoView(index) {
    if (!elFilters || rail.moved) return;
    var node = elFilters.children[index];
    if (!node) return;
    var left = node.offsetLeft;
    var w = node.offsetWidth;
    var sl = elFilters.scrollLeft;
    var cw = elFilters.clientWidth;
    if (left < sl) elFilters.scrollLeft = Math.max(0, left - 8);
    else if (left + w > sl + cw) elFilters.scrollLeft = left + w - cw + 8;
  }

  /**
   * 类型滑动条（用户新增要求："新增一个类型滑动条，方便在这些不同类型之间切换浏览"）。
   *
   * ⚠️ 两个必须处理的细节：
   *   ① 拖动过程中**不许改写 value** —— 否则会和用户的手指打架（一卡一卡的）。
   *   ② `input` 在拖动时**连续**触发。每次都立刻发请求就是请求风暴；
   *      所以走 `dispatch(action, 180)` 的**延迟取数**，由 syncFetch 的合并逻辑兜底。
   *      界面（高亮、文案）仍然即时更新。
   */
  function renderSlider(d) {
    if (!elCatSlider) return;
    var s = d.slider;
    var key = s.min + ':' + s.max + ':' + s.value + ':' + s.disabled;
    if (memo.slider !== key) {
      memo.slider = key;
      elCatSlider.min = String(s.min);
      elCatSlider.max = String(s.max);
      elCatSlider.disabled = !!s.disabled;
      if (!sliderDragging) elCatSlider.value = String(s.value);
      elCatLabel.textContent = s.label;
      elCatSlider.setAttribute('aria-valuetext', s.label);
      elCatSlider.title = s.hint;
      if (elCatPrev) elCatPrev.disabled = s.value <= s.min;
      if (elCatNext) elCatNext.disabled = s.value >= s.max;
    }
  }

  function renderList(d) {
    /* ⚠️ 键里必须带上「这是不是简报视图」和简报的日期：
       少了它，从「简报」切到「全部」时列表**不会重画**（条目数组换了但键没换），
       而用户看到的是「点了没反应」。 */
    var key = view.phase + '|' + (d.stale ? 'stale' : 'fresh') + '|' + view.activeCategory + '|' + d.empty +
      '|' + (view.briefView ? 'brief' : 'all') + '|' + ((view.ai && view.ai.brief && view.ai.brief.date) || '-');
    if (memo.list === key && memo.listArr === view.items) return;
    memo.list = key;
    memo.listArr = view.items;

    if (d.stale) elList.setAttribute('data-stale', 'on');
    else elList.removeAttribute('data-stale');

    elList.textContent = '';

    if (view.phase === 'loading' && d.empty) {
      // 骨架屏：加载时**保留结构**（结构稳定比"转圈"更重要）
      var sk = el('div', 'skeleton');
      for (var i = 0; i < 5; i += 1) {
        sk.appendChild(el('div', 'skeleton__line'));
        sk.appendChild(el('div', 'skeleton__line skeleton__line--short'));
      }
      elList.appendChild(sk);
      return;
    }

    if (d.empty) {
      var s = el('div', 'state');
      s.appendChild(el('span', null, view.phase === 'error' ? '读取失败。' : '这个口径下没有条目。'));
      s.appendChild(
        el('span', 'state__hint',
          view.phase === 'error'
            ? String(view.error || '')
            : (d.activeChip && d.activeChip.id != null
              ? '换个类型看看，或者点「全部」。'
              : (d.lastIngestAt ? '可能所有源都没更新。点「刷新」再拉一次。' : '先点「刷新」抓一次。'))),
      );
      elList.appendChild(s);
      return;
    }

    var frag = document.createDocumentFragment();
    view.items.forEach(function (it) {
      var row = el('button', 'item');
      row.type = 'button';
      row.setAttribute('role', 'listitem');
      row.dataset.read = it.read_state || 'unread';
      if (!it.url) row.title = '这条没有链接（源没给）';

      row.appendChild(el('div', 'item__title', it.title));

      /* ★ 简报视图里每条带一到两句摘要（AI 写的）。
         ⚠️ 没有摘要就**不占位** —— 降级形态下十几条全是空行会很难看，
            而且「这里本该有摘要」这件事总览句已经说过了。 */
      if (it.digest) row.appendChild(el('div', 'item__digest', it.digest));

      var meta = el('div', 'item__meta');
      if (it.source_name) meta.appendChild(el('span', 'item__source', it.source_name));
      meta.appendChild(el('span', null, relTime(it.published_at)));
      row.appendChild(meta);

      row.addEventListener('click', function () { openItem(it); });
      frag.appendChild(row);
    });
    elList.appendChild(frag);
  }

  /* ---------------- AI 设置面板（本次功能） ----------------
   * ⚠️ 面板里**唯一不来自 view-model 的东西是 Key 输入框的内容** ——
   *    它刻意只活在 DOM 里：view 状态会被诊断自检整个打出来（见 selfCheckSoon），
   *    把 Key 放进状态等于顺手写进日志。⇒ 点「保存」的那一刻才现读 input.value。
   *
   * ⚠️ 每个动作都走 runAi()：它保证三件事同时发生 ——
   *    ① 按钮进入「忙」并禁用（否则用户会连点，而每次连点都可能是一次真调用）；
   *    ② 结果（成功或失败）**一定**显示出来（静默失败在这里等于「点了没反应」）；
   *    ③ 完成后重新取一次数据，界面与库一致。
   */
  function aiRow(label, node) {
    var row = el('div', 'aipanel__row');
    row.appendChild(el('span', 'aipanel__label', label));
    row.appendChild(node);
    return row;
  }

  function runAi(what, fn) {
    dispatch({ type: 'aiBusy', what: what });
    return Promise.resolve()
      .then(fn)
      .then(function (r) {
        var res = r || { ok: true, text: '完成' };
        dispatch({ type: 'aiMsg', msg: { ok: res.ok !== false, text: String(res.message || res.reason || (res.ok === false ? '失败' : '完成')) } });
      })
      .catch(function (e) {
        /* ⚠️ 异常也要说出来。桥那头抛错时如果只 console.error，
           用户看到的就是「点了没反应」—— 本项目最忌讳的失败形态。 */
        dispatch({ type: 'aiMsg', msg: { ok: false, text: '出错了：' + String((e && e.message) || e) } });
      })
      .then(function () {
        fetchIO.done = null;   // 让下一次 syncFetch 真的去取（否则会被「同 key 不重复取」挡掉）
        syncFetch();
      });
  }

  function renderAiPanel(d) {
    if (!elAiPanel) return;
    var p = d.aiPanel;
    var key = [p.open, p.busy, p.msg ? (p.msg.ok ? '1' : '0') + p.msg.text : '', p.key.configured, p.key.maskedTail,
      p.key.mode, p.key.encryption, p.key.broken, p.config.endpoint, p.config.model, p.config.pickCount,
      p.usage.total, p.usage.briefs, p.brief ? p.brief.status + p.brief.date + (p.brief.poolCount || '-') : '-', p.lastBriefDate].join('|');
    if (memo.ai === key) return;
    memo.ai = key;

    if (btnAi) btnAi.classList.toggle('chip--on', !!p.open);
    elAiPanel.hidden = !p.open;
    elAiPanel.textContent = '';
    if (!p.open) return;

    /* ① Key 状态。三种情况都要说清 —— 尤其是「文件读不出来」那种，
          它以前会安静地表现成「没配过」，用户会以为自己记错了。 */
    var stateText = p.key.configured
      ? '已配置 ' + (p.key.maskedTail || '') + '（' +
        (p.key.mode === 'encrypted' ? '系统加密存储' : p.key.mode === 'memory' ? '只在内存里，重启要重填' : '明文落盘') + '）'
      : (p.key.broken ? '读不出来了（换过机器或系统钥匙串变了）—— 请重新填一次' : '还没有配置');
    elAiPanel.appendChild(el('div', 'aipanel__hint', 'Key：' + stateText));

    /* ★ P0（2026-09-25）：**没配 Key 时必须告诉用户去哪儿拿。**
     *
     * 原来的样子是只有上面那行「还没有配置」—— 而用户既不知道 ⚙ 是干什么的、
     * 也不知道 Key 去哪儿申请、要花多少钱、填错了会怎样。
     * 结果是：功能做完了，但**用户根本走不到能用那一步**（首次可用时间 ≤5 分钟这条
     * 北极星辅助指标，按原来的路径肯定超）。
     *
     * ⚠️ 链接走的是**同一条跳转通道**（`item:open`），因此同样过协议白名单；
     *    第一个参数传 null：那不是一条资讯，不该被标记成「已读」。 */
    if (!p.key.configured) {
      elAiPanel.appendChild(el('div', 'aipanel__guide',
        '三步就能用上 AI 摘要：① 去 platform.deepseek.com 注册、充几块钱（够用很久）；' +
        '② 在那边建一个 API Key；③ 粘到下面的框里、点「保存 Key」。' +
        '模型调用是你这台机器直连的，不经过任何服务器；按每天几百条资讯算，一天大约几分钱。'));
      var helpBtn = el('button', 'btn', '打开申请页面');
      helpBtn.type = 'button';
      helpBtn.addEventListener('click', function () {
        api.openItem(null, 'https://platform.deepseek.com/api_keys');
      });
      elAiPanel.appendChild(aiRow('', helpBtn));
    }

    /* ② Key 输入 + 保存（系统加密不可用时，必须让用户**显式选**存法） */
    var inp = el('input', 'aipanel__input');
    inp.type = 'password';
    inp.autocomplete = 'off';
    inp.placeholder = p.key.configured ? '要换就粘一个新的' : '粘一个 API Key（只留在本机）';
    elAiPanel.appendChild(aiRow('API Key', inp));
    var modeSel = null;
    if (!p.key.encryption) {
      modeSel = el('select', 'aipanel__input');
      var o1 = el('option', null, '只存内存（重启要重填）'); o1.value = 'memory';
      var o2 = el('option', null, '明文落盘（不推荐）'); o2.value = 'plaintext';
      modeSel.appendChild(o1); modeSel.appendChild(o2);
      elAiPanel.appendChild(el('div', 'aipanel__hint', '⚠️ 这台机器没有可用的系统加密，Key 没法加密保存 —— 必须你选一种：'));
      elAiPanel.appendChild(aiRow('存法', modeSel));
    }
    var row1 = el('div', 'catpanel__foot');
    var saveBtn = el('button', 'btn', p.busy === 'key' ? '保存中…' : '保存 Key');
    saveBtn.type = 'button';
    saveBtn.disabled = !!p.busy;
    saveBtn.addEventListener('click', function () {
      var v = inp.value;   // ← Key 只在这一刻被读出来，用完即弃
      if (!v) { dispatch({ type: 'aiMsg', msg: { ok: false, text: '先把 Key 粘进来' } }); return; }
      runAi('key', function () { return api.ai.setKey(v, modeSel ? modeSel.value : undefined); });
    });
    var testBtn = el('button', 'btn', p.busy === 'test' ? '测试中…' : '测试连通性');
    testBtn.type = 'button';
    testBtn.disabled = !!p.busy || !p.key.configured;
    testBtn.addEventListener('click', function () { runAi('test', function () { return api.ai.testKey(); }); });
    var clearBtn = el('button', 'btn', '清除');
    clearBtn.type = 'button';
    clearBtn.disabled = !!p.busy || !p.key.configured;
    clearBtn.addEventListener('click', function () { runAi('clear', function () { return api.ai.clearKey(); }); });
    row1.appendChild(saveBtn); row1.appendChild(testBtn); row1.appendChild(clearBtn);
    elAiPanel.appendChild(row1);

    /* ③ 端点 / 模型 / 精选条数 */
    var ep = el('input', 'aipanel__input'); ep.type = 'text'; ep.value = p.config.endpoint || '';
    var md = el('input', 'aipanel__input'); md.type = 'text'; md.value = p.config.model || '';
    var pc = el('input', 'aipanel__input aipanel__input--n'); pc.type = 'number'; pc.min = '3'; pc.max = '12'; pc.value = String(p.config.pickCount || 10);
    elAiPanel.appendChild(aiRow('端点', ep));
    elAiPanel.appendChild(aiRow('模型', md));
    elAiPanel.appendChild(aiRow('每天精选', pc));
    var row2 = el('div', 'catpanel__foot');
    var cfgBtn = el('button', 'btn', p.busy === 'config' ? '保存中…' : '保存设置');
    cfgBtn.type = 'button';
    cfgBtn.disabled = !!p.busy;
    cfgBtn.addEventListener('click', function () {
      runAi('config', function () {
        return api.ai.setConfig({ endpoint: ep.value, model: md.value, pickCount: Number(pc.value) || 10 });
      });
    });
    var genBtn = el('button', 'btn', p.busy === 'generate' ? '生成中…' : '重新生成简报');
    genBtn.type = 'button';
    genBtn.disabled = !!p.busy || !p.key.configured;
    genBtn.title = '会真的调用一次模型（花钱），并覆盖今天已有的那一份';
    genBtn.addEventListener('click', function () { runAi('generate', function () { return api.ai.generate(true); }); });
    /* ★ P2：「恢复默认」。默认值**由主进程随载荷发下来**（`config.defaults`）——
       渲染层要是自己抄一份，改了 prompt.js 而忘了改这里，
       「恢复默认」就会恢复到一个不存在的端点。 */
    var defBtn = el('button', 'btn', '恢复默认');
    defBtn.type = 'button';
    defBtn.disabled = !!p.busy;
    defBtn.title = '端点、模型、每天精选条数回到出厂值';
    defBtn.addEventListener('click', function () {
      var dft = (p.config && p.config.defaults) || {};
      runAi('config', function () {
        return api.ai.setConfig({ endpoint: dft.endpoint, model: dft.model, pickCount: dft.pickCount });
      });
    });
    row2.appendChild(cfgBtn); row2.appendChild(genBtn); row2.appendChild(defBtn);
    elAiPanel.appendChild(row2);

    /* ④ 用量与今天那一份的状态。
          ★ 北极星辅助指标写着「Token 消耗必须可见」—— 所以它在这里，
            而且**拿不到真实用量时明说「不知道」**，不显示成 0。 */
    var u = p.usage || {};
    var usageText = '今天用了 ' + (u.total || 0) + ' tokens（' + (u.knownBriefs || 0) + ' 份有记账）';
    if (u.unknownBriefs) usageText += '，另有 ' + u.unknownBriefs + ' 份拿不到用量';
    var b = p.brief;
    var briefText = b
      ? '今天的简报：' + b.status +
        ' · 今天共 ' + (b.rawCount == null ? '?' : b.rawCount) + ' 条 → 送进模型 ' + (b.poolCount == null ? (b.rawCount == null ? '?' : b.rawCount) : b.poolCount) + ' 条 → 精选 ' + (b.keptCount == null ? '?' : b.keptCount) + ' 条' +
        /* ★ P1：**截断必须看得见**。条目太多时只送最新的 300 条（MAX_RANK_POOL），
           而用户原来看到的是「我订阅的源明明更新了，简报里却没有」。 */
        (b.poolCount != null && b.rawCount != null && b.poolCount < b.rawCount ? '（⚠ 今天条目太多，只把最新的 ' + b.poolCount + ' 条送进了模型）' : '') +
        (b.detail ? ' · ' + b.detail : '')
      : (p.lastBriefDate ? '今天还没有简报（最近一份是 ' + p.lastBriefDate + '）' : '还没有生成过简报');
    elAiPanel.appendChild(el('div', 'aipanel__hint', usageText));
    elAiPanel.appendChild(el('div', 'aipanel__hint', briefText));
    if (p.msg) elAiPanel.appendChild(el('div', 'aipanel__msg', (p.msg.ok ? '✔ ' : '✗ ') + p.msg.text));

    var row3 = el('div', 'catpanel__foot');
    /* ★ P2：版本号（用户报问题时第一句就是「我装的是哪版」） */
    if (p.version) row3.appendChild(el('span', 'aipanel__hint', 'v' + p.version));
    row3.appendChild(el('span', 'catpanel__spacer'));
    var close = el('button', 'btn', '关闭');
    close.type = 'button';
    close.addEventListener('click', function () { dispatch({ type: 'closeAi' }); });
    row3.appendChild(close);
    elAiPanel.appendChild(row3);
  }

  /**
   * 底栏。
   *
   * ★ 这里**没有一行可见性判断** —— 全部来自 `d.buttons.*`：
   *     more.visible     = hasMore || filteredTotal > curatedLimit    （不看已显示多少）
   *     all.visible      = filteredTotal > curatedLimit || 已在全部模式  （自持）
   *     collapse.visible = expanded
   *   "加载完之后展开更多消失"这个观感也一并解决：加载完它是**变灰**（已全部展开），
   *   而不是消失 —— 按钮位置稳定，用户不会觉得界面坏了。
   */
  function renderFoot(d) {
    var b = d.buttons;
    var key = JSON.stringify([
      b.more.visible, b.more.enabled, b.more.label,
      b.all.visible, b.all.label, b.all.primary,
      b.collapse.visible, b.refresh.enabled,
      moreIO.running ? 1 : 0,
      ingestRunning ? 1 : 0,
    ]);
    if (memo.foot === key) return;
    memo.foot = key;

    setShown(btnMore, b.more.visible);
    btnMore.textContent = b.more.label;
    btnMore.disabled = !b.more.enabled || moreIO.running;

    setShown(btnAll, b.all.visible);
    btnAll.textContent = b.all.label;
    btnAll.setAttribute('data-primary', b.all.primary ? 'on' : 'off');

    /* ★ 焦点不许被自己隐藏掉（APG "Persistence of focus"）。
       最典型的一幕就是用户**点了「收起」** —— 这个按钮随即 `hidden`，
       浏览器把焦点丢回 <body>，键盘用户当场失去位置。
       ⇒ 隐藏前先把焦点迁到逻辑后继（顶栏，它本身就是展开/收起的入口）。 */
    setShown(btnCollapse, b.collapse.visible);
    keepFocusAlive(btnCollapse, bar);
    keepFocusAlive(btnMore, btnAll);

    /* 刷新：抓取在途时变灰。这一条同时是**重入守卫的可见部分** ——
       用户看到按钮灰了就不会继续点。 */
    btnRefresh.disabled = !b.refresh.enabled || ingestRunning;
    btnRefresh.textContent = ingestRunning ? '抓取中…' : '刷新';
  }

  /** 若 node 已不可见却still持有焦点，把焦点交给 fallback（同样不可见就再退一层） */
  function keepFocusAlive(node, fallback) {
    if (!node || !node.hidden) return;
    if (document.activeElement !== node) return;
    var chain = [fallback, btnRefresh, bar];
    for (var i = 0; i < chain.length; i += 1) {
      var f = chain[i];
      if (f && !f.hidden && typeof f.focus === 'function') {
        f.focus();
        return;
      }
    }
  }

  /**
   * 筛选栏编辑面板（本次功能）。
   *
   * 回答两个问题：「这个类型**包含哪些源**」+「我对它是什么态度」。
   *
   * ★ 这里**没有一行自己的判断**：显示什么、勾了什么、哪一档亮着、
   *   删除按钮是"删除类型"还是"确认删除"，全部来自 `derive().editor`。
   *   DOM 只负责把那份数据画出来 —— 于是"点了没反应""点了两次结果不同"
   *   这两类老问题在**状态层**就不可能存在，而不是靠这里小心一点。
   *   （这个文件被重写过一整轮，就是为了把判断从 DOM 里挪出去。）
   *
   * ⚠️ 每次全量重建（`textContent = ''`），不走 memo：
   *    源清单一屏也就三十来个节点，重建代价可以忽略；而 memo 的 key
   *    一旦漏进一个字段（比如"某一个勾变了"），界面就会停在旧状态上 ——
   *    那正是本项目栽过两次的形态。省下来的那点时间不值这个风险。
   */
  function renderPanel(d) {
    if (!elCatPanel) return;
    var ed = d.editor;

    setShown(elCatPanel, ed.visible);
    if (btnEditCat) {
      setShown(btnEditCat, d.editorButton.visible);
      if (d.editorButton.open) btnEditCat.setAttribute('data-open', 'on');
      else btnEditCat.removeAttribute('data-open');
      btnEditCat.setAttribute('aria-expanded', d.editorButton.open ? 'true' : 'false');
    }
    if (!ed.visible) {
      /* ⚠️ 关掉时**必须清空**，否则下次打开会先闪一眼上一次的内容 */
      elCatPanel.textContent = '';
      return;
    }

    var frag = document.createDocumentFragment();

    /* —— 第 1 行：标题 + 已勾数量 —— */
    var head = el('div', 'catpanel__row');
    head.appendChild(el('span', 'catpanel__title', '「' + ed.categoryName + '」包含的源'));
    head.appendChild(el('span', 'catpanel__hint', ed.selectedCount + '/' + ed.sources.length));
    frag.appendChild(head);

    /* —— 第 2 行：源清单（两列小勾选）——
       ⚠️ 取消勾选是**可逆的筛选**，不是删除：这里只是不再抓/不再归入这个类型，
          条目本身一条都不会少。文案里也这么说，免得用户不敢点。 */
    if (ed.loading) {
      frag.appendChild(el('div', 'catpanel__row catpanel__hint', '正在读取源清单…'));
    } else {
      var list = el('div', 'catpanel__list');
      ed.sources.forEach(function (s) {
        var label = el('label', 'catpanel__src');
        if (!s.enabled) label.setAttribute('data-off', 'on');
        if (s.bad) label.setAttribute('data-bad', 'on');
        if (s.title) label.title = s.title;
        var box = document.createElement('input');
        box.type = 'checkbox';
        box.checked = !!s.selected;
        box.disabled = !!ed.saving;
        box.dataset.sourceId = s.id;
        box.addEventListener('change', function () { toggleCategorySource(s.id); });
        label.appendChild(box);
        label.appendChild(el('span', 'catpanel__srcname', s.name));
        list.appendChild(label);
      });
      frag.appendChild(list);
    }

    /* —— 第 3 行：三档喜好 ——
       ★ 语义必须在界面上说清（用户定死的那三条）：
         喜欢 = 多放、中性 = 正常、**不喜欢 = 少放但不会没有**。
         只写"不喜欢"三个字的话，用户会以为它等于"过滤掉"，
         然后发现"怎么还能看到" —— 那是文案与行为不符。
       ⚠️ 每个按钮的 `title` 承载完整语义（悬停可读），面板里那行提示
          只留最短的一句 —— 它折行会把「删除类型」挤出可视区（真机量到过）。
       ⚠️ 这里**不再画分隔线**：收起态下每 12px 都要省（面板总共只有 176px），
          而 `.catpanel` 的纵向 gap 已经足以把三块分开。 */
    var prefRow = el('div', 'catpanel__row');
    /* ⚠️ `data-role` 是给离屏自检定位用的（`panelBox()` 报它的视口坐标）。
       没有它，自检只能报"面板在哪儿"，报不出"三档按钮在哪儿"，
       而真机上"按钮可不可点"恰恰只由后者决定。 */
    prefRow.setAttribute('data-role', 'pref');
    prefRow.appendChild(el('span', 'catpanel__label', '喜欢程度'));
    ed.prefOptions.forEach(function (o) {
      var b = el('button', 'chip', o.label);
      b.type = 'button';
      b.title = o.hint;
      b.setAttribute('role', 'radio');
      b.setAttribute('aria-checked', ed.pref === o.value ? 'true' : 'false');
      if (ed.pref === o.value) b.setAttribute('data-on', 'on');
      b.disabled = !!ed.saving;
      b.addEventListener('click', function () { setCategoryPref(o.value); });
      prefRow.appendChild(b);
    });
    frag.appendChild(prefRow);

    frag.appendChild(el('div', 'catpanel__hint', ed.prefHint));

    /* —— 第 3.5 行：「＋ 添加源」（阶段 A）——
     *
     * ⚠️ 这一行是**必需**的，不是锦上添花：面板里的源清单只列"这个类型包含的源"
     *    （列全部会把按钮挤出可视区，见 listSourceIdsOfCategory 那段注释），
     *    所以没有它，用户就只能取消勾选、永远加不进新的源。
     *
     * ⚠️ 输入框的**内容不回读**：提交时现取 `input.value` 一次就走，
     *    不进状态机。理由见 view-model.js 顶部那条规矩 ——
     *    DOM 是渲染的产物，把它当输入源就等于让界面变成第二份真相。
     *    （"正在验证"这个**布尔量**进状态机，因为它是界面必须显示的东西。） */
    if (ed.addSource.open) {
      var addRow = el('div', 'catpanel__row catpanel__add');
      /* ⚠️ **按顺序 append**，不用 `insertBefore`：
         逻辑上"名字在前、地址在后"，那就先建名字再建地址。
         用 insertBefore 多绕一步，而且装置的极简 DOM 里没有那个方法 ——
         它在真机上能跑、离线跑不了，等于这段代码**没有断言**。 */
      var nameInput = el('input', 'catpanel__input catpanel__input--name');
      nameInput.type = 'text';
      nameInput.maxLength = 12;
      nameInput.placeholder = '名字';
      nameInput.setAttribute('aria-label', '源名称');
      nameInput.disabled = ed.addSource.busy;
      addRow.appendChild(nameInput);

      var urlInput = el('input', 'catpanel__input');
      urlInput.type = 'text';
      urlInput.placeholder = ed.addSource.placeholder;
      urlInput.setAttribute('aria-label', 'feed 地址');
      urlInput.disabled = ed.addSource.busy;
      addRow.appendChild(urlInput);

      var goBtn = el('button', 'btn', ed.addSource.busy ? '验证中…' : '添加');
      goBtn.type = 'button';
      goBtn.disabled = ed.addSource.busy;
      goBtn.addEventListener('click', function () { submitAddSource(nameInput.value, urlInput.value); });
      addRow.appendChild(goBtn);
      frag.appendChild(addRow);
      frag.appendChild(el('div', 'catpanel__hint', ed.addSource.hint));

      var submitOnEnter = function (e) {
        if (e.key === 'Enter') { e.preventDefault(); submitAddSource(nameInput.value, urlInput.value); }
        else if (e.key === 'Escape') { e.preventDefault(); dispatch({ type: 'addSourceToggle', on: false }); }
        e.stopPropagation(); // 别让顶栏/文档级的快捷键抢走按键
      };
      urlInput.addEventListener('keydown', submitOnEnter);
      nameInput.addEventListener('keydown', submitOnEnter);
      /* 聚焦**地址**而不是名字：用户手里有的是地址，名字可以随口起一个 */
      setTimeout(function () { urlInput.focus(); }, 0);
    }

    /* —— 第 4 行：删除 / 添加源 / 关闭 ——
       ⚠️ 删除是**两步**（第一次点变成「确认删除」，再点才真的删）。
          理由见 view-model.js 的 askDelete：一次点击就删掉的话，
          误触的代价是"我辛苦分的类没了"，而这里没有撤销。 */
    var foot = el('div', 'catpanel__foot');
    var del = el('button', 'btn catpanel__del', ed.deleteLabel);
    del.type = 'button';
    del.disabled = !!ed.saving;
    if (ed.deleting) del.setAttribute('data-armed', 'on');
    del.title = '删除这个类型（条目本身不会被删除）';
    del.addEventListener('click', function () {
      if (VM.derive(view).editor.deleting) deleteCurrentCategory();
      else {
        dispatch({ type: 'askDelete' });
        toast('再点一次「确认删除」才真的删除（条目会保留）');
      }
    });
    foot.appendChild(del);
    foot.appendChild(el('span', 'catpanel__spacer'));
    /* 「＋ 添加源」：与「删除类型」分居两端，中间留白 —— 破坏性动作与新增动作
       不挨着（这一条与面板里其它按钮的排布规矩一致）。 */
    var addBtn = el('button', 'btn', ed.addSource.toggleLabel);
    addBtn.type = 'button';
    addBtn.disabled = !!ed.saving || ed.addSource.busy;
    addBtn.title = '粘贴一个 RSS / Atom 地址，加到这个类型里';
    addBtn.addEventListener('click', function () {
      dispatch({ type: 'addSourceToggle' });
    });
    foot.appendChild(addBtn);
    var close = el('button', 'btn', '关闭');
    close.type = 'button';
    close.addEventListener('click', function () { closeEditor(); });
    foot.appendChild(close);
    frag.appendChild(foot);

    elCatPanel.textContent = '';
    elCatPanel.appendChild(frag);
  }

  function render() {
    var d = VM.derive(view);
    lastDerived = d;
    elDate.textContent = fmtDate(null);
    /* ★★ 面板打开时把列表**隐藏**（本次修复，理由见 card.css 的 [data-editing]）。
     *
     * 为什么做到这一步：真机截图 + 逐像素比对证明，面板虽然 z-index 更高、
     * 底色也是**不透明**的，**列表的文字仍然画在面板上面** ——
     * 两层文字叠在一起，用户"根本看不清"。这是透明窗口里滚动容器的
     * 合成层顺序问题，z-index / translateZ / contain / isolation
     * **逐个试过，全部无效**（见 css 注释里的实验记录）。
     * ⇒ 唯一可靠的修法是：编辑期间**不画列表**。
     *   面板自己可滚动、里面就是这个类型的源，编辑时不需要同时看文章列表。
     * ⚠️ 是 `visibility: hidden` 而不是 `display: none`：
     *    前者保留布局（滚动位置不丢），后者会让列表重新排版、收起展开时跳一下。 */
    if (elList) {
      /* ⚠️⚠️ **两个浮层都算**（2026-09-25 修复）。
       *
       * 这条以前只认「编辑类型」面板，于是 AI 设置面板打开时列表照常绘制 ——
       * 而上面的注释早就写死了结论：透明窗口下 z-index / translateZ / contain / isolation
       * **逐个试过全部无效**，唯一的修法是「浮层打开期间不画列表」。
       * 用户报的「点 ⚙ 之后背景与原界面冲突、填不了 Key」就是这个。
       * ⇒ 这个属性的语义是**「有浮层盖在列表上」**，不是「正在编辑类型」。 */
      if (d.editor.visible || d.aiPanel.open) elList.setAttribute('data-editing', 'on');
      else elList.removeAttribute('data-editing');
    }
    /* 顶栏是 Disclosure 按钮 ⇒ aria-expanded 必须跟着状态走
       （aria-expanded 是"状态"而不是"角色"，角色写死在 HTML 里、状态由脚本同步） */
    if (bar) bar.setAttribute('aria-expanded', view.expanded ? 'true' : 'false');
    renderHealth(d);
    renderHeadline(d);
    renderChips(d);
    renderSlider(d);
    renderPanel(d);
    renderAiPanel(d);
    renderList(d);
    renderFoot(d);
    selfCheckSoon();
    return d;
  }

  /* ⚠️ 自检**必须节流**：拖动类型滑动条时每一帧都会 dispatch → render，
     不节流就是一秒几十行 JSON 进终端，日志被淹之后等于没有日志。 */
  var checkTimer = null;
  var checkDirty = false;
  function selfCheckSoon() {
    checkDirty = true;
    if (checkTimer) return;
    checkTimer = setTimeout(function () {
      checkTimer = null;
      if (!checkDirty) return;
      checkDirty = false;
      domSelfCheck('render');
    }, 400);
  }

  /* ================================================================== */
  /* 唯一的一条路径                                                      */
  /* ================================================================== */
  var fetchTimer = null;

  /**
   * @param {object} action
   * @param {number} [deferFetchMs] >0 = 延迟取数（拖动滑动条时用）
   */
  function dispatch(action, deferFetchMs) {
    view = VM.reduce(view, action);
    render();
    syncWindow();
    if (deferFetchMs > 0) {
      if (fetchTimer) clearTimeout(fetchTimer);
      fetchTimer = setTimeout(function () { fetchTimer = null; syncFetch(); }, deferFetchMs);
    } else {
      syncFetch();
    }
  }

  /* ---------------- 窗口：幂等，且**不触发取数** ---------------- */
  var windowState = 'collapsed';
  var windowFailStreak = 0;

  function syncWindow() {
    var want = view.expanded ? 'expanded' : 'collapsed';
    /* 乐观先写布局属性：它只影响排版（列表高度、总览句行数），
       而窗口尺寸变化是异步的。先写属性不会造成"数据口径不一致"。 */
    document.documentElement.setAttribute('data-state', want);
    if (windowState === want) return;
    windowState = want;
    /* ⚠️ 包一层 Promise.resolve：桥那头若同步返回（或返回 undefined），
       直接 `.then` 会抛 "Cannot read properties of undefined" —— 
       而那个异常发生在点击处理器里，看起来就像"按钮坏了"。 */
    Promise.resolve(api.card.setState(want)).then(
      function () {
        windowFailStreak = 0;
        /* 尺寸变化要等一次布局，两帧后再自检才读得准 */
        requestAnimationFrame(function () { requestAnimationFrame(function () { domSelfCheck('afterWindow/' + want); }); });
      },
      function (err) {
        windowFailStreak += 1;
        api.log('[card] ❌ 窗口状态切换失败：' + (err && err.message) + '（第 ' + windowFailStreak + ' 次）');
        if (windowFailStreak >= 2) return; // 别把失败变成死循环
        windowState = '?';
        dispatch({ type: 'expand', on: !view.expanded });
        toast('窗口切换失败，已还原');
      },
    );
  }

  /* ---------------- 取数：合并（conflation），**永不丢弃最后一个意图** ---------------- */
  var fetchIO = { wanted: null, done: null, running: false, seq: 0 };

  function setLoading(on) {
    if (on && view.phase !== 'loading') dispatch({ type: 'loading', on: true });
    else if (!on && view.phase === 'loading') dispatch({ type: 'loading', on: false });
  }

  function syncFetch() {
    if (fetchTimer) { clearTimeout(fetchTimer); fetchTimer = null; }
    var key = VM.fetchKey(view);
    fetchIO.wanted = key;
    if (fetchIO.running) return; // 在途的那次结束后会再看一眼 wanted
    if (key === fetchIO.done) return; // 本地已有这份数据
    runFetchLoop().catch(function (err) {
      fetchIO.running = false;
      api.log('[card] ❌ 取数循环自身异常：' + (err && err.message));
    });
  }

  /**
   * 合并循环。三条保证：
   *   ① 同一时刻至多一个在途请求（不会因为连点而堆积）
   *   ② 期间到达的**每一个**意图都被记进 wanted，退出前必然被满足或已被满足
   *   ③ 请求返回时若意图已变，结果**丢弃并重来**（不会出现"筛了 A 显示 B"）
   */
  async function runFetchLoop() {
    fetchIO.running = true;
    try {
      for (;;) {
        var key = fetchIO.wanted;
        if (key === null || key === fetchIO.done) break;
        fetchIO.wanted = null;
        var opts = VM.derive(view).fetch;
        setLoading(true);
        var mySeq = ++fetchIO.seq;
        try {
          var r = await api.brief.get({
            limit: opts.limit,
            categoryIds: opts.categoryIds || undefined,
            todayOnly: !!opts.todayOnly,
          });
          if (VM.fetchKey(view) !== key) continue; // 意图已变 ⇒ 这份结果作废
          fetchIO.done = key;
          /* ★ `forKey` = 这份数据的**出处**。reducer 会把它写进 state。
             `error` 靠它判断"展示中的内容与当前语境是否同源"（不同源就清掉，
             否则 chip 高亮是新类别、列表还是旧类别那批 —— 界面自相矛盾）。 */
          dispatch({ type: 'data', seq: mySeq, payload: r, forKey: key });
          api.log(
            '[card] data ok key=' + key + ' items=' + (r.items || []).length + ' hasMore=' + !!r.hasMore +
              ' todayTotal=' + r.todayTotal + ' filteredTotal=' + r.filteredTotal + ' curated=' + r.curated,
          );
        } catch (err) {
          if (VM.fetchKey(view) !== key) continue;
          fetchIO.done = key; // 失败也算"这一次问过了"，否则会疯狂重试
          dispatch({ type: 'error', message: (err && err.message) || String(err), forKey: key });
          api.log('[card] ❌ 取简报失败：' + (err && err.message) + '（语境 ' + key + '）');
          toast('读取失败');
        }
      }
    } finally {
      fetchIO.running = false;
      setLoading(false);
    }
  }

  /* ---------------- 翻页 ---------------- */
  var moreIO = { running: false };

  /**
   * 翻页连续性诊断（本轮 blocker 的"没嘴"问题）。
   *
   * 为什么必须有它：这次真机上表现为"筛选是坏的"，而**日志里一个字都没有** ——
   * 一份自相矛盾的 payload 被服务端照单全收、结果被合法采纳，
   * 从头到尾没有任何一处觉得不对劲。判据是纯算术，不需要额外状态：
   *   · 分页排序是 `published_at DESC, id DESC` ⇒ 新一页的**首条**必须 ≤ 上一页末条
   *     （游标就是上一页末条；相等只在 id 更小时才合法）
   *   · 库里不可能出现"比游标更新"的条目被排在游标之后
   * ⇒ 一旦新页首条 > 游标，就说明这两页不属于同一次查询（或者游标是旧的）。
   */
  function pagingLooksBroken(cursor, items) {
    if (!cursor || !items || !items.length) return null;
    var first = items[0];
    if (first.id == null || cursor.id == null) return null;
    var sameStamp = String(first.published_at || '') === String(cursor.publishedAt || '');
    if (sameStamp && first.id >= cursor.id) return '首条 id ' + first.id + ' ≥ 游标 id ' + cursor.id;
    if (!sameStamp) {
      /* 有时间段里：首条时间必须 ≤ 游标时间（字符串比较对 ISO 有效） */
      var a = first.published_at || '';
      var b = cursor.publishedAt || '';
      if (a && b && a > b) return '首条时间 ' + a + ' 晚于游标时间 ' + b;
      if (a && !b) return '游标没有时间而首条有时间 ' + a + '（可能跨了 NULL 段）';
    }
    return null;
  }

  async function loadMore() {
    var d = VM.derive(view);
    if (!d.buttons.more.enabled) {
      /* 两种"不可点"要分开报：一种是真没有下一页，一种是**游标不属于当前语境**。
         后者是本轮 blocker 的现场指纹，日志里必须能一眼看出来。 */
      api.log('[card] 展开更多：不可点（' +
        (!view.hasMore
          ? '已全部展开'
          : '游标出处 ' + String(view.cursorKey) + ' ≠ 当前语境 ' + VM.fetchKey(view) + '（代次 ' + view.cursorRev + '）') + '）');
      return;
    }
    if (moreIO.running) return;
    /* ★★ 在**发请求之前**把这次翻页的语境捕获下来（本轮 blocker 的修法核心）。
       之后 payload 与结果校验一律用 `key`，**绝不**在结果回来时再去 `derive(view)`
       读"当前"语境 —— 那正是旧代码的病：payload 用新状态的 categoryIds，
       而 cursor 是旧查询的产物，moreKey 守卫在语境已经切走之后才采样，
       两次采样必然相等 ⇒ 脏数据被合法采纳。 */
    var key = VM.fetchKey(view);
    /* ★ 还要把"游标的代次"一起捕获：`key` 只能证明"请求声明的语境"，
       而 `forRev` 才能证明"这次追加还落在我发出的那个游标上" ——
       游标被换过又切回同一语境时，只有代次能拦住。两把锁各管一件事。 */
    var forRev = view.cursorRev;
    moreIO.running = true;
    memo.foot = null;
    renderFoot(d);
    try {
      var cursor = view.cursor;
      var payload = { cursor: cursor };
      /* ⚠️ 翻页**必须带上当前筛选**（真机踩过）：只传 cursor 会翻出不属于该类别的条目。
       ⚠️ 也必须带上 `todayOnly` + `sinceIso`：否则「看今天全部」翻到第 2 页
          就翻出前几天的条目 —— 与按钮文案不符。 */
      if (d.fetch.categoryIds) payload.categoryIds = d.fetch.categoryIds;
      if (d.fetch.todayOnly) {
        payload.todayOnly = true;
        payload.sinceIso = view.sinceIso;
      }
      var r = await api.brief.more(payload);
      /* 三道校验，各拦一类脏结果：
         ① 请求期间**语境**变了吗（换类别 / 切口径 / 刷新）—— 变了就整条作废；
         ② 状态层还会用 `forKey` + `forRev` 复核一次（见 view-model.js 的 moreData）：
            `forKey` 管"这份追加还是不是当前 items 出处的产物"，
            `forRev` 管"这次追加还落不落在我发出的那个游标上"。
            两张网不重复：① 抓"发出去之后变了"，② 抓"发出去的时候就已经不是同一份"
            —— 后者只有状态里记着出处/代次才能发现，也正是本轮 blocker 的形态
            （游标来自旧查询、筛选项来自新查询）。
         ③ 返回的条目与游标**衔接不上**（错类别/错位置的特征）—— 见 pagingLooksBroken。 */
      if (VM.fetchKey(view) !== key) {
        api.log('[card] 翻页结果作废（期间口径/类别变了）：请求语境 ' + key + '，当前 ' + VM.fetchKey(view));
        return;
      }
      var gap = pagingLooksBroken(cursor, r.items);
      if (gap) {
        /* 不静默：这条日志就是"筛选看起来是坏的"那个现象的现场证据 */
        api.log('[card] ⚠️ 翻页返回的条目与游标衔接不上（' + gap + '）—— 已按过期结果丢弃');
        return;
      }
      var before = view.items.length;
      dispatch({ type: 'moreData', payload: r, forKey: key, forRev: forRev });
      if (view.items.length === before && (r.items || []).length) {
        api.log('[card] ⚠️ 翻页结果被状态层拒绝（forRev=' + forRev + ' 与当前游标代次 ' + view.cursorRev + ' 不符）');
        return;
      }
      api.log('[card] 翻页 ok 语境=' + key + ' 累计=' + view.items.length + ' hasMore=' + !!r.hasMore);
    } catch (err) {
      api.log('[card] ❌ 翻页失败：' + (err && err.message));
      toast('翻页失败');
    } finally {
      moreIO.running = false;
      memo.foot = null;
      renderFoot(VM.derive(view));
    }
  }

  /* ---------------- 新增类型 ----------------
   *
   * ⚠️⚠️ 这里原来是 `window.prompt(...)`，**在 Electron 渲染进程里根本不存在**。
   *    真机日志（用户点了「＋」之后）：
   *        [diag-renderer] 未处理的 rejection: prompt() is not supported.
   *    而 prompt 抛的是**被拒的 Promise**，不是同步异常 —— 所以
   *    `try { ... } catch` 一个字都接不住，用户看到的是"点了没反应"，
   *    界面上连一句提示都没有。这是**第二次**栽在同一类问题上
   *    （第一次是 interaction.js 用 ESM 语法、整文件静默不执行）：
   *    "看起来该能用的浏览器 API，在 Electron 里可能被刻意移除"。
   *
   * ⇒ 改成**自己画一个输入行**：它就在 .catbar 里就地展开，
   *   Enter 提交 / Esc 取消 / 失焦提交。不依赖任何被移除的 API。
   */
  var catInput = null;

  function closeCategoryInput() {
    if (!catInput) return;
    var node = catInput;
    catInput = null;
    if (node.parentNode) node.parentNode.removeChild(node);
  }

  function openCategoryInput() {
    if (catInput) { catInput.focus(); return; }
    var host = document.getElementById('catbar');
    if (!host) return;
    var wrap = el('span', 'catadd');
    var input = el('input', 'catadd__input');
    input.type = 'text';
    input.maxLength = 12;
    input.placeholder = '新类型名（回车确认）';
    input.setAttribute('aria-label', '新增类型名称');
    wrap.appendChild(input);
    host.appendChild(wrap);
    catInput = input;
    input.focus();

    var done = false;
    var commit = function () {
      if (done) return;
      done = true;
      var name = String(input.value || '').trim();
      closeCategoryInput();
      if (name) createCategory(name);
    };
    var cancel = function () {
      if (done) return;
      done = true;
      closeCategoryInput();
      if (bar) bar.focus();
    };
    input.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); commit(); }
      else if (e.key === 'Escape') { e.preventDefault(); cancel(); }
      e.stopPropagation(); // 别让顶栏的展开/收起快捷键抢走按键
    });
    input.addEventListener('blur', commit);
  }

  async function createCategory(name) {
    try {
      var r = await api.brief.createCategory(name);
      if (r && r.ok) {
        dispatch({ type: 'categories', list: r.categories || [] });
        toast('已新增类型「' + r.name + '」');
      } else {
        toast((r && r.reason) || '新增失败');
        api.log('[card] 新增类型失败：' + ((r && r.reason) || '未知原因'));
      }
    } catch (err) {
      api.log('[card] ❌ 新增类型抛错：' + (err && err.message));
      toast('新增失败：' + (err && err.message));
    }
  }

  /* ---------------- 筛选栏编辑面板（本次功能） ----------------
   *
   * 四条动作，各自只做一件事：**先改状态（立刻看得见），再落库（失败了就说）**。
   *
   * ⚠️ 为什么不是"等库里写成功再改界面"：这个卡片是常驻桌面的，
   *    勾一个框要等一次 IPC 往返才变色的话，手感是"点了没反应"。
   * ⚠️ 为什么不是"改完就不管了"：静默失败在这里的表现最坏 ——
   *    用户勾了、界面也勾上了、库里其实没写进去，下次启动那个勾就没了，
   *    而他会以为"设置存不住"（这是一种无法自证的坏法）。
   * ⇒ 乐观更新 + **失败回滚 + 说出原因**，两边都要。
   *
   * ⚠️ `editorSaving` 是把并发的写挡在门外的那道闸：两次写会互相覆盖，
   *    后写的赢，而用户看到的是自己最后点的那个结果 —— 一致只是巧合。
   */
  function openEditor() {
    dispatch({ type: 'openEditor' });
    var d = VM.derive(view);
    if (!d.editor.visible) {
      api.log('[card] 编辑面板：没有选中任何类型，忽略');
      return;
    }
    loadEditorData(d.editor.categoryId);
    api.log('[card] 打开编辑面板：' + d.editor.categoryName);
  }

  function closeEditor() {
    dispatch({ type: 'closeEditor' });
    if (btnEditCat && !btnEditCat.hidden && typeof btnEditCat.focus === 'function') btnEditCat.focus();
  }

  async function loadEditorData(categoryId) {
    dispatch({ type: 'editorSaving', on: true });
    try {
      var r = await api.brief.categorySources(categoryId);
      if (!r || !r.ok) {
        dispatch({ type: 'editorSaving', on: false });
        toast((r && r.reason) || '读取源清单失败');
        return;
      }
      /* ⚠️ 期间用户可能已经切了类型 / 关掉了面板 ⇒ 这份数据就不该再写进去
         （写进去的表现是"面板里出现另一个类型的勾"）。 */
      var now = VM.derive(view).editor;
      if (!now.visible || String(now.categoryId) !== String(categoryId)) {
        api.log('[card] 源清单回来时面板已经换了语境，丢弃（' + categoryId + '）');
        return;
      }
      dispatch({ type: 'editorData', sources: r.sources || [], sourceIds: r.sourceIds || [] });
    } catch (err) {
      dispatch({ type: 'editorSaving', on: false });
      api.log('[card] ❌ 读取源清单失败：' + (err && err.message));
      toast('读取源清单失败');
    }
  }

  /** 勾选 / 取消勾选一个源。**可逆**：再点一次就回来，条目一条都不会少。 */
  async function toggleCategorySource(sourceId) {
    var ed = VM.derive(view).editor;
    if (!ed.visible || ed.saving) {
      api.log('[card] 勾选被跳过：面板不可用或正在保存');
      return;
    }
    /* 先算目标集合（用状态机算，不在 DOM 里读 checkbox）：
       DOM 是渲染的产物，拿它当输入就等于让界面变成第二份真相。 */
    var next = [];
    var had = false;
    for (var i = 0; i < view.editorSelected.length; i += 1) {
      if (String(view.editorSelected[i]) === String(sourceId)) { had = true; continue; }
      next.push(String(view.editorSelected[i]));
    }
    if (!had) next.push(String(sourceId));
    var before = view.editorSelected.slice();

    dispatch({ type: 'editorToggleSource', id: sourceId });
    dispatch({ type: 'editorSaving', on: true });
    try {
      var r = await api.brief.setCategorySources(ed.categoryId, next);
      if (!r || !r.ok) {
        /* ★ 回滚：把界面拉回库里真实的样子，并把原因说出来。
           不回滚的话，用户看到的是一个"勾着但不生效"的界面。 */
        dispatch({ type: 'editorData', sources: VM.derive(view).editor.sources, sourceIds: before });
        dispatch({ type: 'editorSaving', on: false });
        toast((r && r.reason) || '保存失败');
        api.log('[card] ❌ 保存源映射失败：' + ((r && r.reason) || '未知原因'));
        return;
      }
      dispatch({ type: 'editorData', sources: VM.derive(view).editor.sources, sourceIds: r.sourceIds || next });
      dispatch({ type: 'categories', list: r.categories || VM.derive(view).categories });
      /* ⚠️ 这里**不 refresh 列表**：勾选改变的是"以后抓来的条目进哪个类型"，
         对**已经抓到的**条目没有影响（标签是抓取那一刻的事实，不回溯改写）。
         顺手刷一下只会让用户以为"改了映射，历史条目就换类了"。 */
      api.log('[card] 「' + ed.categoryName + '」的源已保存：' + (r.sourceIds || next).length + ' 个');
    } catch (err) {
      dispatch({ type: 'editorData', sources: VM.derive(view).editor.sources, sourceIds: before });
      dispatch({ type: 'editorSaving', on: false });
      api.log('[card] ❌ 保存源映射抛错：' + (err && err.message));
      toast('保存失败：' + (err && err.message));
    }
  }

  /** 三档喜好。落库之后**必须重取一次**：配额在服务端（buildBrief），本地改不了。 */
  async function setCategoryPref(pref) {
    var ed = VM.derive(view).editor;
    if (!ed.visible || ed.saving) return;
    var before = ed.pref;
    dispatch({ type: 'editorPref', pref: pref });
    dispatch({ type: 'editorSaving', on: true });
    try {
      var r = await api.brief.setCategoryPref(ed.categoryId, pref);
      if (!r || !r.ok) {
        dispatch({ type: 'editorPref', pref: before });
        dispatch({ type: 'editorSaving', on: false });
        toast((r && r.reason) || '设置失败');
        api.log('[card] ❌ 设置偏好失败：' + ((r && r.reason) || '未知原因'));
        return;
      }
      dispatch({ type: 'categories', list: r.categories || VM.derive(view).categories });
      dispatch({ type: 'editorSaving', on: false });
      /* ★ 配额是**服务端**执行的（buildBrief），所以必须重取一份才能看到效果。
         不重取的话用户设完"不喜欢"、列表一动不动，他会以为设置没生效。 */
      dispatch({ type: 'invalidate' });
      var label = pref === 1 ? '喜欢（多放）' : pref === -1 ? '不喜欢（少放但不会没有）' : '中性（正常）';
      toast('「' + ed.categoryName + '」已设为 ' + label);
      api.log('[card] 「' + ed.categoryName + '」偏好 = ' + pref + '（配额上限 ' + VM.quotaOf(r.quota) + ' 条）');
    } catch (err) {
      dispatch({ type: 'editorPref', pref: before });
      dispatch({ type: 'editorSaving', on: false });
      api.log('[card] ❌ 设置偏好抛错：' + (err && err.message));
      toast('设置失败：' + (err && err.message));
    }
  }

  /**
   * 「＋ 添加源」提交（阶段 A）。
   *
   * 主进程负责"先验再存"：它会用**与正式抓取同一个** fetchText 真抓一次，
   * 解析成功才入库。所以这里要等，而且要**把失败原因说出来** ——
   * 失败原因是给用户看的正文（"实际拿到的是「HTML 网页」"），
   * 只弹一句"添加失败"的话，用户不知道该改什么。
   *
   * ⚠️ 忙碌期间整块禁用（`addSourceBusy`）：一次点击就是一次真抓，
   *    连点会对着同一个地址打好几遍 —— 与"刷新"那条守卫同一个道理。
   */
  async function submitAddSource(name, feedUrl) {
    var ed = VM.derive(view).editor;
    if (!ed.visible || ed.saving || ed.addSource.busy) return;
    var url = String(feedUrl || '').trim();
    var nm = String(name || '').trim();
    if (!url) { toast('先粘贴一个 feed 地址'); return; }
    if (!nm) { toast('给它起个名字吧'); return; }

    dispatch({ type: 'addSourceBusy', on: true });
    api.log('[card] 添加源：' + nm + ' ' + url.slice(0, 70));
    try {
      var r = await api.brief.addSource({ name: nm, feedUrl: url, categoryId: ed.categoryId });
      if (!r || !r.ok) {
        dispatch({ type: 'addSourceBusy', on: false });
        toast((r && r.reason) || '添加失败');
        api.log('[card] ❌ 添加源被拒：' + ((r && r.reason) || '未知原因'));
        return;
      }
      /* 成功：收起输入行、把源清单重新读一遍（新源已经绑到当前类型） */
      dispatch({ type: 'addSourceToggle', on: false });
      dispatch({ type: 'categories', list: r.categories || VM.derive(view).categories });
      toast('已添加「' + r.name + '」（' + (r.itemCount || 0) + ' 条）');
      api.log('[card] ✓ 添加源成功：' + r.name + ' ' + r.feedUrl + ' ' + r.format);
      loadEditorData(ed.categoryId);
    } catch (err) {
      dispatch({ type: 'addSourceBusy', on: false });
      api.log('[card] ❌ 添加源抛错：' + (err && err.message));
      toast('添加失败：' + (err && err.message));
    }
  }

  /** 删除类型（已经过二次确认）。**条目一条都不会少** —— 这条是硬边界。 */
  async function deleteCurrentCategory() {
    var ed = VM.derive(view).editor;
    if (!ed.visible || ed.saving) return;
    var id = ed.categoryId;
    var name = ed.categoryName;
    dispatch({ type: 'editorSaving', on: true });
    try {
      var r = await api.brief.deleteCategory(id);
      if (!r || !r.ok) {
        dispatch({ type: 'editorSaving', on: false });
        dispatch({ type: 'cancelDelete' });
        toast((r && r.reason) || '删除失败');
        api.log('[card] ❌ 删除类型失败：' + ((r && r.reason) || '未知原因'));
        return;
      }
      dispatch({ type: 'categoryDeleted', list: r.categories || [], removedId: id });
      dispatch({ type: 'invalidate' }); // 类别表变了 ⇒ 重新取一份（口径回到「全部」）
      toast('已删除类型「' + name + '」（条目保留 ' + (r.itemsKept != null ? r.itemsKept : '') + ' 条）');
      api.log('[card] 已删除类型「' + name + '」，条目保留 ' + r.itemsKept + ' 条');
    } catch (err) {
      dispatch({ type: 'editorSaving', on: false });
      dispatch({ type: 'cancelDelete' });
      api.log('[card] ❌ 删除类型抛错：' + (err && err.message));
      toast('删除失败：' + (err && err.message));
    }
  }

  /* ---------------- 需求 3：打开原文 ---------------- */
  async function openItem(it) {
    /* ★ 无条件留痕（真机踩过）：用户报"点击没反应"时，渲染层与主进程**各自**
       要留下"我这边收到了什么"，否则分不清是没调用、被拦、还是打开失败。 */
    api.log('[card] 点击条目 id=' + it.id + ' url=' + (it.url ? String(it.url).slice(0, 70) : '(空)'));

    if (!it.url) {
      // 有相当一部分条目来自不提供 <link> 的源 —— 如实说明，不说"打不开"
      toast('这条没有原文链接（该源的 feed 未提供）');
      return;
    }
    try {
      var r = await api.openItem(it.id, it.url);
      if (r && r.ok) {
        it.read_state = 'opened';
        memo.list = null; // 让列表重绘一次（已读样式）
        render();
        toast('已在浏览器中打开');
      } else {
        toast((r && r.reason) || '打不开这个链接');
      }
    } catch (err) {
      api.log('[card] ❌ openItem 抛错：' + (err && err.message));
      toast('打开失败：' + (err && err.message));
    }
  }

  /* ================================================================== */
  /* 拖动（JS 手动拖动，结论来自 M0 真机取证）                            */
  /* ================================================================== */
  var dragActive = false;
  var pendingEvt = null;
  var frameQueued = false;

  function pt(e) { return { x: e.screenX, y: e.screenY }; }

  function sendDrag(phase, e) {
    try {
      var p = api.card.drag({ phase: phase, x: e.screenX, y: e.screenY });
      if (p && typeof p.then === 'function') {
        // ⚠️ 必须接住 rejection：不接的话每帧一条 unhandledrejection，日志被淹
        p.catch(function (err) { api.log('[drag] ❌ card:drag 被拒：' + (err && err.message)); });
      }
    } catch (err) {
      api.log('[drag] IPC 抛错：' + (err && err.message));
    }
  }

  function flushMove() {
    frameQueued = false;
    var e = pendingEvt;
    pendingEvt = null;
    if (!e || !dragActive) return;
    sendDrag('move', e);
  }

  var grip = $('grip');
  if (grip) {
    grip.addEventListener('pointerdown', function (e) {
      if (e.button !== 0) return;
      gate.down(pt(e));
      dragActive = true;
      document.documentElement.setAttribute('data-dragging', 'on');
      sendDrag('begin', e);
      try { grip.setPointerCapture(e.pointerId); } catch (err) { /* 兜底在 window 上 */ }
    });

    grip.addEventListener('pointermove', function (e) {
      if (!dragActive) return;
      gate.isDragGesture(pt(e));
      pendingEvt = e;
      if (frameQueued) return;
      frameQueued = true;
      if (typeof requestAnimationFrame === 'function') requestAnimationFrame(flushMove);
      else setTimeout(flushMove, 16);
    });

    var finish = function (e) {
      if (!dragActive) return;
      dragActive = false;
      frameQueued = false;
      pendingEvt = null;
      document.documentElement.setAttribute('data-dragging', 'off');
      // ★ 手势判定先做（同步），再发 end —— 顺序不能反：
      //   click 紧跟 pointerup 派发，标记必须在那之前就位
      var wasDrag = gate.up(pt(e));
      sendDrag('end', e);
      if (wasDrag) api.log('[drag] 本次判定为拖动 → 紧随的 click 将被吞掉');
      try { grip.releasePointerCapture(e.pointerId); } catch (err) { /* 已释放 */ }
    };
    grip.addEventListener('pointerup', finish);
    grip.addEventListener('pointercancel', finish);
  }

  // 兜底：指针在卡片外抬起时把手收不到 pointerup；缺了它卡片会卡在拖动态
  window.addEventListener('pointerup', function (e) {
    if (!dragActive) return;
    dragActive = false;
    frameQueued = false;
    pendingEvt = null;
    document.documentElement.setAttribute('data-dragging', 'off');
    var wasDrag = gate.up(pt(e));
    sendDrag('end', e);
    if (wasDrag) api.log('[drag] 兜底路径：判定为拖动 → 吞掉紧随的 click');
  });

  /* ---------------- 顶栏点击：展开 / 收起 ---------------- */
  var bar = $('bar');
  if (bar) {
    // 捕获阶段：拖动产生的 click 不让它往下走
    bar.addEventListener('click', function (e) {
      if (gate.shouldSwallowClick()) { e.stopPropagation(); e.preventDefault(); }
    }, true);

    // 冒泡阶段：真正决定展开/收起，也是**唯一**消费标记的地方
    bar.addEventListener('click', function (e) {
      if (gate.shouldSwallowClick()) {
        e.stopPropagation();
        gate.consumeSwallow();
        api.log('[card] 该 click 属于拖动副产品，已吞掉（防止误展开）');
        return;
      }
      if (!gate.canExpand()) return;
      dispatch({ type: 'expand', on: !view.expanded });
    });

    /* ★ 键盘用户必须也能展开（真机审查指出的缺口，这条比它看起来重要）。
       原来顶栏只有 click：不用鼠标的人按 Tab 能进 chips（roving tabindex 是对的），
       却**没有任何办法把卡片展开** —— 收起之后整个界面就对他关上了。
       顺带修好另一件事：renderFoot 里 keepFocusAlive(btnCollapse, bar) 的链首是 bar，
       而 bar 不可聚焦时 `bar.focus()` 是 no-op ⇒ 点「收起」后焦点仍掉回 body。
       bar 一旦可聚焦，那条链才真的接得住。
       （Enter 与 Space 都要处理：APG 的 Disclosure 模式两者等效。） */
    bar.addEventListener('keydown', function (e) {
      if (e.key !== 'Enter' && e.key !== ' ' && e.key !== 'Spacebar') return;
      if (e.target !== bar) return; // 顶栏里的其它可聚焦元素自己处理
      e.preventDefault();
      dispatch({ type: 'expand', on: !view.expanded });
    });
  }

  /* ---------------- 类型导轨：鼠标拖动横向滚动 ---------------- */
  var rail = { down: false, sx: 0, sl: 0, moved: false, swallow: false };

  if (elFilters) {
    elFilters.addEventListener('pointerdown', function (e) {
      if (e.button !== 0) return;
      rail.down = true;
      rail.moved = false;
      rail.sx = e.clientX;
      rail.sl = elFilters.scrollLeft;
    });
    elFilters.addEventListener('pointermove', function (e) {
      if (!rail.down) return;
      var dx = e.clientX - rail.sx;
      if (!rail.moved && Math.abs(dx) < 5) return; // 阈值以内算点击，不算拖动
      rail.moved = true;
      elFilters.scrollLeft = rail.sl - dx;
      elFilters.setAttribute('data-dragging', 'on');
      e.preventDefault();
    });
    var railEnd = function () {
      if (!rail.down) return;
      rail.down = false;
      elFilters.removeAttribute('data-dragging');
      if (rail.moved) rail.swallow = true; // 拖动收尾的那次 click 不算选择
      /* ⚠️ `moved` **必须在这里复位**（真机审查抓到的 bug）。
         scrollChipIntoView 用 `rail.moved` 判断"用户正在拖导轨，别抢滚动位置"，
         而它唯一的复位点是上面的 pointerdown。
         滑动条与左右步进键住在另一个容器（.catbar），点它们**不会**触发
         .filters 的 pointerdown ⇒ 一旦拖过一次导轨，此后用滑动条/步进键换类型时
         高亮 chip **永远不会滚进视野**：中间的类型名与列表都变了，
         那一行 chip 的高亮却不动，看起来像两边脱钩。 */
      rail.moved = false;
    };
    elFilters.addEventListener('pointerup', railEnd);
    elFilters.addEventListener('pointercancel', railEnd);
    elFilters.addEventListener('pointerleave', railEnd);
    elFilters.addEventListener('click', function (e) {
      if (rail.swallow) { rail.swallow = false; e.stopPropagation(); e.preventDefault(); }
    }, true);
    // 键盘：左右方向键在类型之间切换（ARIA tabs 的键盘契约）
    elFilters.addEventListener('keydown', function (e) {
      if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
      e.preventDefault();
      selectByOffset(e.key === 'ArrowRight' ? 1 : -1);
    });
  }

  function selectByOffset(delta) {
    var d = VM.derive(view);
    var n = d.chips.length;
    var next = (d.activeIndex + delta + n) % n;
    dispatch({ type: 'setCategoryIndex', index: next });
    var node = elFilters && elFilters.children[next];
    if (node && node.focus) node.focus();
  }

  /* ---------------- 类型滑动条 ---------------- */
  var sliderDragging = false;
  if (elCatSlider) {
    elCatSlider.addEventListener('pointerdown', function () { sliderDragging = true; });
    /* ⚠️ `input` 在拖动过程中**连续**派发（30–100 次/秒量级），
       每一次都立刻取数就是请求风暴，而且它是"用户不控制事件频率"的典型场景。
       处置（两层，缺一不可）：
         ① 这里**延迟 220ms** 才取数 —— 连续拖动时中间那些值根本不会发请求，
            用户停下来或者松手时才会真正取一次。界面（chip 高亮 + 类型名）
            仍然是**即时**更新的，所以"拖着看"这个手感在。
         ② syncFetch 的合并循环保证同一时刻至多一个在途请求，
            且永远收敛到最后一个意图 —— 即使真的连发也不会堆积。
       ⇒ 不采用"只在 change 上取数"的极端写法：那样拖动过程中列表一动不动，
          只剩一个小字在变，用户会以为卡死了。 */
    elCatSlider.addEventListener('input', function () {
      sliderDragging = true;
      dispatch({ type: 'setCategoryIndex', index: Number(elCatSlider.value) }, 220);
    });
    /* 松手 / 键盘每次按键 → `change` → **立即**提交（不等延迟） */
    elCatSlider.addEventListener('change', function () {
      sliderDragging = false;
      dispatch({ type: 'setCategoryIndex', index: Number(elCatSlider.value) });
      api.log('[card] 滑动条 → ' + VM.derive(view).slider.label);
    });
    elCatSlider.addEventListener('blur', function () { sliderDragging = false; });
  }
  if (elCatPrev) elCatPrev.addEventListener('click', function () { selectByOffset(-1); });
  if (elCatNext) elCatNext.addEventListener('click', function () { selectByOffset(1); });
  if (btnAddCat) btnAddCat.addEventListener('click', function () { openCategoryInput(); });
  /* 编辑入口（本次功能）：已经开着就关掉 —— 同一个按钮两态是用户最省心的约定 */
  if (btnEditCat) {
    btnEditCat.addEventListener('click', function () {
      if (VM.derive(view).editor.visible) closeEditor();
      else openEditor();
    });
  }

  /* ---------------- 底栏按钮 ---------------- */
  if (btnMore) btnMore.addEventListener('click', function () { loadMore(); });

  if (btnAll) {
    btnAll.addEventListener('click', function () {
      /* 「看今天全部」/「只看精选」= **纯模式切换**。
         ⚠️ 它**不再顺便展开窗口**（旧版会）—— 那正是"不同点击路径行为不一致"
            的来源之一。窗口大小与数据口径是两条正交的轴：
            收起态同样可以看今天全部（列表可以滚动），展开态同样可以只看精选。 */
      var before = view.showingAll;
      dispatch({ type: 'toggleAll' });
      api.log('[card] 点击「看今天全部」：' + (before ? '全部 → 精选' : '精选 → 全部'));
      toast(view.showingAll ? '已切到今天的全部条目' : '已切回精选');
    });
  }

  if (btnCollapse) {
    btnCollapse.addEventListener('click', function () {
      api.log('[card] 点击「收起」');
      dispatch({ type: 'expand', on: false });
    });
  }

  /* ---------------- 手动刷新：**真的去抓网** ----------------
   *
   * ⚠️ 这条路径不是"重新读一遍库"，而是**对全部启用源发一遍 HTTP 请求**。
   *    19 个源里只要有一个卡到超时（虎嗅就是 15s），一轮就是几十秒。
   *
   * ⚠️⚠️ 所以**必须有重入守卫**。第四轮返工重写渲染层时我把旧版的
   *     `btnRefresh.disabled = true` 弄丢了 —— 连点五下会在主进程侧
   *     `serialize()` 的队列里排五轮完整抓取，界面看起来只是"转了很久"，
   *     实际在对着 19 个站点连打五遍。用户不会知道自己在干什么。
   *    （主进程的 serialize 保证了它们**串行**、不会并发打源，所以不是灾难，
   *      但把一个"幂等的一次动作"变成"按点击次数放大"仍然是错的。）
   */
  var ingestRunning = false;

  /* ★ 齿轮：开/关 AI 设置面板。
     ⚠️ 它与「编辑类型」面板**互斥**：两个浮层同时开着会叠在一起，
        而 .catbar 只有一行高 —— 用户看到的是「面板串味了」。 */
  if (btnAi) {
    btnAi.addEventListener('click', function () {
      if (view.aiPanelOpen) dispatch({ type: 'closeAi' });
      else {
        if (view.editorOpen) dispatch({ type: 'closeEditor' });
        dispatch({ type: 'openAi' });
      }
    });
  }

  if (btnRefresh) {
    btnRefresh.addEventListener('click', async function () {
      if (ingestRunning) {
        api.log('[card] 刷新被跳过：上一轮抓取还在跑');
        toast('上一轮还在抓，稍等一下');
        return;
      }
      /* ⚠️⚠️ 从这里往下的**每一行都必须在 try 里** —— 理由见下面 finally 那段说明。
       *
       * 2026-09-24 的 c19f9e2 把"取当前类型名"那一行插到了 try **之前**，
       * 而那一行引用了一个**根本不存在的变量 `d`**：
       *     var scopeName = d.activeChip && …      ← ReferenceError
       * ⇒ 点刷新当场抛错、finally 永远不跑 ⇒ ingestRunning 永远是 true
       *   ⇒ **刷新按钮永久变灰**（文本卡在"抓取中…"），
       *   而主进程**连请求都收不到**（日志里一行都没有）。
       *   用户看到的只有"刷新了但一直在卡" —— 排查时最费时间的一种形态：
       *   现象在界面，原因在界面，可日志里什么都没有。
       * ⇒ 口径：**凡是把 ingestRunning 置真的代码，都必须在这一个 try 里**。
       *   以后再往这里加语句，请加在 try 内部。 */
      try {
        ingestRunning = true;
        memo.foot = null; // 让 renderFoot 重新算一次（它把 ingestRunning 算进 disabled）
        renderFoot(VM.derive(view));
        /* ★ 刷新时把**当前选中的类型**一起传下去（本次功能）：
           在此之前 `brief:ingest('manual')` 不带任何范围，于是"我只想看安全类"
           这个意图与"刷新"这个动作之间没有任何联系 —— 点一次刷新照样把
           全部启用源打一遍。现在选中类型时只抓该类型绑定的源并集。
           ⚠️ 提示文案也要跟着变：说"19 个源"而实际只抓 3 个，是另一种撒谎。 */
        var derived = VM.derive(view);
        var scopeCats = derived.fetch.categoryIds;
        var scopeName = derived.activeChip && derived.activeChip.id != null ? derived.activeChip.name : null;
        toast(scopeCats && scopeCats.length && scopeName
          ? '正在抓取「' + scopeName + '」的源…'
          : '正在抓取…（全部源，可能要几十秒）');
        var r = await api.brief.ingest('manual', scopeCats && scopeCats.length ? scopeCats : undefined);
        if (r && r.scopedEmpty) {
          /* ⚠️ "这个类型一个源都没绑"必须单独说：混进"新增 0 条"里的话，
             用户会以为源挂了，而他真正要做的是给这个类型勾上源。 */
          toast('「' + scopeName + '」还没有勾选任何源 —— 点「编辑」给它勾上');
        } else {
          toast('抓取完成：新增 ' + (r.newItems || 0) + ' 条' + (r.failed ? '，' + r.failed + ' 个源失败' : ''));
        }
          dispatch({ type: 'invalidate' });
      } catch (err) {
        api.log('[card] ❌ 手动抓取失败：' + (err && err.message));
        toast('抓取失败：' + (err && err.message));
      } finally {
        /* ⚠️ finally 而不是 try 末尾：异常路径下也必须把按钮放回来，
           否则刷新按钮就**永久变灰**了 —— 而用户看到的只是"刷新坏了"。 */
        ingestRunning = false;
        memo.foot = null;
        renderFoot(VM.derive(view));
      }
    });
  }

  document.addEventListener('keydown', function (e) {
    if (e.key !== 'Escape') return;
    /* ⚠️ 顺序是刻意的：**先关面板、再收卡片**。
       反过来的话，用户在面板里按 Esc 会连卡片一起收起来 ——
       而他只是想把这一层关掉（面板是浮层，Esc 的语义是"退出最上面那层"）。 */
    if (VM.derive(view).editor.visible) {
      api.log('[card] Esc：关闭编辑面板');
      closeEditor();
      return;
    }
    if (view.expanded) dispatch({ type: 'expand', on: false });
  });

  /* ---------------- 主进程推来的更新 ---------------- */
  if (typeof api.brief.onUpdated === 'function') {
    api.brief.onUpdated(function () {
      api.log('[card] 收到 brief:updated（主进程推来）');
      dispatch({ type: 'invalidate' });
    });
  }

  /* ================================================================== */
  /* DOM 自检（真机踩过两轮后加的）                                       */
  /* ================================================================== */
  /**
   * ⚠️ 为什么需要它：用户反馈"筛选完全没有 / 按钮点一下就消失"，
   *    而我在离线侧**看不到界面**，靠读代码推理连续两次没打中。
   *    ⇒ 让渲染层自己把 DOM 真实状态报出来。四组数字能立刻区分四种成因：
   *      · 元素不存在      → 渲染逻辑没跑到
   *      · display:none    → 渲染了但被 CSS 藏了
   *      · 在可视区外      → 渲染了也显示了，但被挤出窗口（用户"看不见"）
   *      · hidden 属性     → 渲染逻辑主动藏了（这时看 view 就知道为什么）
   *    这是 `diagnostics.js` 那条思路的延续：**失败要有嘴。**
   */
  function box(sel) {
    var n = document.querySelector(sel);
    /* ⚠️ **两个分支都要给 `exists`。**
       真机踩过：第一版只在"找不到"时返回 `{exists:false}`，找到时那个字段
       干脆不写 ⇒ `!f.exists` 对**存在的元素**也成立 ⇒ 每一份自检都报
       "❌ 类型导轨不存在（渲染逻辑没跑到）" —— 而同一行 JSON 里明明写着
       `"filters":{"display":"flex","visible":true,"w":399}`。
       结果是**诊断本身在撒谎**，而且撒得比没有诊断更糟：它会把我引去改
       本来完全正确的渲染逻辑。判据字段的缺省值必须是"存在"，不是"不存在"。 */
    if (!n) return { exists: false };
    var cs = getComputedStyle(n);
    var r = n.getBoundingClientRect();
    return {
      exists: true,
      display: cs.display,
      visibility: cs.visibility,
      visible: r.width > 0 && r.height > 0,
      w: Math.round(r.width),
      h: Math.round(r.height),
      top: Math.round(r.top),
      bottom: Math.round(r.bottom),
      scrollH: n.scrollHeight,
      clientH: n.clientHeight,
      scrollW: n.scrollWidth,
      clientW: n.clientWidth,
    };
  }

  function btnInfo(id) {
    var n = document.getElementById(id);
    if (!n) return 'missing';
    var r = n.getBoundingClientRect();
    return (n.hidden ? 'hidden' : n.disabled ? 'disabled' : 'shown') +
      '(w=' + Math.round(r.width) + ',x=' + Math.round(r.left) + ',y=' + Math.round(r.top) + ')';
  }

  /**
   * 编辑面板的可读快照。
   *
   * ⚠️ 用 `hidden` **属性**判断"该不该显示"，不用尺寸 ——
   *    与 `box()` 一样的道理：尺寸为 0 也可能是"刚渲染完还没排版"，
   *    把两种情况混成一句会把排查引向错误的方向。
   * ⚠️ 另外把"面板下沿有没有越过卡片下沿"算出来：面板是浮层，
   *    越界就是被 `.card` 的 overflow:hidden 切掉一截（收起态最容易）。
   */
  function panelBox() {
    var n = document.getElementById('catPanel');
    if (!n) return { exists: false };
    var b = box('#catPanel');
    b.hidden = !!n.hidden;
    var cardEl = document.querySelector('.card');
    b.cardBottom = cardEl ? Math.round(cardEl.getBoundingClientRect().bottom) : null;
    b.clippedBy = b.cardBottom != null && b.exists ? Math.max(0, b.bottom - b.cardBottom) : null;
    /* ★ 三个关键控件的**视口坐标**，一起报出来。
       为什么需要：面板里"点不点得到"只有坐标能回答，而我在真机上
       连着几次合成点击都打在别的东西上（还顺带打开了一篇文章）。
       有了这三个数，"按钮在不在可视区里"就是一行 JSON 能判的事，
       不用再靠推断 —— 这与本项目"失败要有嘴"是同一条规矩。 */
    var r1 = function (sel) {
      var el2 = n.querySelector(sel);
      if (!el2) return null;
      var rr = el2.getBoundingClientRect();
      return { x: Math.round(rr.left), y: Math.round(rr.top), w: Math.round(rr.width), h: Math.round(rr.height) };
    };
    b.list = r1('.catpanel__list');
    b.prefRow = r1('.catpanel__row[data-role="pref"]');
    b.footRow = r1('.catpanel__foot');
    if (b.list) {
      var listEl = n.querySelector('.catpanel__list');
      b.list.clientH = listEl.clientHeight;
      b.list.scrollH = listEl.scrollHeight;
      /* ⚠️ 再加三个"内容长什么样"的数：光看 scrollH 无法区分
         "源很多" / "名字换行把行撑高" / "网格没生效变成一列"。
         真机上我量到 scrollH=358（而离线只有 98），只能靠这三项定位。 */
      var cells = listEl.querySelectorAll('.catpanel__src');
      b.list.count = cells.length;
      b.list.firstCellH = cells.length ? Math.round(cells[0].getBoundingClientRect().height) : 0;
      b.list.names = [].slice.call(cells, 0, 4).map(function (c) { return c.textContent; });
      b.list.computed = {
        display: getComputedStyle(listEl).display,
        cols: getComputedStyle(listEl).gridTemplateColumns,
        autoRows: getComputedStyle(listEl).gridAutoRows,
      };
    }
    return b;
  }

  function domSelfCheck(tag) {
    try {
      var d = lastDerived || VM.derive(view);
      var cardEl = document.querySelector('.card');
      var cardRect = cardEl ? cardEl.getBoundingClientRect() : null;
      var cardH = cardRect ? Math.round(cardRect.height) : 0;
      /* ⚠️ 两个**不同**的基准，别混用（真机踩过）：
         · `cardTop/cardBottom` 是**视口坐标** —— 子元素的位置也是视口坐标，
           所以"有没有被挤出卡片"必须拿它们比。
         · `cardH` 只是卡片高度 —— 拿它去比子元素的视口 bottom 会**凭空多出
           cardTop 那么多**（卡片 inset 了 20px，于是每一份自检都报
           "底栏被挤出 19px"，而卡片本身好好的）。 */
      var cardTop = cardRect ? Math.round(cardRect.top) : 0;
      var cardBottom = cardRect ? Math.round(cardRect.bottom) : 0;
      var footEl = document.querySelector('.foot');
      var filtersEl = document.getElementById('filters');
      var sliderEl = document.getElementById('catSlider');
      var listEl = document.getElementById('list');

      var report = {
        tag: tag,
        dataState: document.documentElement.getAttribute('data-state'),
        /* ★ 视口坐标基准（子元素的位置也是视口坐标，判"有没有被挤出去"必须用它们） */
        card: { top: cardTop, bottom: cardBottom, h: cardH },
        /* 旧字段名保留：外部若有人按 viewH 读，含义不变（卡片高度） */
        viewH: cardH,
        /* ★ 状态三元组：任何"界面不一致"都能靠这三个数定位是哪条轴错了 */
        axis: { expanded: view.expanded, showingAll: view.showingAll, category: view.activeCategory, phase: view.phase },
        /* ★ 期望值 vs 实际 DOM —— 两边的差就是 bug 的位置 */
        expect: {
          chips: d.chips.length,
          chipNames: d.chips.map(function (c) { return c.name; }),
          activeIndex: d.activeIndex,
          sliderMax: d.slider.max,
          sliderValue: d.slider.value,
          more: d.buttons.more.visible + '/' + d.buttons.more.enabled,
          all: d.buttons.all.visible,
          collapse: d.buttons.collapse.visible,
        },
        actual: {
          chipCount: document.querySelectorAll('#filters .chip').length,
          radioCount: document.querySelectorAll('#filters .chip[role="radio"]').length,
          checkedCount: document.querySelectorAll('#filters .chip[aria-checked="true"]').length,
          sliderMax: sliderEl ? sliderEl.max : 'missing',
          sliderValue: sliderEl ? sliderEl.value : 'missing',
          sliderLabel: document.getElementById('catLabel') ? document.getElementById('catLabel').textContent : 'missing',
          buttons: {
            more: btnInfo('btnMore'),
            all: btnInfo('btnAll'),
            refresh: btnInfo('btnRefresh'),
            collapse: btnInfo('btnCollapse'),
            /* ★ 编辑入口也报（本次功能）：它是新按钮，而"新按钮到底在屏幕的
               哪个像素上"只有这里能回答 —— 我在真机上靠推断坐标点了三次都没中。 */
            edit: btnInfo('btnEditCat'),
          },
        },
        filters: box('#filters'),
        catbar: box('#catbar'),
        /* ★ 编辑面板（本次功能）：它是**浮层**，所以"有没有被裁掉"要单独报。
           面板贴着 catbar 下沿、绝对定位，靠 .card 的 overflow:hidden 收口 ——
           收起态卡片只有 340px 高，面板一旦超出去就会被切掉下半截，
           而那种"看起来像渲染坏了"的问题在离屏自检里必须能一眼看出来。 */
        panel: panelBox(),
        list: box('#list'),
        foot: box('.foot'),
        /* 底栏下沿越过卡片下沿多少（>0 = 真的被挤出可视区） */
        footClipped: footEl ? Math.round(footEl.getBoundingClientRect().bottom - cardBottom) : null,
        /* 底栏内容是否比底栏宽（按钮被横向裁掉的判据） */
        footOverflowX: footEl ? footEl.scrollWidth > footEl.clientWidth + 1 : null,
        /* 类型导轨装不下 → 需要横向滚动（这是**正常**的，不是缺陷；报出来是为了区分
           "滚动条没出现" 与 "chip 真的被裁掉了"） */
        chipsOverflowX: filtersEl ? filtersEl.scrollWidth > filtersEl.clientWidth + 1 : null,
        listScrollable: listEl ? listEl.scrollHeight > listEl.clientHeight + 1 : null,
      };

      /* ★★ 把上面那堆数字**直接翻译成结论**（第四轮返工加的）。
       *
       * 为什么值得单独做：这是我在离线侧唯一的反馈通道，而它原来的表达形式是
       * 一大坨 JSON —— 用户贴回来、我再人工推断，中间每转一手都可能读错。
       * 更糟的是它**分不清**四件完全不同的坏事：
       *     ① 元素根本没被渲染   （渲染逻辑没跑到）
       *     ② 渲染了但被 CSS 藏了（display:none / visibility:hidden）
       *     ③ 渲染了也显示了，但被挤出窗口（用户就是"看不见"）
       *     ④ 渲染逻辑**主动**把它藏了（hidden 属性 —— 这时该看 view 为什么）
       * 这四种的修法完全不同。下面把这四种判据写死成一句话，
       * 这样"贴回来的那一行"本身就是诊断，不需要我再解释一遍。
       */
      var verdict = [];
      (function diagnose() {
        var d0 = lastDerived || VM.derive(view);
        var cb = report.card.bottom;

        /* ⚠️ 判据写 `=== false` 而不是 `!f.exists`：
           真机上这个字段曾经"存在时不写"，于是 `!undefined` 为真 ⇒
           每一份自检都报"导轨不存在"。缺省值必须站在"正常"那一边。 */
        // 类型选项（用户点名抱怨过"收起后消失"的那一块）
        var f = report.filters;
        if (f.exists === false) verdict.push('❌ 类型导轨不存在（渲染逻辑没跑到）');
        else if (f.display === 'none') verdict.push('❌ 类型导轨被 CSS 设成 display:none');
        else if (f.visibility === 'hidden') verdict.push('❌ 类型导轨被 CSS 设成 visibility:hidden');
        else if (!f.visible) verdict.push('❌ 类型导轨尺寸为 0（w=' + f.w + ' h=' + f.h + '）');
        else if (f.bottom > cb) verdict.push('❌ 类型导轨被挤出卡片（bottom=' + f.bottom + ' > 卡片底 ' + cb + '）');
        else if (!report.actual.chipCount) verdict.push('❌ 导轨里一个 chip 都没有');
        else {
          verdict.push(
            '✔ 类型选项可见：' + report.actual.chipCount + ' 个 chip（role=radio ' + report.actual.radioCount +
              ' 个、选中 ' + report.actual.checkedCount + ' 个），顶端 y=' + f.top,
          );
          if (report.chipsOverflowX) {
            verdict.push('· 类型装不下，导轨需横向滚动（scrollW=' + f.scrollW + ' > clientW=' + f.clientW + '）—— 这是设计如此');
          }
        }

        // 底栏四个按钮
        var foot = report.foot;
        if (foot.exists === false) verdict.push('❌ 底栏不存在');
        else if (report.footClipped != null && report.footClipped > 0) {
          verdict.push('❌ 底栏被挤出卡片 ' + report.footClipped + 'px（下沿 ' + foot.bottom + ' > 卡片底 ' + cb + '）');
        } else if (report.footOverflowX) verdict.push('❌ 底栏内容被横向裁掉（按钮挤不下）');
        else verdict.push('✔ 底栏在卡片内（下沿距卡片底 ' + (cb - foot.bottom) + 'px）');

        var b = report.actual.buttons;
        var want = report.expect;
        verdict.push(
          '按钮：展开更多=' + b.more + '（应' + (want.more.split('/')[0] === 'true' ? '显示' : '隐藏') + '）' +
            ' 看今天全部=' + b.all + '（应' + (want.all ? '显示' : '隐藏') + '）' +
            ' 收起=' + b.collapse + '（应' + (want.collapse ? '显示' : '隐藏') + '）',
        );
        // 期望与实际不符时直接点名，不留给人工比对
        if (want.more.split('/')[0] === 'true' && /hidden/.test(b.more)) verdict.push('❌ 展开更多：该显示却被藏了');
        if (want.all && /hidden/.test(b.all)) verdict.push('❌ 看今天全部：该显示却被藏了（自持性被破坏）');
        if (want.collapse && /hidden/.test(b.collapse)) verdict.push('❌ 收起：展开态却没有收起按钮');

        /* 编辑面板（本次功能）。四种判据分开说 —— 与上面那套同一口径：
           "没开"是正常状态，"开了却看不见/被裁"才是缺陷。 */
        var pn = report.panel;
        if (pn.exists === false) verdict.push('❌ 编辑面板容器不存在（card.html 里少了 #catPanel）');
        else if (pn.hidden) verdict.push('· 编辑面板未展开（正常）');
        else if (!pn.visible) verdict.push('❌ 编辑面板已展开但尺寸为 0（w=' + pn.w + ' h=' + pn.h + '）');
        else if (pn.clippedBy != null && pn.clippedBy > 0) {
          verdict.push('❌ 编辑面板被卡片裁掉 ' + pn.clippedBy + 'px（下沿 ' + pn.bottom + ' > 卡片底 ' + pn.cardBottom + '）—— 收起态要能装下它');
        } else {
          verdict.push('✔ 编辑面板可见且完整（' + pn.w + '×' + pn.h + '，下沿距卡片底 ' + (pn.cardBottom - pn.bottom) + 'px）');
        }

        // 三条轴 —— 任何"界面不一致"都能靠它定位是哪条轴错了
        verdict.push(
          '轴：expanded=' + report.axis.expanded + ' showingAll=' + report.axis.showingAll +
            ' category=' + (report.axis.category == null ? '全部' : report.axis.category) +
            ' phase=' + report.axis.phase + ' 详情=' + JSON.stringify(d0.headline.text),
        );
        if (report.listScrollable) verdict.push('✔ 列表可滚动（收起态也能翻看）');
        else verdict.push('· 列表不足一屏，不需要滚动');
      })();
      report.verdict = verdict;

      api.log('[domcheck] ' + JSON.stringify(report));
      return report;
    } catch (err) {
      api.log('[domcheck] ❌ 自检本身出错：' + (err && err.message));
      return null;
    }
  }
  window.MB_DOMCHECK = domSelfCheck;

  /* ---------------- 启动 ---------------- */
  function boot() {
    api.log('[card] 渲染层就绪 拖动闸=' + (gate.snapshot && gate.snapshot().fallback ? '兜底(不可用)' : '正常') +
      ' 动作表=' + VM.ACTION_TYPES.join(','));
    dispatch({ type: 'expand', on: false }); // 先把界面画出来（含 chips 骨架）
    dispatch({ type: 'invalidate' });        // 再取第一份数据
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
