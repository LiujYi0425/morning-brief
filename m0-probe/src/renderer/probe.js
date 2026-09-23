/**
 * probe.js —— M0 验证控制台
 *
 * 设计要点：**原地更新，不重建 DOM**。
 * 因为人工判定项里有 textarea，重建节点会让正在输入的内容和焦点一起丢掉。
 * 所以每个检查项只建一次节点，后续只改文本与类名。
 */

const api = window.m0;

const STATUS_TEXT = {
  pass: '✅ 通过',
  fail: '❌ 不通过',
  warn: '⚠️ 有保留',
  unable: '⛔ 无法验证',
  pending: '⬜ 未判定',
};

/** 手动判定按钮的取值 */
const MANUAL_OPTIONS = [
  { status: 'pass', label: '通过', cls: 'ok' },
  { status: 'fail', label: '不通过', cls: 'bad' },
  { status: 'unable', label: '无法验证', cls: '' },
];

/* ------------------------------------------------------------------ */
/* 小工具                                                              */
/* ------------------------------------------------------------------ */

function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined && text !== null) n.textContent = String(text);
  return n;
}

function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
}

function kvRow(dl, k, v) {
  dl.appendChild(el('dt', null, k));
  dl.appendChild(el('dd', null, v));
}

/* ------------------------------------------------------------------ */
/* 验收清单：一次性建节点，之后原地更新                                   */
/* ------------------------------------------------------------------ */

const checkRefs = new Map();

function buildChecks(checks) {
  const host = document.getElementById('checks');
  clear(host);
  checkRefs.clear();

  for (const c of checks) {
    const box = el('div', 'check');

    const head = el('div', 'check__head');
    head.appendChild(el('span', 'check__no', `验收 ${c.id}`));
    head.appendChild(el('span', 'check__title', c.title));
    const badge = el('span', 'badge');
    head.appendChild(badge);
    box.appendChild(head);

    const kindLabel =
      c.kind === 'auto' ? '程序自动' : c.kind === 'hybrid' ? '程序给数据 + 人眼确认' : '人工判定';
    box.appendChild(el('div', 'check__how', `【${kindLabel}】${c.how}`));

    const detail = el('div', 'check__detail');
    box.appendChild(detail);

    const ev = el('ul', 'check__evidence');
    box.appendChild(ev);

    let actions = null;
    let noteInput = null;

    if (c.kind !== 'auto') {
      actions = el('div', 'check__actions');
      actions.appendChild(el('span', 'check__how', '人工结论：'));
      const btns = [];
      for (const opt of MANUAL_OPTIONS) {
        const b = el('button', opt.cls, opt.label);
        b.type = 'button';
        b.addEventListener('click', async () => {
          await api.probe.patch({
            id: c.id,
            status: opt.status,
            note: noteInput ? noteInput.value : undefined,
          });
        });
        btns.push({ status: opt.status, node: b });
        actions.appendChild(b);
      }
      box.appendChild(actions);

      noteInput = el('textarea');
      noteInput.placeholder = '记录判定依据 / 看到的异常（会自动保存）';
      noteInput.addEventListener('input', () => {
        clearTimeout(noteInput.__t);
        noteInput.__t = setTimeout(() => {
          api.probe.patch({ id: c.id, note: noteInput.value });
        }, 600);
      });
      noteInput.addEventListener('change', () => {
        api.probe.patch({ id: c.id, note: noteInput.value });
      });
      box.appendChild(noteInput);

      checkRefs.set(c.id, { badge, detail, ev, btns, noteInput });
    } else {
      checkRefs.set(c.id, { badge, detail, ev, btns: null, noteInput: null });
    }

    host.appendChild(box);
  }
}

