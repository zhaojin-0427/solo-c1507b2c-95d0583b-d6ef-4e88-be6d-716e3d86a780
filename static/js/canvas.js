/* SVG 画布：渲染板材与零件，支持缩放、平移、拖拽、跨板移动 */
const Canvas = {
  svg: null,
  sheetOffsets: [],   // 每张板材在世界坐标中的 {x, y, w, h}
  SHEET_GAP: 150,     // 板材之间的世界间距 (mm)
  drag: null,
  pan: null,
  NS: 'http://www.w3.org/2000/svg',

  init() {
    this.svg = document.getElementById('canvas');
    this.svg.addEventListener('pointerdown', (e) => this.onPointerDown(e));
    window.addEventListener('pointermove', (e) => this.onPointerMove(e));
    window.addEventListener('pointerup', (e) => this.onPointerUp(e));
    this.svg.addEventListener('wheel', (e) => {
      e.preventDefault();
      this.zoomAt(e.clientX, e.clientY, e.deltaY > 0 ? 1.15 : 1 / 1.15);
    }, { passive: false });
    this.svg.addEventListener('contextmenu', (e) => e.preventDefault());
    this.svg.addEventListener('dblclick', (e) => {
      if (!App.defectMode || App.defectMode !== 'poly') return;
      const wpt = this.screenToWorld(e.clientX, e.clientY);
      const tIdx = this.sheetAt(wpt.x, wpt.y);
      if (tIdx < 0) return;
      const off = this.sheetOffsets[tIdx];
      if (typeof Defects !== 'undefined' &&
          Defects.onDoubleClick({ x: wpt.x - off.x, y: wpt.y - off.y })) e.preventDefault();
    });
    this.applyView();
  },

  el(tag, attrs, parent) {
    const n = document.createElementNS(this.NS, tag);
    for (const k in (attrs || {})) n.setAttribute(k, attrs[k]);
    if (parent) parent.appendChild(n);
    return n;
  },

  /* ---- 视口（缩放 / 平移） ---- */
  applyView() {
    const v = App.view;
    this.svg.setAttribute('viewBox', `${v.x} ${v.y} ${v.w} ${v.h}`);
    const label = document.getElementById('zoom-label');
    if (label) label.textContent = '缩放 ' + Math.round(this.zoomLevel() * 100) + '%';
  },
  zoomLevel() {
    const r = this.svg.getBoundingClientRect();
    return r.width ? r.width / App.view.w : 1;
  },
  screenToWorld(cx, cy) {
    const r = this.svg.getBoundingClientRect();
    return {
      x: App.view.x + (cx - r.left) / r.width * App.view.w,
      y: App.view.y + (cy - r.top) / r.height * App.view.h,
    };
  },
  zoomAt(cx, cy, factor) {
    const r = this.svg.getBoundingClientRect();
    const wx = App.view.x + (cx - r.left) / r.width * App.view.w;
    const wy = App.view.y + (cy - r.top) / r.height * App.view.h;
    let nw = App.view.w * factor;
    nw = Math.max(200, Math.min(30000, nw));
    const realFactor = nw / App.view.w;
    App.view.w = nw;
    App.view.h = App.view.h * realFactor;
    App.view.x = wx - (cx - r.left) / r.width * App.view.w;
    App.view.y = wy - (cy - r.top) / r.height * App.view.h;
    this.applyView();
  },
  zoomFit() {
    if (!this.sheetOffsets.length) return;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const o of this.sheetOffsets) {
      x0 = Math.min(x0, o.x); y0 = Math.min(y0, o.y);
      x1 = Math.max(x1, o.x + o.w); y1 = Math.max(y1, o.y + o.h);
    }
    const pad = 120;
    const r = this.svg.getBoundingClientRect();
    let w = x1 - x0 + pad * 2, h = y1 - y0 + pad * 2;
    if (w / h > r.width / r.height) h = w * r.height / r.width;
    else w = h * r.width / r.height;
    App.view.w = w; App.view.h = h;
    App.view.x = x0 - pad; App.view.y = y0 - pad;
    this.applyView();
  },

  /* ---- 渲染 ---- */
  render() {
    this.svg.replaceChildren();
    this.sheetOffsets = [];
    const lay = App.layout();
    if (!lay) return;

    // 计算每张板材的世界位置（水平居中、垂直排列）
    let maxW = 0;
    lay.sheets.forEach((si) => {
      const def = App.sheetDef(si.sheetId) || si;
      maxW = Math.max(maxW, +def.width);
    });
    let y = 0;
    lay.sheets.forEach((si) => {
      const def = App.sheetDef(si.sheetId) || si;
      const w = +def.width, h = +def.height;
      this.sheetOffsets.push({ x: (maxW - w) / 2, y, w, h });
      y += h + this.SHEET_GAP;
    });

    lay.sheets.forEach((si, idx) => this.renderSheet(si, idx));
  },

  renderSheet(si, idx) {
    const off = this.sheetOffsets[idx];
    const def = App.sheetDef(si.sheetId) || si;
    const margin = Validate.margin();
    const g = this.el('g', { class: 'sheet', 'data-idx': idx, transform: `translate(${off.x}, ${off.y})` }, this.svg);

    this.el('rect', { class: 'sheet-bg', width: off.w, height: off.h, rx: 2 }, g);
    // 板边留量区域
    if (margin > 0) {
      this.el('rect', {
        class: 'sheet-margin', x: margin, y: margin,
        width: Math.max(0, off.w - 2 * margin), height: Math.max(0, off.h - 2 * margin),
      }, g);
    }
    // 纹理相位参照线（原料板记录了重复周期时）
    this.renderPhaseGrid(g, si, off, def);
    // 板材纹理方向示意
    if (def.grain && def.grain !== 'none') {
      const step = 90;
      if (def.grain === 'horizontal') {
        for (let gy = step; gy < off.h; gy += step)
          this.el('line', { class: 'grain-line', x1: 10, y1: gy, x2: off.w - 10, y2: gy }, g);
      } else {
        for (let gx = step; gx < off.w; gx += step)
          this.el('line', { class: 'grain-line', x1: gx, y1: 10, x2: gx, y2: off.h - 10 }, g);
      }
    }
    // 标题与利用率
    const used = si.placements.reduce((s, p) => s + p.w * p.h, 0);
    const util = off.w * off.h ? used / (off.w * off.h) : 0;
    const label = this.el('text', { class: 'sheet-label', x: 0, y: -46 }, g);
    label.textContent = `${si.sheetId} ${def.name || ''} #${si.instance + 1}`;
    const sub = this.el('text', { class: 'sheet-sub', x: 0, y: -14 }, g);
    const period = +(si.grainPeriod != null ? si.grainPeriod : def.grainPeriod) || 0;
    sub.textContent = `${fmtNum(off.w)}×${fmtNum(off.h)} mm · ${si.placements.length} 件 · 利用率 ${fmtPct(util)}` +
      (period ? ` · 纹理周期 ${fmtNum(period)}mm` : '');

    si.placements.forEach((p) => this.renderPart(g, p));
    // 拼纹接缝层（相位错花量，超限红色高亮）
    this.renderSeamOverlay(g, si, idx);
    // 板面缺陷（核心区 + 安全外扩边界 + 编号）覆盖在零件之上
    if (typeof Defects !== 'undefined') Defects.renderInto(g, si, idx);
  },

  /* 纹理相位参照线：垂直于纹理方向、按重复周期从基点起铺的细线 */
  renderPhaseGrid(sheetG, si, off, def) {
    const period = +(si.grainPeriod != null ? si.grainPeriod : def.grainPeriod) || 0;
    if (!(period > 0)) return;
    const gb = si.grainBase || def.grainBase || { x: 0, y: 0 };
    const bx = +gb.x || 0, by = +gb.y || 0;
    const grain = si.grain || def.grain || 'none';
    const layer = this.el('g', { class: 'phase-layer' }, sheetG);
    if (grain === 'vertical') {
      // 纹理沿 y：相位线为竖线（沿纹理），按 x 周期
      for (let x = bx % period; x <= off.w + 1; x += period) {
        this.el('line', { class: 'phase-line', x1: x, y1: 0, x2: x, y2: off.h }, layer);
      }
    } else if (grain === 'horizontal') {
      for (let y = by % period; y <= off.h + 1; y += period) {
        this.el('line', { class: 'phase-line', x1: 0, y1: y, x2: off.w, y2: y }, layer);
      }
    } else {
      // 无纹理方向但记了周期：双向都画（淡一点）
      for (let x = bx % period; x <= off.w + 1; x += period)
        this.el('line', { class: 'phase-line faint', x1: x, y1: 0, x2: x, y2: off.h }, layer);
      for (let y = by % period; y <= off.h + 1; y += period)
        this.el('line', { class: 'phase-line faint', x1: 0, y1: y, x2: off.w, y2: y }, layer);
    }
    // 定位基点标记
    this.el('circle', { class: 'phase-base', cx: bx, cy: by, r: 6 }, layer);
    this.el('line', { class: 'phase-base-cross', x1: bx - 10, y1: by, x2: bx + 10, y2: by }, layer);
    this.el('line', { class: 'phase-base-cross', x1: bx, y1: by - 10, x2: bx, y2: by + 10 }, layer);
    const t = this.el('text', { class: 'phase-base-tag', x: bx + 9, y: by + 20 }, layer);
    t.textContent = `基点 ${fmtNum(bx)},${fmtNum(by)} · T=${fmtNum(period)}`;
  },

  /* 拼缝层：仅绘制落在本板上的接缝段（跨板缝在两块板各画半边） */
  renderSeamOverlay(sheetG, si, idx) {
    if (typeof Grain === 'undefined') return;
    const seams = (App.violations.grainSeams || []);
    seams.forEach((s) => {
      const onFrom = s.fromSheet === idx, onTo = s.toSheet === idx;
      if (!onFrom && !onTo) return;
      const cls = s.qualified ? 'seam-ok' : (s.status === 'unknown' ? 'seam-unknown' : 'seam-bad');
      if (s.axis === 'x') {
        // 竖缝
        if (onFrom) {
          const e = s.fromEdge;
          this.el('line', { class: 'seam-line ' + cls, x1: e.x, y1: e.y, x2: e.x, y2: e.y + e.h }, sheetG);
        }
        if (onTo) {
          const e = s.toEdge;
          this.el('line', { class: 'seam-line ' + cls, x1: e.x, y1: e.y, x2: e.x, y2: e.y + e.h }, sheetG);
          const mx = onFrom ? (s.fromEdge.x + s.toEdge.x) / 2 : e.x;
          const my = e.y + e.h / 2;
          this.seamTag(sheetG, mx, my, s, cls);
        }
      } else {
        if (onFrom) {
          const e = s.fromEdge;
          this.el('line', { class: 'seam-line ' + cls, x1: e.x, y1: e.y, x2: e.x + e.w, y2: e.y }, sheetG);
        }
        if (onTo) {
          const e = s.toEdge;
          this.el('line', { class: 'seam-line ' + cls, x1: e.x, y1: e.y, x2: e.x + e.w, y2: e.y }, sheetG);
          const mx = e.x + e.w / 2;
          const my = onFrom ? (s.fromEdge.y + s.toEdge.y) / 2 : e.y;
          this.seamTag(sheetG, mx, my, s, cls);
        }
      }
    });
  },

  seamTag(sheetG, x, y, s, cls) {
    const g = this.el('g', { class: 'seam-tag-g' }, sheetG);
    const txt = (s.status === 'unknown' ? '相位?' : `Δ${fmtNum(s.offset)}`) +
      (s.qualified ? '' : `/${fmtNum(s.tolerance)}`);
    const fs = 19;
    const w = txt.length * fs * 0.62 + 12, h = fs + 8;
    this.el('rect', { class: 'seam-tag-bg ' + cls, x: x - w / 2, y: y - h / 2, width: w, height: h, rx: 4 }, g);
    const t = this.el('text', { class: 'seam-tag ' + cls, x, y: y + fs * 0.36, 'font-size': fs }, g);
    t.textContent = txt;
  },

  partClass(p) {
    let cls = 'part';
    if (p.uid === App.selected) cls += ' selected';
    if (p.locked) cls += ' locked';
    const grp = typeof Grain !== 'undefined' ? Grain.groupOf(p.uid) : null;
    if (grp) cls += ' in-group';
    const v = App.violations.vmap.get(p.uid);
    if (v) {
      for (const code of ['overlap', 'bounds', 'spacing', 'grain', 'nodef', 'size', 'defect', 'grainmatch', 'edge']) {
        if (v.has(code)) { cls += ' v-' + code; break; }
      }
    }
    return cls;
  },

  renderPart(sheetG, p) {
    const g = this.el('g', {
      class: this.partClass(p), 'data-uid': p.uid,
      transform: `translate(${p.x}, ${p.y})`,
    }, sheetG);
    // 毛坯外廓（排样/裁切使用）
    const rect = this.el('rect', {
      class: 'part-rect part-blank', width: p.w, height: p.h, rx: 1.5,
      fill: colorFor(p.partId),
    }, g);

    const pd = App.uidPart(p.uid);
    // 成品轮廓（封边补偿后相对毛坯偏移，可能悬出）+ 待封边方向标记
    let ves = null;
    if (pd) {
      const pr = Edging.productRect(p, pd);
      const hasComp = Math.abs(pr.ox) > 1e-6 || Math.abs(pr.oy) > 1e-6 ||
        Math.abs(pr.w - p.w) > 1e-6 || Math.abs(pr.h - p.h) > 1e-6;
      if (hasComp) {
        this.el('rect', {
          class: 'part-product', x: pr.ox, y: pr.oy, width: pr.w, height: pr.h,
        }, g);
      }
      ves = Edging.visualEdges(pd, !!p.rotated);
      const batches = (App.edgingBatches && App.layout())
        ? App.edgingBatches() : null;
      const colorOf = (mat, th) => {
        if (!batches) return '#5d4037';
        const b = batches.find(x => x.material === (mat || '未命名材料') &&
          Math.abs(x.thickness - th) < 1e-9);
        return b ? Edging.batchColor(b.key) : '#5d4037';
      };
      ves.forEach((e) => {
        if (!e.banded) return;
        const col = colorOf(e.material, e.thickness);
        const sw = Math.max(2.2, Math.min(9, e.thickness * 1.4));
        if (e.key === 'top') {
          this.el('line', { class: 'edge-band', x1: pr.x - p.x, y1: pr.y - p.y,
            x2: pr.x - p.x + pr.w, y2: pr.y - p.y, stroke: col, 'stroke-width': sw }, g);
        } else if (e.key === 'bottom') {
          this.el('line', { class: 'edge-band', x1: pr.x - p.x, y1: pr.y - p.y + pr.h,
            x2: pr.x - p.x + pr.w, y2: pr.y - p.y + pr.h, stroke: col, 'stroke-width': sw }, g);
        } else if (e.key === 'left') {
          this.el('line', { class: 'edge-band', x1: pr.x - p.x, y1: pr.y - p.y,
            x2: pr.x - p.x, y2: pr.y - p.y + pr.h, stroke: col, 'stroke-width': sw }, g);
        } else {
          this.el('line', { class: 'edge-band', x1: pr.x - p.x + pr.w, y1: pr.y - p.y,
            x2: pr.x - p.x + pr.w, y2: pr.y - p.y + pr.h, stroke: col, 'stroke-width': sw }, g);
        }
      });
    }
    // 零件纹理方向指示线（沿零件宽度方向）
    if (pd && pd.grain && pd.grain !== 'none' && p.w > 40 && p.h > 20) {
      const n = Math.max(2, Math.floor(p.h / 40));
      for (let i = 1; i <= n; i++) {
        const gy = p.h * i / (n + 1);
        this.el('line', { class: 'part-grain', x1: p.w * 0.12, y1: gy, x2: p.w * 0.88, y2: gy }, g);
      }
    }
    // 标签：名称 + 尺寸
    const minSide = Math.min(p.w, p.h);
    if (minSide >= 26) {
      const fs = Math.max(14, Math.min(44, minSide * 0.28));
      const t1 = this.el('text', { class: 'part-label', x: p.w / 2, y: p.h / 2 - (minSide >= 46 ? fs * 0.18 : -fs * 0.3), 'font-size': fs }, g);
      t1.textContent = (pd ? pd.name : p.partId) + ' ' + String(p.uid).split('#')[1];
      if (minSide >= 46) {
        const pr0 = Edging.productRect(p, pd);
        const hasComp = Math.abs(pr0.w - p.w) > 1e-6 || Math.abs(pr0.h - p.h) > 1e-6 ||
          Math.abs(pr0.ox) > 1e-6 || Math.abs(pr0.oy) > 1e-6;
        const t2 = this.el('text', { class: 'part-dim', x: p.w / 2, y: p.h / 2 + fs * 0.85, 'font-size': fs * 0.72 }, g);
        t2.textContent = `坯 ${fmtNum(p.w)}×${fmtNum(p.h)}`;
        if (hasComp && minSide >= 70) {
          const t3 = this.el('text', { class: 'part-dim part-dim-prod', x: p.w / 2, y: p.h / 2 + fs * 1.55, 'font-size': fs * 0.62 }, g);
          t3.textContent = `成品 ${fmtNum(pr0.w)}×${fmtNum(pr0.h)}`;
        }
      }
    }
    if (p.rotated && minSide >= 30) {
      const t = this.el('text', { class: 'part-tag', x: p.w - 26, y: 24, 'font-size': 20 }, g);
      t.textContent = '⟳';
    }
    if (p.locked) {
      const t = this.el('text', { class: 'part-tag', x: 6, y: 24, 'font-size': 20 }, g);
      t.textContent = '🔒';
    }
    // 拼纹组徽标：组号 + 安装次序
    if (typeof Grain !== 'undefined') {
      const grp = Grain.groupOf(p.uid);
      if (grp) {
        const mi = grp.members.indexOf(p.uid) + 1;
        const tagW = 15 + String(grp.id).length * 9 + String(mi).length * 8;
        this.el('rect', { class: 'group-badge-bg', x: p.w - tagW - 4, y: 4,
                          width: tagW, height: 22, rx: 4 }, g);
        const t = this.el('text', {
          class: 'group-badge', x: p.w - tagW / 2 - 4, y: 20, 'font-size': 15,
        }, g);
        t.textContent = `${grp.id}·${mi}`;
      }
    }
    // 容缺示意：容许区（蓝色虚线）与正反面要求角标
    if (pd) {
      (pd.allowZones || []).forEach((z) => {
        const zt = Defects.transformZone(z, p, pd);
        if (zt.length >= 3) {
          this.el('polygon', {
            class: 'part-allowzone',
            points: zt.map(q => `${q.x},${q.y}`).join(' '),
          }, g);
        }
      });
      const faceTag = { any: '', front: '正', back: '反', both: '双' }[pd.faceReq || 'any'];
      if (faceTag && minSide >= 30) {
        const t = this.el('text', { class: 'part-face-tag', x: 6, y: p.h - 8, 'font-size': 18 }, g);
        t.textContent = faceTag + (+pd.allowGrade ? `·容${pd.allowGrade}级` : '');
      }
    }
    return g;
  },

  /* ---- 交互 ---- */
  onPointerDown(e) {
    if (e.button !== 0 && e.button !== 1) return;
    const partG = e.target.closest && e.target.closest('g.part');
    const defectG = e.target.closest && e.target.closest('g.defect');

    if (App.placeMode && e.button === 0) { this.placeAt(e); return; }

    // 缺陷系统优先：绘制模式下全部拦截；非绘制模式下点到缺陷（含手柄）则选中/拖动
    if (e.button === 0 && typeof Defects !== 'undefined') {
      const wpt0 = this.screenToWorld(e.clientX, e.clientY);
      const sIdx = this.sheetAt(wpt0.x, wpt0.y);
      if (sIdx >= 0) {
        const lay = App.layout();
        const off = this.sheetOffsets[sIdx];
        const local = { x: wpt0.x - off.x, y: wpt0.y - off.y };
        if (App.defectMode || defectG || (e.target.classList && e.target.classList.contains('defect-handle'))) {
          if (Defects.onPointerDown(e, sIdx, local, defectG)) return;
        }
      }
    }

    if (partG && e.button === 0) {
      const uid = partG.getAttribute('data-uid');
      App.selected = uid;
      const found = App.findPlacement(uid);
      if (found && !found.placement.locked) {
        const wpt = this.screenToWorld(e.clientX, e.clientY);
        const off = this.sheetOffsets[found.sheetIndex];
        this.drag = {
          uid, w: found.placement.w, h: found.placement.h,
          rotated: !!found.placement.rotated,
          startX: wpt.x, startY: wpt.y,
          origWorldX: off.x + found.placement.x,
          origWorldY: off.y + found.placement.y,
          fromSheet: found.sheetIndex,
          floating: false, node: null, targetSheet: found.sheetIndex,
        };
      }
      renderAll();
      return;
    }
    // 空白处：平移
    this.pan = { sx: e.clientX, sy: e.clientY, vx: App.view.x, vy: App.view.y };
  },

  onPointerMove(e) {
    // 状态栏坐标
    const wpt = this.screenToWorld(e.clientX, e.clientY);
    const posEl = document.getElementById('st-pos');
    if (posEl) posEl.textContent = `光标 (${Math.round(wpt.x)}, ${Math.round(wpt.y)}) mm`;

    // 缺陷拖动 / 绘制中的预览（局部坐标）
    if (typeof Defects !== 'undefined' && Defects.drag) {
      const tIdx = this.sheetAt(wpt.x, wpt.y);
      if (tIdx >= 0) {
        const off = this.sheetOffsets[tIdx];
        Defects._lastClientX = e.clientX;
        Defects._lastClientY = e.clientY;
        Defects._curSheetIdx = tIdx;
        if (Defects.onPointerMove({ x: wpt.x - off.x, y: wpt.y - off.y })) return;
      }
    }

    if (this.pan) {
      const r = this.svg.getBoundingClientRect();
      const scale = App.view.w / (r.width || 1);
      App.view.x = this.pan.vx - (e.clientX - this.pan.sx) * scale;
      App.view.y = this.pan.vy - (e.clientY - this.pan.sy) * scale;
      this.applyView();
      return;
    }
    const d = this.drag;
    if (!d) return;

    if (!d.floating) {
      // 第一次移动：把节点提到 SVG 根层，用世界坐标自由拖动（支持跨板）
      d.floating = true;
      d.node = this.svg.querySelector(`g.part[data-uid="${CSS.escape(d.uid)}"]`);
      if (d.node) this.svg.appendChild(d.node);
    }
    let nx = Math.round(d.origWorldX + (wpt.x - d.startX));
    let ny = Math.round(d.origWorldY + (wpt.y - d.startY));
    d.worldX = nx; d.worldY = ny;
    if (d.node) d.node.setAttribute('transform', `translate(${nx}, ${ny})`);

    // 以零件中心判定目标板材
    const tIdx = this.sheetAt(nx + d.w / 2, ny + d.h / 2);
    d.targetSheet = tIdx;
    this.markTargetSheet(tIdx);

    // 实时合法性提示
    if (d.node) {
      let ok = false;
      if (tIdx >= 0) {
        const off = this.sheetOffsets[tIdx];
        ok = Validate.checkPlacement(tIdx, d.uid, nx - off.x, ny - off.y, d.w, d.h);
      }
      d.node.classList.toggle('drag-invalid', !ok);
    }
    // 拼纹接缝逐缝更新（轻量覆盖层，避免整体重绘打断拖拽）
    if (typeof Grain !== 'undefined') this.renderDragSeams(d, nx, ny, tIdx);
  },

  /* 拖拽中实时计算被拖成员与拼纹组相邻成员的接缝错花量 */
  renderDragSeams(drag, worldX, worldY, tIdx) {
    let layer = this.svg.querySelector('#drag-seam-layer');
    if (!layer) {
      layer = this.el('g', { id: 'drag-seam-layer', class: 'drag-seam-layer' }, this.svg);
    }
    layer.replaceChildren();
    const lay = App.layout();
    const grp = Grain.groupOf(drag.uid);
    if (!grp || !lay || tIdx < 0) return;
    const off = this.sheetOffsets[tIdx];
    const fakePd = App.uidPart(drag.uid);
    const fakeCur = {
      uid: drag.uid, partId: String(drag.uid).split('#')[0],
      x: worldX - off.x, y: worldY - off.y, w: drag.w, h: drag.h,
      rotated: drag.rotated || false,
    };
    if (fakePd) fakeCur.product = Edging.productGeom(fakePd, !!fakeCur.rotated);
    const sInfoCur = Grain.sheetInfo(lay, tIdx);
    const mi = grp.members.indexOf(drag.uid);
    const axis = grp.dir === 'h' ? 'x' : 'y';
    const drawTag = (x, y, seam) => {
      const cls = Grain.seamQualified(seam, grp.tolerance)
        ? 'seam-ok' : (seam.status === 'unknown' ? 'seam-unknown' : 'seam-bad');
      const txt = seam.status === 'unknown' ? '相位?' : `Δ${fmtNum(seam.offset)}/${fmtNum(grp.tolerance)}`;
      const fs = 20, w = txt.length * fs * 0.62 + 12, h = fs + 8;
      const gg = this.el('g', {}, layer);
      this.el('rect', { class: 'seam-tag-bg ' + cls, x: x - w / 2, y: y - h / 2, width: w, height: h, rx: 4 }, gg);
      const t = this.el('text', { class: 'seam-tag ' + cls, x, y: y + fs * 0.36, 'font-size': fs }, gg);
      t.textContent = txt;
    };
    [mi - 1, mi + 1].forEach((otherIdx) => {
      if (otherIdx < 0 || otherIdx >= grp.members.length) return;
      const otherUid = grp.members[otherIdx];
      const hit = Grain.findOnBoard(lay, otherUid);
      if (!hit) return;
      const oOff = this.sheetOffsets[hit.sheetIndex];
      const prevRec = otherIdx < mi
        ? { ...hit.placement }
        : { ...fakeCur };
      const curRec = otherIdx < mi
        ? { ...fakeCur }
        : { ...hit.placement };
      const sPrev = otherIdx < mi ? Grain.sheetInfo(lay, hit.sheetIndex) : sInfoCur;
      const sCur = otherIdx < mi ? sInfoCur : Grain.sheetInfo(lay, hit.sheetIndex);
      const seam = Grain.evaluateSeam(prevRec, curRec, axis, grp.productGap, sPrev, sCur);
      const qualified = Grain.seamQualified(seam, grp.tolerance);
      const cls = qualified ? 'seam-ok' : (seam.status === 'unknown' ? 'seam-unknown' : 'seam-bad');
      // 在两件之间画预览缝（世界坐标）
      if (axis === 'x') {
        if (otherIdx < mi) {
          // 缝在 fakeCur 左缘
          this.el('line', { class: 'seam-line ' + cls,
            x1: worldX, y1: worldY, x2: worldX, y2: worldY + drag.h }, layer);
          drawTag(worldX - 10, worldY + drag.h / 2, seam);
        } else {
          this.el('line', { class: 'seam-line ' + cls,
            x1: oOff.x + hit.placement.x, y1: oOff.y + hit.placement.y,
            x2: oOff.x + hit.placement.x, y2: oOff.y + hit.placement.y + hit.placement.h }, layer);
          drawTag(oOff.x + hit.placement.x - 10, oOff.y + hit.placement.y + hit.placement.h / 2, seam);
        }
      } else {
        if (otherIdx < mi) {
          this.el('line', { class: 'seam-line ' + cls,
            x1: worldX, y1: worldY, x2: worldX + drag.w, y2: worldY }, layer);
          drawTag(worldX + drag.w / 2, worldY - 10, seam);
        } else {
          this.el('line', { class: 'seam-line ' + cls,
            x1: oOff.x + hit.placement.x, y1: oOff.y + hit.placement.y,
            x2: oOff.x + hit.placement.x + hit.placement.w, y2: oOff.y + hit.placement.y }, layer);
          drawTag(oOff.x + hit.placement.x + hit.placement.w / 2,
                  oOff.y + hit.placement.y - 10, seam);
        }
      }
    });
  },

  clearDragSeams() {
    const layer = this.svg.querySelector('#drag-seam-layer');
    if (layer) layer.remove();
  },

  onPointerUp() {
    if (typeof Defects !== 'undefined' && Defects.drag) {
      Defects.onPointerUp();
      return;
    }
    if (this.pan) { this.pan = null; return; }
    const d = this.drag;
    if (!d) return;
    this.drag = null;
    this.markTargetSheet(-1);
    if (!d.floating) return;  // 纯点击，仅选中

    const found = App.findPlacement(d.uid);
    if (!found) { renderAll(); return; }
    const lay = App.layout();
    const tIdx = (d.targetSheet != null && d.targetSheet >= 0) ? d.targetSheet : d.fromSheet;
    const off = this.sheetOffsets[tIdx];
    const lx = Math.max(0, Math.round(d.worldX - off.x));
    const ly = Math.max(0, Math.round(d.worldY - off.y));

    const arr = lay.sheets[d.fromSheet].placements;
    const i = arr.findIndex(p => p.uid === d.uid);
    const [p] = arr.splice(i, 1);
    p.x = lx; p.y = ly;
    lay.sheets[tIdx].placements.push(p);
    this.clearDragSeams();
    App.pushHistory();
    renderAll();
  },

  sheetAt(wx, wy) {
    for (let i = 0; i < this.sheetOffsets.length; i++) {
      const o = this.sheetOffsets[i];
      if (wx >= o.x && wx <= o.x + o.w && wy >= o.y && wy <= o.y + o.h) return i;
    }
    return -1;
  },

  markTargetSheet(idx) {
    this.svg.querySelectorAll('g.sheet').forEach((g, i) => {
      g.classList.toggle('sheet-target', i === idx);
    });
  },

  /* 手动放置模式：在目标板材上点击放置未排零件 */
  placeAt(e) {
    const uid = App.placeMode;
    const lay = App.layout();
    if (!uid || !lay) return;
    const wpt = this.screenToWorld(e.clientX, e.clientY);
    const tIdx = this.sheetAt(wpt.x, wpt.y);
    if (tIdx < 0) { toast('请点击某张板材内部进行放置'); return; }
    const ui = lay.unplaced.findIndex(u => u.uid === uid);
    if (ui < 0) { App.placeMode = null; renderAll(); return; }
    const pd = App.uidPart(uid);
    if (!pd) { toast('该零件定义已不存在'); App.placeMode = null; return; }
    const off = this.sheetOffsets[tIdx];
    const bd = App.blankDef(pd, false);
    const w = bd.w, h = bd.h;
    const x = Math.max(0, Math.round(wpt.x - off.x - w / 2));
    const y = Math.max(0, Math.round(wpt.y - off.y - h / 2));

    const [u] = lay.unplaced.splice(ui, 1);
    const placement = {
      uid: u.uid, partId: u.partId, name: u.name || u.partId,
      x, y, w, h, rotated: false, locked: false,
    };
    if (typeof Edging !== 'undefined') placement.product = Edging.productGeom(pd, false);
    lay.sheets[tIdx].placements.push(placement);
    App.placeMode = null;
    App.selected = uid;
    App.pushHistory();
    this.svg.classList.remove('place-mode');
    renderAll();
    toast(`已放置 ${uid}，可拖动微调`);
  },
};
