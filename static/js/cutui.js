/* 裁切工序演练面板：逐刀播放、前后切换、步骤排序、候选切法切换、
   画布 SVG 高亮（当前子板 / 切线 / 新产生板块 / 阻塞区域）、人工处理项。 */
const CutUI = {
  playTimer: null,

  init() {
    document.getElementById('cp-close').addEventListener('click', () => this.toggle());
    document.getElementById('cp-first').addEventListener('click', () => this.setCursor(0));
    document.getElementById('cp-prev').addEventListener('click', () => this.stepBy(-1));
    document.getElementById('cp-play').addEventListener('click', () => this.play());
    document.getElementById('cp-next').addEventListener('click', () => this.stepBy(1));
    document.getElementById('cp-last').addEventListener('click', () => this.setCursor(1e9));
    const slider = document.getElementById('cp-slider');
    slider.addEventListener('input', () => this.setCursor(+slider.value));
  },

  toggle() {
    App.cutOpen = !App.cutOpen;
    if (!App.cutOpen) this.stopPlay();
    renderAll();
  },

  /* renderAll 钩子：面板打开时让工序与当前排样保持同步 */
  refresh() {
    document.getElementById('btn-cutplan').classList.toggle('on', App.cutOpen);
    if (!App.cutOpen) return;
    CutPlan.ensure();
    this.renderPanel();
    this.renderOverlay();
  },

  /* 当前板下标 / 计划 / 顺序 / 游标（钳制在有效范围） */
  cur() {
    if (!App.cutplan || !App.cutplanData) return null;
    const n = App.cutplanData.plans.length;
    App.cutplan.activeSheet = Math.max(0, Math.min(App.cutplan.activeSheet, n - 1));
    const idx = App.cutplan.activeSheet;
    const plan = App.cutplanData.plans[idx];
    const order = CutPlan.orderFor(idx);
    const key = String(idx);
    const cursor = Math.max(0, Math.min(order.length, App.cutplan.cursors[key] || 0));
    App.cutplan.cursors[key] = cursor;
    return { idx, plan, order, cursor, key };
  },

  setCursor(n) {
    const c = this.cur();
    if (!c) return;
    App.cutplan.cursors[c.key] = Math.max(0, Math.min(c.order.length, n));
    this.renderPanel();
    this.renderOverlay();
  },
  stepBy(d) {
    const c = this.cur();
    if (!c) return;
    this.setCursor(c.cursor + d);
  },
  play() {
    if (this.playTimer) { this.stopPlay(); return; }
    const c = this.cur();
    if (!c) return;
    if (c.cursor >= c.order.length) this.setCursor(0);  // 已播完则从头再来
    this.playTimer = setInterval(() => {
      const cc = this.cur();
      if (!cc || cc.cursor >= cc.order.length) { this.stopPlay(); return; }
      this.stepBy(1);
    }, 900);
    this.renderPanel();
  },
  stopPlay() {
    if (this.playTimer) { clearInterval(this.playTimer); this.playTimer = null; }
    const b = document.getElementById('cp-play');
    if (b) b.textContent = '▶';
  },

  /* ---- 标签/文本 ---- */
  dirLabel(s) {
    return (s.dir === 'v' ? '竖切' : '横切') + (s.trim ? `·修${s.wasteSide}` : '');
  },
  candLabel(cd) {
    return (cd.dir === 'v' ? '竖' : '横') + ' ' + fmtNum(cd.at) + (cd.trim ? '·修' : '');
  },
  prodLabel(p) {
    if (p.kind === 'part') return `✔ 零件 ${p.uid}`;
    if (p.kind === 'remnant') return `余料 ${fmtNum(p.board.w)}×${fmtNum(p.board.h)}`;
    if (p.kind === 'blocked') return `⚠ 阻塞区（${p.parts} 件→人工）`;
    return `半成品 ${fmtNum(p.board.w)}×${fmtNum(p.board.h)}（${p.parts} 件）`;
  },

  /* ---- 面板渲染 ---- */
  renderPanel() {
    const panel = document.getElementById('cutpanel');
    if (!App.cutOpen) { panel.classList.add('hidden'); return; }
    panel.classList.remove('hidden');
    const lay = App.layout();
    const tabsEl = document.getElementById('cp-sheet-tabs');
    const noteEl = document.getElementById('cp-note');
    const statsEl = document.getElementById('cp-stats');
    const curEl = document.getElementById('cp-current');
    const manEl = document.getElementById('cp-manual');
    const remEl = document.getElementById('cp-remnants');
    const tbody = document.querySelector('#cp-steps tbody');
    document.getElementById('cp-play').textContent = this.playTimer ? '⏸' : '▶';

    if (!lay || !App.cutplanData) {
      tabsEl.innerHTML = '';
      noteEl.textContent = '';
      statsEl.innerHTML = '<span class="hint">请先生成排样方案，系统将把排样拆成贯通切割工序。</span>';
      curEl.innerHTML = '';
      manEl.innerHTML = '';
      remEl.innerHTML = '';
      tbody.innerHTML = '';
      document.getElementById('cp-pos').textContent = '0 / 0 刀';
      document.getElementById('cp-slider').max = 0;
      document.getElementById('cp-slider').value = 0;
      return;
    }
    const c = this.cur();
    const st = App.cutplan;
    const plan = c.plan;

    // 板材标签
    tabsEl.innerHTML = '';
    lay.sheets.forEach((si, i) => {
      const p = App.cutplanData.plans[i];
      const b = document.createElement('button');
      b.className = 'cp-sheet-tab' + (i === c.idx ? ' active' : '');
      const manual = p.manual.length ? ` · ⚠${p.manual.length}` : '';
      b.innerHTML = si.placements.length
        ? `#${i + 1} ${esc(si.name || si.sheetId)} <span class="s">${p.steps.length}刀${manual}</span>`
        : `#${i + 1} ${esc(si.name || si.sheetId)} <span class="s">空板</span>`;
      b.addEventListener('click', () => {
        st.activeSheet = i;
        this.stopPlay();
        this.renderPanel();
        this.renderOverlay();
      });
      tabsEl.appendChild(b);
    });
    noteEl.textContent = st.note || '';

    // 统计：本板 + 全部板材合计
    const stats = CutPlan.statsFor(c.idx);
    let totCuts = 0, totFlips = 0, totReuse = 0, totManual = 0;
    lay.sheets.forEach((_, i) => {
      const s = CutPlan.statsFor(i);
      totCuts += s.cuts; totFlips += s.flips;
      totReuse += s.reusableArea; totManual += s.manualCount;
    });
    statsEl.innerHTML =
      `<b>本板</b>：${stats.cuts} 刀 · 翻板 ${stats.flips} 次 · ` +
      `余料 ${stats.remnants} 块（可复用 ${stats.reusableCount} 块 / ${fmtArea(stats.reusableArea)}）· ` +
      `锯缝损耗 ${fmtArea(stats.kerfLoss)}` +
      (stats.manualCount ? ` · <span class="bad">人工 ${stats.manualCount} 项 / ${stats.manualParts} 件</span>` : '') +
      `<br><span class="hint">全部板材：${totCuts} 刀 · 翻板 ${totFlips} 次 · ` +
      `可复用余料 ${fmtArea(totReuse)}${totManual ? ` · 人工 ${totManual} 项` : ''} · ` +
      `翻板 = 相邻两刀方向变化次数 · 可复用余料：短边 ≥ ${CutPlan.REUSE_MIN}mm</span>`;

    // 播放控件状态
    const byId = {};
    plan.steps.forEach(s => { byId[s.id] = s; });
    const slider = document.getElementById('cp-slider');
    slider.max = c.order.length;
    slider.value = c.cursor;
    document.getElementById('cp-pos').textContent = `${c.cursor} / ${c.order.length} 刀`;

    // 当前步骤详情 + 候选切法
    if (!plan.steps.length) {
      curEl.innerHTML = plan.blocked.length
        ? '<span class="bad">整板无法贯通裁切，全部归入人工处理。</span>'
        : '<span class="hint">该板无需裁切。</span>';
    } else if (c.cursor >= c.order.length) {
      curEl.innerHTML = '<span class="ok">✔ 全部切刀已演练完成。</span>';
    } else {
      const s = byId[c.order[c.cursor]];
      const outs = s.produces.map(p => this.prodLabel(p)).join(' ＋ ');
      curEl.innerHTML =
        `<b>第 ${c.cursor + 1} 刀</b>：${this.dirLabel(s)} ` +
        `${s.dir === 'v' ? 'x' : 'y'} = ${fmtNum(s.at)}（锯缝 ${fmtNum(plan.kerf)}mm）<br>` +
        `<span class="hint">切前子板 ${fmtNum(s.board.w)}×${fmtNum(s.board.h)} ` +
        `@ (${fmtNum(s.board.x)}, ${fmtNum(s.board.y)})</span><br>` +
        `产出：${esc(outs)}` +
        (s.cands.length > 1 ? '<div class="cp-cands"><span class="hint">候选切法：</span></div>' : '');
      const box = curEl.querySelector('.cp-cands');
      if (box) {
        s.cands.forEach((cd, ci) => {
          const b = document.createElement('button');
          b.className = 'cp-cand' + (ci === s.candIndex ? ' active' : '');
          b.textContent = this.candLabel(cd);
          b.title = '切换该子板的切法（后续工序将重新分析）';
          b.addEventListener('click', () => {
            CutPlan.setCandidate(c.idx, s.nodeKey, ci);
            this.renderPanel();
            this.renderOverlay();
          });
          box.appendChild(b);
        });
      }
    }

    // 步骤表
    tbody.innerHTML = '';
    c.order.forEach((sid, i) => {
      const s = byId[sid];
      if (!s) return;
      const tr = document.createElement('tr');
      tr.className = i < c.cursor ? 'cp-done' : (i === c.cursor ? 'cp-current' : '');
      const outs = s.produces.map(p => this.prodLabel(p)).join('＋');
      tr.innerHTML =
        `<td>${i + 1}</td>` +
        `<td>${this.dirLabel(s)}</td>` +
        `<td>${s.dir === 'v' ? 'x' : 'y'}=${fmtNum(s.at)}</td>` +
        `<td>${fmtNum(s.board.w)}×${fmtNum(s.board.h)}</td>` +
        `<td class="cp-out">${esc(outs)}</td>` +
        `<td class="ops"></td>`;
      tr.title = '点击定位到该刀';
      tr.addEventListener('click', (e) => {
        if (e.target.closest('button')) return;
        this.setCursor(i);
      });
      const ops = tr.querySelector('.ops');
      if (s.candCount > 1) {
        const cb = document.createElement('button');
        cb.className = 'cp-op';
        cb.textContent = `⇄${s.candIndex + 1}/${s.candCount}`;
        cb.title = '切换候选切法';
        cb.addEventListener('click', () => {
          CutPlan.setCandidate(c.idx, s.nodeKey, (s.candIndex + 1) % s.candCount);
          this.renderPanel();
          this.renderOverlay();
        });
        ops.appendChild(cb);
      }
      const up = document.createElement('button');
      up.className = 'cp-op';
      up.textContent = '↑';
      up.title = '上移一刀（依赖允许时）';
      up.disabled = !CutPlan.canSwap(c.idx, i - 1);
      up.addEventListener('click', () => {
        CutPlan.swap(c.idx, i - 1);
        this.renderPanel();
        this.renderOverlay();
      });
      const dn = document.createElement('button');
      dn.className = 'cp-op';
      dn.textContent = '↓';
      dn.title = '下移一刀（依赖允许时）';
      dn.disabled = !CutPlan.canSwap(c.idx, i);
      dn.addEventListener('click', () => {
        CutPlan.swap(c.idx, i);
        this.renderPanel();
        this.renderOverlay();
      });
      ops.appendChild(up);
      ops.appendChild(dn);
      tbody.appendChild(tr);
    });

    // 人工处理项
    if (plan.manual.length) {
      manEl.innerHTML = '<h3>⚠ 人工处理（无法贯通裁切）</h3>' +
        plan.manual.map((m) =>
          `<div class="cp-manual-item"><b>${esc(m.text)}</b><br>` +
          `<span class="hint">${esc(m.reason)}</span><br>` +
          `<span class="cp-uids">${m.uids.map(u =>
            `<a data-uid="${esc(u)}">${esc(u)}</a>`).join('、')}</span></div>`).join('');
      manEl.querySelectorAll('a[data-uid]').forEach(a => {
        a.addEventListener('click', () => {
          App.selected = a.dataset.uid;
          renderAll();
        });
      });
    } else {
      manEl.innerHTML = '';
    }

    // 余料汇总
    if (plan.remnants.length) {
      remEl.innerHTML = '<h3>余料</h3><div class="cp-remnants">' +
        plan.remnants.map(r =>
          `<span class="cp-remnant${r.reusable ? ' ok' : ''}">` +
          `${fmtNum(r.w)}×${fmtNum(r.h)}${r.reusable ? ' ♻' : ''}</span>`).join('') +
        '</div>';
    } else {
      remEl.innerHTML = '';
    }
  },

  /* ---- 画布高亮层 ---- */
  renderOverlay() {
    if (!App.cutOpen || !App.cutplanData) return;
    const lay = App.layout();
    if (!lay) return;
    const c = this.cur();
    if (!c) return;
    const off = Canvas.sheetOffsets[c.idx];
    if (!off) return;
    const plan = c.plan;
    const NS = Canvas.NS;
    const g = document.createElementNS(NS, 'g');
    g.setAttribute('class', 'cut-overlay');
    g.setAttribute('transform', `translate(${off.x}, ${off.y})`);
    g.setAttribute('pointer-events', 'none');
    Canvas.svg.appendChild(g);
    const mk = (tag, attrs) => {
      const n = document.createElementNS(NS, tag);
      for (const k in attrs) n.setAttribute(k, attrs[k]);
      g.appendChild(n);
      return n;
    };
    const byId = {};
    plan.steps.forEach(s => { byId[s.id] = s; });
    const fs = Math.max(off.w, off.h) / 50;

    const drawCut = (s, cls) => {
      if (s.dir === 'v') {
        mk('line', { class: cls, x1: s.at, y1: s.board.y, x2: s.at, y2: s.board.y + s.board.h });
      } else {
        mk('line', { class: cls, x1: s.board.x, y1: s.at, x2: s.board.x + s.board.w, y2: s.at });
      }
    };

    // 已执行的切线（淡）与已产出的零件 / 余料
    for (let i = 0; i < c.cursor && i < c.order.length; i++) {
      const s = byId[c.order[i]];
      if (!s) continue;
      drawCut(s, 'cut-done');
      s.produces.forEach(pr => {
        if (pr.kind === 'part') {
          mk('rect', { class: 'cut-part-done', x: pr.board.x, y: pr.board.y, width: pr.board.w, height: pr.board.h });
        }
      });
    }

    // 阻塞区域（始终标出）
    plan.blocked.forEach(b => {
      mk('rect', { class: 'cut-blocked', x: b.board.x, y: b.board.y, width: b.board.w, height: b.board.h });
      const t = mk('text', {
        class: 'cut-label', x: b.board.x + b.board.w / 2, y: b.board.y + b.board.h / 2,
        'font-size': fs * 0.5, 'text-anchor': 'middle', fill: '#c62828',
      });
      t.textContent = `⚠ 阻塞区：${b.uids.length} 件需人工处理`;
    });

    // 当前步骤：高亮子板、锯缝带、切线与新产生的板块
    if (c.cursor < c.order.length) {
      const s = byId[c.order[c.cursor]];
      if (!s) return;
      mk('rect', { class: 'cut-current-board', x: s.board.x, y: s.board.y, width: s.board.w, height: s.board.h });
      // 锯缝带（钳制在子板内）
      if (plan.kerf > 0) {
        if (s.dir === 'v') {
          const bx = Math.max(s.at, s.board.x);
          const bw = Math.min(s.at + plan.kerf, s.board.x + s.board.w) - bx;
          if (bw > 0) mk('rect', { class: 'cut-blade', x: bx, y: s.board.y, width: bw, height: s.board.h });
        } else {
          const by = Math.max(s.at, s.board.y);
          const bh = Math.min(s.at + plan.kerf, s.board.y + s.board.h) - by;
          if (bh > 0) mk('rect', { class: 'cut-blade', x: s.board.x, y: by, width: s.board.w, height: bh });
        }
      }
      drawCut(s, 'cut-current-line');
      s.produces.forEach(pr => {
        mk('rect', { class: 'cut-produce kind-' + pr.kind, x: pr.board.x, y: pr.board.y, width: pr.board.w, height: pr.board.h });
        if (Math.min(pr.board.w, pr.board.h) > fs * 0.8) {
          const t = mk('text', {
            class: 'cut-label', x: pr.board.x + pr.board.w / 2, y: pr.board.y + pr.board.h / 2,
            'font-size': fs * 0.45, 'text-anchor': 'middle',
          });
          t.textContent = pr.kind === 'part' ? `✔ 零件 ${pr.uid}`
            : pr.kind === 'remnant' ? '余料'
            : pr.kind === 'blocked' ? '人工' : `${pr.parts} 件`;
        }
      });
    }
  },
};