function updateChecks(checks) {
  for (const c of checks) {
    const ref = checkRefs.get(c.id);
    if (!ref) continue;

    ref.badge.className = `badge badge--${c.status}`;
    ref.badge.textContent = STATUS_TEXT[c.status] || c.status;

    ref.detail.textContent = c.detail || '';

    clear(ref.ev);
    for (const line of c.evidence || []) {
      ref.ev.appendChild(el('li', null, line));
    }
    if (!(c.evidence || []).length) {
      ref.ev.appendChild(el('li', null, '（暂无自动采集到的证据）'));
    }

    if (ref.btns) {
      for (const b of ref.btns) {
        b.node.classList.toggle('is-on', b.status === c.status);
      }
    }

    // 只在用户没在输入时回填备注，避免打断打字
    if (ref.noteInput && document.activeElement !== ref.noteInput) {
      const want = c.notes || '';
      if (ref.noteInput.value !== want) ref.noteInput.value = want;
    }
  }
}

/* ------------------------------------------------------------------ */
/* 核心结论 / 环境事实                                                  */
/* ------------------------------------------------------------------ */

function renderVerdict(facts) {
  const box = document.getElementById('verdict-box');
  clear(box);

  const cc = facts && facts.scaleCrossCheck;
  const el2 = facts && facts.electron;
  if (!cc) {
    box.appendChild(el('div', 'note note--muted', '探测尚未完成。'));
    return;
  }

  const cls = cc.verdict === 'pass' ? 'note--ok' : cc.verdict === 'fail' ? 'note--bad' : 'note--muted';
  box.appendChild(el('div', `note ${cls}`, cc.reason));

  if (cc.perDisplay && cc.perDisplay.length) {
    const dl = el('dl', 'kv');
    for (const d of cc.perDisplay) {
      kvRow(dl, `${d.label}（id=${d.displayId}）`, `scaleFactor = ${d.scaleFactor}`);
      kvRow(dl, 'Electron 推算物理尺寸', d.electronThinksPhysical);
      kvRow(dl, 'Windows 实测物理尺寸', d.windowsTruthPhysical || '（未匹配到）');
      kvRow(dl, '证据 A · 分辨率一致性', String(d.evidenceA));
      kvRow(dl, '证据 B · 缩放比一致性', String(d.evidenceB));
      if (d.windowsImpliedScale != null) {
        kvRow(dl, 'Windows 推得的缩放比', String(d.windowsImpliedScale));
      }
    }
    box.appendChild(dl);
  }

  if (cc.findings && cc.findings.length) {
    const pre = el('pre');
    pre.textContent = cc.findings.join('\n\n');
    box.appendChild(pre);
  }

  if (el2) {
    const dl = el('dl', 'kv');
    dl.className = 'kv';
    kvRow(dl, 'Electron', el2.electron);
    kvRow(dl, 'Chromium', el2.chrome);
    kvRow(dl, '平台', `${el2.platform} ${el2.arch}`);
    box.appendChild(dl);
  }
}

function renderEnv(facts) {
  const dl = document.getElementById('kv-env');
  clear(dl);
  if (!facts) return;

  const e = facts.electron || {};
  kvRow(dl, 'Electron 版本', e.electron || '—');
  kvRow(dl, 'Chromium 版本', e.chrome || '—');
  kvRow(dl, '平台', `${e.platform || '—'} ${e.arch || '—'}`);
  kvRow(dl, '显示器数量', facts.electronDisplays ? facts.electronDisplays.count : '—');

  const gpu = facts.gpu ? facts.gpu.featureStatus : null;
  if (gpu) {
    for (const [k, v] of Object.entries(gpu)) {
      kvRow(dl, `GPU · ${k}`, String(v));
    }
  }

  const rf = facts.rendererFacts;
  if (rf) {
    kvRow(dl, '渲染进程 devicePixelRatio', rf.devicePixelRatio);
    kvRow(dl, '渲染进程 screen', `${rf.screenWidth}×${rf.screenHeight}`);
    kvRow(dl, 'CSS.supports(backdrop-filter)', String(rf.backdropSupported));
    kvRow(dl, 'CSS.supports(-webkit-)', String(rf.webkitBackdropSupported));
    kvRow(dl, 'prefers-reduced-motion', String(rf.prefersReducedMotion));
    kvRow(dl, 'prefers-color-scheme: dark', String(rf.prefersDark));
  } else {
    kvRow(dl, '渲染进程事实', '（尚未上报 —— 卡片可能还没加载完）');
  }

  // 词汇表自检（sandbox 下 preload 必须内联一份通道表，这里验证它没漂移）
  const cp = facts.contractParity;
  if (cp) {
    kvRow(
      dl,
      '词汇表自检',
      cp.ok
        ? `✅ 一致（${cp.actualCount} 条通道，preload 内联副本与 contract.cjs 相同）`
        : `❌ 漂移！缺失 ${cp.missing.length} 条 / 多余 ${cp.extra.length} 条 —— 见下方原始数据`,
    );
  } else {
    kvRow(dl, '词汇表自检', '（等卡片上报）');
  }
}

