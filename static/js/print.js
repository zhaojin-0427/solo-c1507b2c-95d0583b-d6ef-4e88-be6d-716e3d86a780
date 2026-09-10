/* 打印视图：生成独立窗口，含尺寸标注、裁切工序（已选切法与当前步骤顺序）、
   人工处理项与零件清单。切线不再另行推导，直接采用 CutPlan 的分析结果。 */
const Print = {

  open() {
    const lay = App.layout();
    if (!lay) { toast('请先生成排样方案'); return; }
    const win = window.open('', '_blank');
    if (!win) { toast('浏览器拦截了弹出窗口，请允许后重试'); return; }
    win.document.open();
    win.document.write(this.buildHtml(lay));
    win.document.close();
  },

  /* 当前工序步骤（已选候选切法 + 用户调整后的顺序）；无 CutPlan 时返回 [] */
  planSteps(plan, sheetIdx) {
    if (!plan) return [];
    const order = CutPlan.orderFor(sheetIdx);
    const byId = {};
    plan.steps.forEach(s => { byId[s.id] = s; });
    return order.map(id => byId[id]).filter(Boolean);
  },

  stepTypeLabel(s) {
    return (s.dir === 'v' ? '竖切' : '横切') + (s.trim ? `（修边·${s.wasteSide}）` : '');
  },

  producesLabel(s) {
    return s.produces.map(p => {
      if (p.kind === 'part') return `零件 ${p.uid}`;
      if (p.kind === 'remnant') return `余料 ${fmtNum(p.board.w)}×${fmtNum(p.board.h)}`;
      if (p.kind === 'blocked') return `阻塞区（${p.parts} 件→人工）`;
      return `半成品 ${fmtNum(p.board.w)}×${fmtNum(p.board.h)}（${p.parts} 件）`;
    }).join(' ＋ ');
  },

  sheetSvg(si, idx, plan) {
    const def = App.sheetDef(si.sheetId) || si;
    const W = +def.width, H = +def.height;
    const m = Validate.margin();
    const pad = 90;
    const parts = si.placements.map(p => ({ ...p }));
    // 零件编号：按从上到下、从左到右的阅读顺序
    parts.sort((a, b) => (a.y - b.y) || (a.x - b.x));
    parts.forEach((p, i) => { p.no = i + 1; });

    const steps = this.planSteps(plan, idx);
    const fs = Math.max(W, H) / 55;  // 随板尺寸缩放的字体

    let s = '';
    // 板材外形与留边
    s += `<rect x="0" y="0" width="${W}" height="${H}" fill="#faf6ec" stroke="#333" stroke-width="${fs * 0.12}"/>`;
    if (m > 0) s += `<rect x="${m}" y="${m}" width="${W - 2 * m}" height="${H - 2 * m}" fill="none" stroke="#999" stroke-width="${fs * 0.06}" stroke-dasharray="${fs * 0.4} ${fs * 0.25}"/>`;

    // 尺寸标注：顶边宽、左边高
    s += this.dimLine(0, -pad * 0.45, W, -pad * 0.45, `${fmtNum(W)}`, fs, 'h');
    s += this.dimLine(-pad * 0.45, 0, -pad * 0.45, H, `${fmtNum(H)}`, fs, 'v');

    // 阻塞区域（人工处理）：红色斜线框
    (plan ? plan.blocked : []).forEach((b) => {
      s += `<rect x="${b.board.x}" y="${b.board.y}" width="${b.board.w}" height="${b.board.h}" fill="#c62828" fill-opacity="0.08" stroke="#c62828" stroke-width="${fs * 0.1}" stroke-dasharray="${fs * 0.4} ${fs * 0.25}"/>`;
      s += `<text x="${b.board.x + b.board.w / 2}" y="${b.board.y + b.board.h / 2}" font-size="${fs * 0.55}" fill="#c62828" text-anchor="middle" font-weight="bold">人工处理区（${b.uids.length} 件）</text>`;
    });

    // 切割线（蓝色虚线 + 顺序圆标）：按工序当前顺序编号，线段为各自切前子板范围
    steps.forEach((st, i) => {
      const x1 = st.dir === 'v' ? st.at : st.board.x;
      const y1 = st.dir === 'v' ? st.board.y : st.at;
      const x2 = st.dir === 'v' ? st.at : st.board.x + st.board.w;
      const y2 = st.dir === 'v' ? st.board.y + st.board.h : st.at;
      s += `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="#1565c0" stroke-width="${fs * 0.1}" stroke-dasharray="${fs * 0.5} ${fs * 0.3}"/>`;
      const mx = (x1 + x2) / 2, my = (y1 + y2) / 2;
      s += `<circle cx="${mx}" cy="${my}" r="${fs * 0.62}" fill="#1565c0"/>` +
           `<text x="${mx}" y="${my + fs * 0.28}" font-size="${fs * 0.75}" fill="#fff" text-anchor="middle" font-weight="bold">${i + 1}</text>`;
    });

    // 零件
    parts.forEach((p) => {
      s += `<rect x="${p.x}" y="${p.y}" width="${p.w}" height="${p.h}" fill="${colorFor(p.partId)}" fill-opacity="0.55" stroke="#333" stroke-width="${fs * 0.08}"/>`;
      // 编号圆
      s += `<circle cx="${p.x + fs * 0.7}" cy="${p.y + fs * 0.7}" r="${fs * 0.5}" fill="#333"/>` +
           `<text x="${p.x + fs * 0.7}" y="${p.y + fs * 0.92}" font-size="${fs * 0.6}" fill="#fff" text-anchor="middle">${p.no}</text>`;
      if (Math.min(p.w, p.h) > fs * 2.2) {
        const name = esc(p.name || p.partId);
        s += `<text x="${p.x + p.w / 2}" y="${p.y + p.h / 2}" font-size="${fs * 0.7}" text-anchor="middle" fill="#222">${name}</text>`;
        s += `<text x="${p.x + p.w / 2}" y="${p.y + p.h / 2 + fs * 0.85}" font-size="${fs * 0.6}" text-anchor="middle" fill="#444">${fmtNum(p.w)}×${fmtNum(p.h)}${p.rotated ? ' ⟳' : ''}</text>`;
      }
    });

    return { svg: `<svg viewBox="${-pad} ${-pad} ${W + pad * 2} ${H + pad * 2}" xmlns="http://www.w3.org/2000/svg">${s}</svg>`,
             parts, steps, def, W, H };
  },

  dimLine(x1, y1, x2, y2, text, fs, dir) {
    // 简单尺寸线：线 + 端点短tick + 文字
    const tick = fs * 0.35;
    let s = `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="#555" stroke-width="${fs * 0.07}"/>`;
    if (dir === 'h') {
      s += `<line x1="${x1}" y1="${y1 - tick}" x2="${x1}" y2="${y1 + tick}" stroke="#555" stroke-width="${fs * 0.07}"/>`;
      s += `<line x1="${x2}" y1="${y2 - tick}" x2="${x2}" y2="${y2 + tick}" stroke="#555" stroke-width="${fs * 0.07}"/>`;
      s += `<text x="${(x1 + x2) / 2}" y="${y1 - fs * 0.15}" font-size="${fs * 0.7}" text-anchor="middle" fill="#333">${text}</text>`;
    } else {
      s += `<line x1="${x1 - tick}" y1="${y1}" x2="${x1 + tick}" y2="${y1}" stroke="#555" stroke-width="${fs * 0.07}"/>`;
      s += `<line x1="${x2 - tick}" y1="${y2}" x2="${x2 + tick}" y2="${y2}" stroke="#555" stroke-width="${fs * 0.07}"/>`;
      s += `<text x="${x1 - fs * 0.2}" y="${(y1 + y2) / 2}" font-size="${fs * 0.7}" text-anchor="middle" fill="#333" transform="rotate(-90 ${x1 - fs * 0.2} ${(y1 + y2) / 2})">${text}</text>`;
    }
    return s;
  },

  buildHtml(lay) {
    const st = lay.stats;
    const name = esc(document.getElementById('project-name').value || '未命名项目');
    const sett = App.settings;
    const now = new Date().toLocaleString();
    // 采用项目当前已选的裁切工序（候选切法 + 步骤顺序）
    const cutData = (typeof CutPlan !== 'undefined') ? CutPlan.ensure() : null;
    let totCuts = 0, totFlips = 0, totReuse = 0, totManual = 0;
    if (cutData) {
      lay.sheets.forEach((_, i) => {
        const s = CutPlan.statsFor(i);
        if (!s) return;
        totCuts += s.cuts; totFlips += s.flips;
        totReuse += s.reusableArea; totManual += s.manualCount;
      });
    }
    let body = `
      <h1>${name} — 裁切排样图</h1>
      <p class="meta">生成时间：${now} · 锯缝 ${fmtNum(sett.kerf)}mm · 板边留量 ${fmtNum(sett.margin)}mm · 零件间距 ${fmtNum(sett.spacing)}mm</p>
      <p class="meta">利用率 ${fmtPct(st.utilization)} · 废料 ${fmtArea(st.waste)} · 约 ${st.cuts} 刀（估算）· 用板 ${st.usedSheets}/${st.totalSheets} 张 · 已放置 ${st.placedCount} 件 / 未放置 ${st.unplacedCount} 件</p>`;
    if (cutData) {
      body += `
      <p class="meta">裁切工序：共 ${totCuts} 刀 · 翻板 ${totFlips} 次 · 可复用余料 ${fmtArea(totReuse)}${totManual ? ` · <b style="color:#c62828">人工处理 ${totManual} 项</b>` : ''}</p>`;
    }

    lay.sheets.forEach((si, idx) => {
      if (!si.placements.length) return;
      const plan = cutData ? cutData.plans[idx] : null;
      const r = this.sheetSvg(si, idx, plan);
      const cutRows = r.steps.map((s, i) =>
        `<tr><td>${i + 1}</td><td>${this.stepTypeLabel(s)}</td>` +
        `<td>${s.dir === 'v' ? 'x' : 'y'} = ${fmtNum(s.at)}</td>` +
        `<td>${fmtNum(s.board.w)} × ${fmtNum(s.board.h)}</td>` +
        `<td>${fmtNum(s.dir === 'v' ? s.board.h : s.board.w)}</td>` +
        `<td>${esc(this.producesLabel(s))}</td></tr>`).join('');
      const partRows = r.parts.map(p =>
        `<tr><td>${p.no}</td><td>${esc(p.uid)}</td><td>${esc(p.name || p.partId)}</td>` +
        `<td>${fmtNum(p.w)} × ${fmtNum(p.h)}</td><td>(${fmtNum(p.x)}, ${fmtNum(p.y)})</td>` +
        `<td>${p.rotated ? '已旋转 90°' : '未旋转'}</td></tr>`).join('');
      let manualHtml = '';
      if (plan && plan.manual.length) {
        const rows = plan.manual.map(mn =>
          `<tr><td>${esc(mn.text)}</td><td>${esc(mn.uids.join('、'))}</td><td>${esc(mn.reason)}</td></tr>`).join('');
        manualHtml = `
          <h3 style="color:#c62828">⚠ 人工处理项（无法贯通裁切）</h3>
          <table><thead><tr><th>区域 / 说明</th><th>涉及零件</th><th>原因</th></tr></thead><tbody>${rows}</tbody></table>`;
      }
      body += `
        <section class="sheet-page">
          <h2>板材 #${idx + 1}：${esc(si.sheetId)} ${esc(si.name || '')}（${fmtNum(r.W)}×${fmtNum(r.H)} mm，${si.placements.length} 件）</h2>
          ${r.svg}
          <h3>裁切工序（切割顺序，图中蓝色编号即顺序）</h3>
          <table><thead><tr><th>顺序</th><th>类型</th><th>切线位置 (mm)</th><th>切前子板 (mm)</th><th>行程 (mm)</th><th>产出</th></tr></thead><tbody>${cutRows || '<tr><td colspan="6">—</td></tr>'}</tbody></table>
          ${manualHtml}
          <h3>零件清单（位置为板材左上角原点坐标）</h3>
          <table><thead><tr><th>编号</th><th>标识</th><th>名称</th><th>尺寸 (mm)</th><th>位置 (x, y)</th><th>方向</th></tr></thead><tbody>${partRows}</tbody></table>
        </section>`;
    });

    if (lay.unplaced.length) {
      const rows = lay.unplaced.map(u =>
        `<tr><td>${esc(u.uid)}</td><td>${esc(u.name || u.partId)}</td><td>${esc(u.reason || '')}</td></tr>`).join('');
      body += `<section class="sheet-page"><h2>未放置零件</h2>
        <table><thead><tr><th>标识</th><th>名称</th><th>原因</th></tr></thead><tbody>${rows}</tbody></table></section>`;
    }

    return `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8"><title>${name} — 排样打印</title>
<style>
  body { font-family: "PingFang SC", "Microsoft YaHei", sans-serif; margin: 16px; color: #222; font-size: 12px; }
  h1 { font-size: 20px; margin: 0 0 4px; }
  h2 { font-size: 15px; margin: 18px 0 6px; }
  h3 { font-size: 13px; margin: 10px 0 4px; }
  .meta { color: #555; margin: 2px 0; }
  svg { width: 100%; height: auto; border: 1px solid #ccc; background: #fff; }
  table { border-collapse: collapse; width: 100%; margin-bottom: 8px; }
  th, td { border: 1px solid #999; padding: 3px 6px; text-align: left; }
  th { background: #eee; }
  .sheet-page { page-break-after: always; }
  @page { size: A4 landscape; margin: 10mm; }
  @media print { body { margin: 0; } }
</style></head><body>${body}
<script>window.addEventListener('load', function(){ setTimeout(function(){ window.print(); }, 300); });</script>
</body></html>`;
  },
};