function renderDisplays(facts) {
  const host = document.getElementById('displays');
  clear(host);
  if (!facts || !facts.electronDisplays) return;

  for (const d of facts.electronDisplays.displays) {
    const box = el('div', 'card-box');
    const dl = el('dl', 'kv');
    kvRow(dl, '名称', d.label);
    kvRow(dl, 'id / 主屏', `${d.id} ${d.id === facts.electronDisplays.primaryId ? '（主屏）' : ''}`);
    kvRow(dl, 'scaleFactor', d.scaleFactor);
    kvRow(dl, 'DIP 尺寸', `${d.sizeDip.w} × ${d.sizeDip.h}`);
    kvRow(dl, 'Electron 推算物理', `${d.physicalExpected.w} × ${d.physicalExpected.h}`);
    kvRow(dl, 'DIP 坐标', `(${d.boundsDip.x}, ${d.boundsDip.y})`);
    box.appendChild(dl);
    host.appendChild(box);
  }

  // 逐显示器给一个"移过去"的按钮，供验收 7 / 8 使用
  const btnHost = document.getElementById('display-buttons');
  clear(btnHost);
  for (const d of facts.electronDisplays.displays) {
    const b = el('button', null, `移到 ${d.label.slice(0, 18)}`);
    b.type = 'button';
    b.addEventListener('click', async () => {
      await api.card.moveToDisplay(d.id);
      await refresh();
    });
    btnHost.appendChild(b);
  }
}

function renderWindowsFacts(facts) {
  const host = document.getElementById('windows-facts');
  clear(host);
  if (!facts || !facts.windowsDisplays) {
    host.appendChild(el('div', 'note note--muted', '未采集。'));
    return;
  }

  const w = facts.windowsDisplays;
  if (!w.ok) {
    host.appendChild(
      el('div', 'note note--bad', 'PowerShell 探测失败：' + (w.errors || []).join('; ')),
    );
    return;
  }

  for (const m of w.monitors || []) {
    const dl = el('dl', 'kv');
    kvRow(dl, '设备', m.device);
    kvRow(dl, '适配器', m.adapter);
    kvRow(dl, '物理分辨率', `${m.width} × ${m.height}`);
    kvRow(dl, '物理坐标', `(${m.x}, ${m.y})`);
    kvRow(dl, 'logPixels', `${m.logPixels}（= ${Math.round((m.logPixels / 96) * 100)}%）`);
    kvRow(dl, '枚举成功', String(m.enumOk));
    host.appendChild(dl);
  }

  if (w.registry) {
    host.appendChild(
      el(
        'div',
        'note note--muted',
        `注册表 LogPixels：${w.registry.LogPixels ?? '（未设置）'}` +
          `；PerMonitorSettings 条目数：${(w.registry.perMonitor || []).length}`,
      ),
    );
  }

  if ((w.errors || []).length) {
    const pre = el('pre');
    pre.textContent = w.errors.join('\n');
    host.appendChild(pre);
  }
}

/* ------------------------------------------------------------------ */
/* 焦点测试进度条                                                       */
/* ------------------------------------------------------------------ */

let focusTick = null;
let focusLocal = null;

function renderFocus(state) {
  const fill = document.getElementById('focus-fill');
  const stats = document.getElementById('focus-stats');
  const btn = document.getElementById('btn-focus');

  if (!state) return;

  if (state.running) {
    focusLocal = { startedAt: Date.now(), durationMs: state.durationMs };
    btn.disabled = true;
    btn.textContent = '测试进行中…（去别的窗口打字，别碰卡片）';
    if (!focusTick) {
      focusTick = setInterval(() => {
        if (!focusLocal) return;
        const elapsed = Date.now() - focusLocal.startedAt;
        const pct = Math.min(100, (elapsed / focusLocal.durationMs) * 100);
        fill.style.width = pct + '%';
        const left = Math.max(0, Math.ceil((focusLocal.durationMs - elapsed) / 1000));
        stats.textContent = `剩余 ${left} 秒…（期间请不要点击卡片）`;
      }, 200);
    }
    return;
  }

  if (focusTick) {
    clearInterval(focusTick);
    focusTick = null;
  }
  fill.style.width = '100%';
  btn.disabled = false;
  btn.textContent = '开始 20 秒焦点测试';

  if (state.finished) {
    // 三态：pass / fail / invalid。invalid 不许显示成"不通过"——
    // 它不是"测出来不行"，是"根本没测到"（详见主进程 window.js · getFocusTestState）
    const base =
      `测试结束：显示卡片 ${state.cardShowCount} 次，卡片 focus ${state.cardFocusCount} 次，` +
      `面板 blur ${state.panelBlurCount} 次 → `;
    if (state.verdict === 'pass') {
      stats.textContent = base + '通过（显示动作确实发生过，且卡片全程没有抢焦点）';
      stats.style.color = '#085041';
    } else if (state.verdict === 'invalid') {
      stats.textContent =
        base + '无效（测试期内没有发生"显示卡片"的动作，什么都没测到 —— 这不是通过）';
      stats.style.color = '#7a4a00';
    } else {
      stats.textContent = base + '不通过（卡片抢了焦点）';
      stats.style.color = '#791f1f';
    }
  } else {
    stats.textContent = '焦点测试未开始。点按钮开始后，请随便去别的窗口打字，别碰卡片。';
    stats.style.color = '';
  }
}

/* ------------------------------------------------------------------ */
/* 刷新与绑定                                                          */
/* ------------------------------------------------------------------ */

async function refresh() {
  const [state, facts, cardState] = await Promise.all([
    api.probe.getState(),
    api.capability.get(),
    api.card.getState(),
  ]);

  renderChips(state.summary);
  renderVerdict(facts);
  renderEnv(facts);
  renderDisplays(facts);
  renderWindowsFacts(facts);

  if (!checkRefs.size) buildChecks(state.checks);
  updateChecks(state.checks);

  syncCardButtons(cardState);

  document.getElementById('raw').textContent = JSON.stringify(
    { facts, cardState, summary: state.summary },
    null,
    2,
  );

  return { state, facts, cardState };
}

function renderChips(summary) {
  const host = document.getElementById('chips');
  clear(host);
  for (const [key, cls] of [
    ['pass', 'pass'],
    ['fail', 'fail'],
    ['warn', 'warn'],
    ['unable', 'unable'],
    ['pending', 'pending'],
  ]) {
    const n = summary[key] || 0;
    host.appendChild(el('span', `chip chip--${cls}`, `${STATUS_TEXT[key]} ${n}`));
  }
}

function syncCardButtons(cardState) {
  if (!cardState) return;
  const surf = cardState.surface;
  document.getElementById('btn-glass').classList.toggle('is-on', surf === 'glass');
  document.getElementById('btn-opaque').classList.toggle('is-on', surf === 'opaque');

  for (const id of ['quiet', 'normal', 'sheer']) {
    document.getElementById('op-' + id).classList.toggle('is-on', cardState.opacity === id);
  }

  const st = cardState.cardState;
  document.getElementById('btn-collapse').classList.toggle('is-on', st === 'collapsed');
  document.getElementById('btn-expand').classList.toggle('is-on', st === 'expanded');
  document.getElementById('btn-hide').classList.toggle('is-on', st === 'hidden');
}

/* ------------------------------------------------------------------ */
/* 动作的可见反馈                                                        */
/* ------------------------------------------------------------------ */

/**
 * 把按钮文字临时换成结果，ms 毫秒后恢复原文字。
 *
 * 为什么需要它（2026-09-20）：控制台上的「重新探测」与「坐标往返测试」
 * **不是死键** —— 两者都有真实绑定。但它们的可见变化太弱：数据没变时
 * 整个页面看起来一模一样，用户感知就是"点了没反应"。
 *
 * ⚠️ 这与卡片上「刷新 / 设置」那种"绑了个只写日志的空壳"是**两回事**，
 *    排查记录里要分开记，别混成同一类缺陷。
 */
const flashTimers = new Map();

function flash(id, text, ms = 1800) {
  const btn = document.getElementById(id);
  if (!btn) return;
  if (flashTimers.has(id)) clearTimeout(flashTimers.get(id));
  if (btn.dataset.label === undefined) btn.dataset.label = btn.textContent;
  btn.textContent = text;
  flashTimers.set(
    id,
    setTimeout(() => {
      btn.textContent = btn.dataset.label;
      flashTimers.delete(id);
    }, ms),
  );
}

let bound = false;

function bind() {
  if (bound) return;
  bound = true;
  const wrap = (id, fn) => {
    const n = document.getElementById(id);
    if (n) n.addEventListener('click', fn);
  };

  wrap('btn-collapse', async () => { await api.card.setState('collapsed'); await refresh(); });
  wrap('btn-expand', async () => { await api.card.setState('expanded'); await refresh(); });
  wrap('btn-hide', async () => { await api.card.setVisible(false); await refresh(); });
  wrap('btn-show', async () => { await api.card.setVisible(true); await refresh(); });

  wrap('btn-glass', async () => { await api.card.setSurface('glass'); await refresh(); });
  wrap('btn-opaque', async () => { await api.card.setSurface('opaque'); await refresh(); });

  let diagOn = false;
  wrap('btn-diag', async () => {
    diagOn = !diagOn;
    document.getElementById('btn-diag').classList.toggle('is-on', diagOn);
    await api.card.setDiag(diagOn);
    await api.card.setState('expanded');
    await refresh();
  });

  wrap('op-quiet', async () => { await api.card.setOpacity('quiet'); await refresh(); });
  wrap('op-normal', async () => { await api.card.setOpacity('normal'); await refresh(); });
  wrap('op-sheer', async () => { await api.card.setOpacity('sheer'); await refresh(); });

  wrap('btn-snap', async () => { await api.card.snap(); await refresh(); });

  // 往返测试的结论藏在返回值的 deviation 里 —— 必须显式说出来。
  // 它真实的行为只是往验收 6/8 的证据列表里追加两行，位置很隐蔽，等于白跑。
  wrap('btn-record', async () => {
    const r = await api.card.recordPos();
    await refresh();
    const d = r && r.roundtrip ? r.roundtrip.deviation : null;
    const worst = d
      ? Math.max(Math.abs(d.dx), Math.abs(d.dy), Math.abs(d.dw), Math.abs(d.dh))
      : null;
    flash('btn-record', worst === null ? '无读数' : '最大偏差 ' + worst + 'px');
  });

  wrap('btn-focus', async () => { await api.focusTest.start(20000); });
  wrap('btn-export', async () => {
    const r = await api.probe.exportReport();
    flash('btn-export', '已导出：' + (r.file || '').split('\\').pop(), 4000);
  });

  // 「重新探测」本身就是一次全量 refresh —— 但数据没变时页面纹丝不动。
  // 把"刷过了 + 花了多久"说出来，点下去才有回音。
  wrap('btn-reload', async () => {
    const t0 = performance.now();
    await refresh();
    flash('btn-reload', '已刷新 · ' + Math.round(performance.now() - t0) + 'ms');
  });
}

api.probe.onState((s) => {
  if (!s) return;
  renderChips(s.summary);
  if (!checkRefs.size) buildChecks(s.checks);
  updateChecks(s.checks);
});

api.focusTest.onState((s) => renderFocus(s));

api.card.onStateChanged((s) => syncCardButtons(s));

window.addEventListener('DOMContentLoaded', async () => {
  bind();
  await refresh();
  // 渲染进程上报 devicePixelRatio 有延迟，1.5 秒后再刷一次以拿到它
  setTimeout(refresh, 1500);
});

if (document.readyState !== 'loading') {
  bind();
  refresh();
}
