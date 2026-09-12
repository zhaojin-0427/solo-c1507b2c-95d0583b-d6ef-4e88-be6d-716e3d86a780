/* 板面缺陷避让：几何工具 + 缺陷属性/容缺判定 + SVG 渲染与交互。
 *
 * 数据模型（随板材实例、随项目保存）：
 *   App.defects['S1#0'] = [{
 *     id:'D1', type:'knot|crack|scratch', grade:1..3,
 *     face:'front|back|both', clearance:安全外扩mm,
 *     shape:'rect|poly', points:[{x,y},...]   // rect 存两个对角点（板材局部坐标）
 *   }]
 * 零件容缺：faceReq 'any|front|back|both'，allowGrade 0..3，
 *   allowZones:[{points:[{x,y}...]}]（零件局部坐标容许区）。
 *
 * 几何与后端 nesting.py 同口径：缺陷核心按 clearance 距离外扩为禁入区；
 * 等级 ≤ 零件允许等级 或 核心整体落入容许区 时豁免；面别不相遇时不冲突。
 */
const Defects = {
  EPS: 1e-6,
  TYPES: { knot: '节疤', crack: '裂纹', scratch: '划痕' },
  FACES: { front: '正面', back: '反面', both: '双面' },
  TYPE_COLOR: { knot: '#6d4c41', crack: '#c62828', scratch: '#ef6c00' },

  /* ============ 纯几何（与 nesting.py 一致） ============ */
  points(d) { return (d && d.points || []).map(p => ({ x: +p.x, y: +p.y })); },

  bbox(d) {
    const pts = this.points(d);
    if (!pts.length) return null;
    const xs = pts.map(p => p.x), ys = pts.map(p => p.y);
    return { x: Math.min(...xs), y: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys) };
  },

  /* rect 以两点存储；4 点多边形（渲染/判定用） */
  polyPoints(d) {
    const pts = this.points(d);
    if (d.shape === 'rect' && pts.length === 2) {
      const [a, b] = pts;
      const x0 = Math.min(a.x, b.x), y0 = Math.min(a.y, b.y);
      const x1 = Math.max(a.x, b.x), y1 = Math.max(a.y, b.y);
      return [{ x: x0, y: y0 }, { x: x1, y: y0 }, { x: x1, y: y1 }, { x: x0, y: y1 }];
    }
    return pts;
  },

  polyArea(pts) {
    if (pts.length < 3) return 0;
    let s = 0;
    for (let i = 0; i < pts.length; i++) {
      const a = pts[i], b = pts[(i + 1) % pts.length];
      s += a.x * b.y - b.x * a.y;
    }
    return Math.abs(s) / 2;
  },

  pointInPoly(x, y, pts) {
    let inside = false;
    const n = pts.length;
    for (let i = 0, j = n - 1; i < n; j = i++) {
      const xi = pts[i].x, yi = pts[i].y, xj = pts[j].x, yj = pts[j].y;
      if ((yi > y) !== (yj > y)) {
        const xc = (xj - xi) * (y - yi) / (yj - yi + this.EPS) + xi;
        if (xc >= x - this.EPS) inside = !inside;
      }
      // 点落在边上
      if (Math.abs(x - xi) <= this.EPS &&
          Math.min(yi, yj) - this.EPS <= y && y <= Math.max(yi, yj) + this.EPS &&
          Math.abs((x - xi) * (yj - yi) - (xj - xi) * (y - yi)) <= 1e-6) return true;
    }
    return inside;
  },

  _ccw(a, b, c) {
    return (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
  },
  _onSeg(a, b, p) {
    return Math.abs(this._ccw(a, b, p)) <= 1e-6 &&
      Math.min(a.x, b.x) - this.EPS <= p.x && p.x <= Math.max(a.x, b.x) + this.EPS &&
      Math.min(a.y, b.y) - this.EPS <= p.y && p.y <= Math.max(a.y, b.y) + this.EPS;
  },
  segIntersect(a, b, c, d) {
    const d1 = this._ccw(c, d, a), d2 = this._ccw(c, d, b);
    const d3 = this._ccw(a, b, c), d4 = this._ccw(a, b, d);
    if (((d1 > this.EPS && d2 < -this.EPS) || (d1 < -this.EPS && d2 > this.EPS)) &&
        ((d3 > this.EPS && d4 < -this.EPS) || (d3 < -this.EPS && d4 > this.EPS))) return true;
    return this._onSeg(c, d, a) || this._onSeg(c, d, b) ||
           this._onSeg(a, b, c) || this._onSeg(a, b, d);
  },
  _ptSegDist(p, a, b) {
    const vx = b.x - a.x, vy = b.y - a.y;
    const l2 = vx * vx + vy * vy;
    let t = l2 <= this.EPS ? 0 : ((p.x - a.x) * vx + (p.y - a.y) * vy) / l2;
    t = Math.max(0, Math.min(1, t));
    const qx = a.x + t * vx, qy = a.y + t * vy;
    return Math.hypot(p.x - qx, p.y - qy);
  },
  segDist(a, b, c, d) {
    if (this.segIntersect(a, b, c, d)) return 0;
    return Math.min(this._ptSegDist(a, c, d), this._ptSegDist(b, c, d),
                    this._ptSegDist(c, a, b), this._ptSegDist(d, a, b));
  },

  /* 矩形 (x,y,w,h) 与简单多边形的最短距离；相交/包含返回 0 */
  rectPolyDist(x, y, w, h, pts) {
    const corners = [{ x, y }, { x: x + w, y }, { x: x + w, y: y + h }, { x, y: y + h }];
    for (const p of pts) {
      if (p.x >= x - this.EPS && p.x <= x + w + this.EPS &&
          p.y >= y - this.EPS && p.y <= y + h + this.EPS) return 0;
    }
    for (const c of corners) {
      if (pts.length >= 3 && this.pointInPoly(c.x, c.y, pts)) return 0;
    }
    const edges = corners.map((c, i) => [c, corners[(i + 1) % 4]]);
    let best = Infinity;
    for (let i = 0; i < pts.length; i++) {
      const a = pts[i], b = pts[(i + 1) % pts.length];
      for (const [c, d] of edges) best = Math.min(best, this.segDist(a, b, c, d));
    }
    return best;
  },

  faceConflict(defectFace, partFaceReq) {
    const req = partFaceReq || 'any';
    const df = defectFace || 'both';
    if (req === 'any') return false;
    if (df === 'both' || req === 'both') return true;
    return df === req;
  },

  /* 零件局部容许区 → 放置后坐标。旋转映射与后端一致：(lx,ly)→(x+ph-ly, y+lx) */
  transformZone(zone, p, pd) {
    const rotated = !!p.rotated;
    const pw = +pd.width, ph = +pd.height;
    return (zone.points || []).map(q => rotated
      ? { x: p.x + ph - q.y, y: p.y + q.x }
      : { x: p.x + q.x, y: p.y + q.y });
  },

  /* 缺陷核心是否整体落在零件某容许区内 */
  insideAllowZone(dpts, p, pd) {
    for (const q of dpts) {
      if (!(q.x >= p.x - this.EPS && q.x <= p.x + p.w + this.EPS &&
            q.y >= p.y - this.EPS && q.y <= p.y + p.h + this.EPS)) return false;
    }
    for (const zone of (pd.allowZones || [])) {
      const zt = this.transformZone(zone, p, pd);
      if (zt.length < 3) continue;
      if (dpts.every(q => this.pointInPoly(q.x, q.y, zt))) {
        let crossed = false;
        for (let i = 0; i < dpts.length && !crossed; i++) {
          const a = dpts[i], b = dpts[(i + 1) % dpts.length];
          for (let j = 0; j < zt.length; j++) {
            if (this.segIntersect(a, b, zt[j], zt[(j + 1) % zt.length])) { crossed = true; break; }
          }
        }
        if (!crossed) return true;
      }
    }
    return false;
  },

  /* 返回与放置矩形冲突的缺陷（已考虑面别/等级/容许区/安全外扩） */
  blockingDefect(p, pd, defects) {
    for (const d of defects || []) {
      if (!this.faceConflict(d.face, pd.faceReq)) continue;
      const pts = this.polyPoints(d);
      const bb = this.bbox(d);
      const gx = Math.max(0, bb.x - (p.x + p.w), p.x - bb.x1);
      const gy = Math.max(0, bb.y - (p.y + p.h), p.y - bb.y1);
      if (gx >= (+d.clearance || 0) - this.EPS && gy >= (+d.clearance || 0) - this.EPS) continue;
      if ((+pd.allowGrade || 0) && (+d.grade || 0) <= +pd.allowGrade) continue;
      if (this.insideAllowZone(pts, p, pd)) continue;
      const dist = this.rectPolyDist(p.x, p.y, p.w, p.h, pts);
      if (dist + this.EPS < (+d.clearance || 0)) return d;
    }
    return null;
  },

  /* 禁入区面积估算（Steiner 外扩近似，钳制在可用区域内），与后端同口径 */
  expandedArea(d, margin, uw, uh) {
    const pts = this.polyPoints(d).map(p => ({ x: p.x - margin, y: p.y - margin }));
    let core = this.polyArea(pts), perim = 0;
    for (let i = 0; i < pts.length; i++) {
      const a = pts[i], b = pts[(i + 1) % pts.length];
      perim += Math.hypot(b.x - a.x, b.y - a.y);
    }
    const c = Math.max(0, +d.clearance || 0);
    const est = core + perim * c + Math.PI * c * c;
    return Math.max(0, Math.min(est, Math.max(0, uw) * Math.max(0, uh)));
  },

  label(d) {
    return `${d.id}（${this.TYPES[d.type] || d.type}·${d.grade}级·` +
           `${this.FACES[d.face] || d.face}·外扩${fmtNum(d.clearance)}mm）`;
  },

  nextDefectId(key) {
    const list = App.defects[key] || [];
    let n = 1;
    while (list.some(d => d.id === 'D' + n)) n++;
    return 'D' + n;
  },

  /* ============ 渲染 ============ */
  NS: 'http://www.w3.org/2000/svg',
  el(tag, attrs, parent) {
    const n = document.createElementNS(this.NS, tag);
    for (const k in (attrs || {})) n.setAttribute(k, attrs[k]);
    if (parent) parent.appendChild(n);
    return n;
  },

  /* 缺陷安全外扩的近似多边形（仅用于绘制安全边界虚线）：
     按顶点法线方向外扩，凹区可能自交，仅作可视化提示；判定以精确距离为准。 */
  bufferOutline(d) {
    const pts = this.polyPoints(d);
    const c = Math.max(0, +d.clearance || 0);
    if (c <= 0) return pts;
    // 绕向（鞋带和）：顺时针法线取右侧，逆时针取左侧
    let wind = 0;
    for (let i = 0; i < pts.length; i++) {
      const a = pts[i], b = pts[(i + 1) % pts.length];
      wind += a.x * b.y - b.x * a.y;
    }
    const sgn = wind >= 0 ? 1 : -1;
    const out = [];
    for (let i = 0; i < pts.length; i++) {
      const prev = pts[(i - 1 + pts.length) % pts.length];
      const cur = pts[i];
      const nxt = pts[(i + 1) % pts.length];
      const normal = (a, b) => {
        const dx = b.x - a.x, dy = b.y - a.y;
        const l = Math.hypot(dx, dy) || 1;
        return { x: sgn * dy / l, y: -sgn * dx / l };
      };
      const n1 = normal(prev, cur), n2 = normal(cur, nxt);
      let nx = n1.x + n2.x, ny = n1.y + n2.y;
      const l = Math.hypot(nx, ny);
      if (l < 1e-6) { nx = n2.x; ny = n2.y; }
      else { nx /= l; ny /= l; }
      out.push({ x: cur.x + nx * c, y: cur.y + ny * c });
    }
    return out;
  },

  pointsAttr(pts) { return pts.map(p => `${fmtNum(p.x)},${fmtNum(p.y)}`).join(' '); },

  /* 在某板材 g（局部坐标）内渲染缺陷。idx 为板材实例下标，key=S1#0 */
  renderInto(sheetG, si, idx) {
    const key = App.defectKey(si.sheetId, si.instance);
    const list = App.defectsOn(si.sheetId, si.instance);
    const W = +(App.sheetDef(si.sheetId) || si).width;
    const H = +(App.sheetDef(si.sheetId) || si).height;
    if (!list.length && !(App.defectMode && Canvas.sheetOffsets[idx])) return;
    list.forEach((d) => {
      const sel = App.selectedDefect && App.selectedDefect.key === key && App.selectedDefect.id === d.id;
      const conflictUids = (App.violations.dmap.get(key + ':' + d.id) || []);
      const pts = this.polyPoints(d);
      const color = this.TYPE_COLOR[d.type] || '#6d4c41';
      const g = this.el('g', { class: 'defect' + (sel ? ' selected' : ''), 'data-key': key, 'data-id': d.id }, sheetG);

      // 安全外扩边界
      const buf = this.bufferOutline(d);
      if (buf.length >= 3) {
        this.el('polygon', { class: 'defect-buffer', points: this.pointsAttr(buf), stroke: color }, g);
      }
      // 核心区
      if (d.shape === 'rect' && (d.points || []).length === 2) {
        const bb = this.bbox(d);
        this.el('rect', {
          class: 'defect-core', x: bb.x, y: bb.y,
          width: Math.max(1, bb.x1 - bb.x), height: Math.max(1, bb.y1 - bb.y),
          fill: color, stroke: color,
        }, g);
      } else {
        this.el('polygon', { class: 'defect-core', points: this.pointsAttr(pts), fill: color, stroke: color }, g);
      }
      // 编号
      const bb = this.bbox(d);
      const cx = (bb.x + bb.x1) / 2, cy = (bb.y + bb.y1) / 2;
      const t = this.el('text', { class: 'defect-tag', x: cx, y: cy + 7, 'font-size': 22 }, g);
      t.textContent = d.id;
      const ts = this.el('text', { class: 'defect-sub', x: bb.x, y: Math.max(14, bb.y - 8), 'font-size': 16 }, g);
      ts.textContent = `${this.TYPES[d.type] || ''} ${d.grade}级 外扩${fmtNum(d.clearance)}`;

      // 受影响零件：红圈提示（冲突零件在 Validate 中已标 v-defect）
      if (conflictUids.length) {
        this.el('circle', { class: 'defect-affect', cx, cy, r: 16 }, g);
      }
      // 选中：绘制调整手柄
      if (sel) this.renderHandles(g, d, pts);
      // 越界缺陷提示
      if (bb.x < -this.EPS || bb.y < -this.EPS || bb.x1 > W + this.EPS || bb.y1 > H + this.EPS) {
        g.classList.add('out-of-sheet');
      }
    });

    // 正在绘制的缺陷预览
    if (App.defectMode && this._draft && this._draft.key === key) {
      const dr = this._draft;
      if (dr.shape === 'rect' && dr.anchor) {
        const cur = dr.current || dr.anchor;
        const x = Math.min(dr.anchor.x, cur.x), y = Math.min(dr.anchor.y, cur.y);
        this.el('rect', { class: 'defect-draft', x, y, width: Math.abs(cur.x - dr.anchor.x), height: Math.abs(cur.y - dr.anchor.y) }, sheetG);
      } else if (dr.shape === 'poly' && dr.verts.length) {
        const ps = dr.verts.concat(dr.current ? [dr.current] : []);
        if (ps.length >= 2) this.el('polyline', { class: 'defect-draft', points: this.pointsAttr(ps) }, sheetG);
        dr.verts.forEach(v => this.el('circle', { class: 'defect-draft-v', cx: v.x, cy: v.y, r: 5 }, sheetG));
      }
    }
  },

  renderHandles(g, d, pts) {
    // 多边形：每顶点一个手柄；矩形：四角手柄（存对角两点）
    if (d.shape === 'rect') {
      this.bbox(d);
      const raw = d.points;
      raw.forEach((p, i) => {
        this.el('rect', { class: 'defect-handle', 'data-h': i, x: p.x - 7, y: p.y - 7, width: 14, height: 14 }, g);
      });
    } else {
      (d.points || []).forEach((p, i) => {
        this.el('circle', { class: 'defect-handle', 'data-h': i, cx: p.x, cy: p.y, r: 7 }, g);
      });
      if (d.points && d.points.length > 3) {
        const mid = { x: pts[0].x, y: pts[0].y };
        const btn = this.el('g', { class: 'defect-del-v', 'data-h': 'del0' }, g);
        this.el('circle', { cx: mid.x, cy: mid.y, r: 9 }, btn);
        const tx = this.el('text', { x: mid.x, y: mid.y + 5, 'font-size': 14, 'text-anchor': 'middle' }, btn);
        tx.textContent = '−';
      }
    }
  },

  /* ============ 命中测试（板材局部坐标） ============ */
  hitTest(si, lx, ly) {
    const list = App.defectsOn(si.sheetId, si.instance);
    // 手柄优先
    // （手柄事件在 onPointerDown 中通过 data-h 直接识别）
    for (let i = list.length - 1; i >= 0; i--) {
      const d = list[i];
      if (this.pointInPoly(lx, ly, this.polyPoints(d))) {
        return { key: App.defectKey(si.sheetId, si.instance), defect: d };
      }
    }
    return null;
  },

  /* ============ 交互（由 canvas.js 的指针事件钩子调用） ============ */
  drag: null,

  /* 返回 true 表示缺陷系统处理了该次 pointerdown */
  onPointerDown(e, sheetIdx, localPt, target) {
    const lay = App.layout();
    if (!lay || !lay.sheets[sheetIdx]) return false;
    const si = lay.sheets[sheetIdx];
    const key = App.defectKey(si.sheetId, si.instance);

    // 调整手柄
    const handleEl = e.target.closest && e.target.closest('.defect-handle, .defect-del-v');
    if (handleEl) {
      const dg = handleEl.closest('g.defect');
      const id = dg.getAttribute('data-id');
      const found = this.findDefect(key, id);
      if (found.defect) {
        if (handleEl.classList.contains('defect-del-v')) {
          const hi = +(handleEl.getAttribute('data-h').replace('del', ''));
          found.defect.points.splice(hi, 1);
          App.pushHistory(); renderAll();
          return true;
        }
        const hi = +handleEl.getAttribute('data-h');
        App.selectedDefect = { key, id };
        this.drag = { kind: 'vertex', key, id, hi, start: localPt };
      }
      return true;
    }

    // 绘制模式
    if (App.defectMode === 'rect') {
      this._draft = { shape: 'rect', key, anchor: localPt, current: localPt, verts: [] };
      this.drag = { kind: 'draw-rect', sheetIdx };
      return true;
    }
    if (App.defectMode === 'poly') {
      if (!this._draft || this._draft.key !== key || this._draft.shape !== 'poly') {
        this._draft = { shape: 'poly', key, verts: [localPt], current: localPt };
      } else {
        const first = this._draft.verts[0];
        if (Math.hypot(localPt.x - first.x, localPt.y - first.y) < 12 && this._draft.verts.length >= 3) {
          this.finishPoly();
          return true;
        }
        // 去除重复点
        if (!this._draft.verts.some(v => Math.hypot(v.x - localPt.x, v.y - localPt.y) < 5)) {
          this._draft.verts.push(localPt);
        }
      }
      this.drag = { kind: 'draw-poly', sheetIdx };
      renderAll();
      return true;
    }

    // 点击缺陷本体：选中并准备拖动
    const hit = this.hitTest(si, localPt);
    if (hit) {
      App.selected = null;
      App.selectedDefect = { key: hit.key, id: hit.defect.id };
      this.drag = {
        kind: 'move', sheetIdx, key: hit.key, id: hit.defect.id,
        start: localPt, orig: JSON.stringify(hit.defect.points),
      };
      renderAll();
      return true;
    }
    return false;
  },

  onPointerMove(localPt) {
    const d = this.drag;
    if (!d) return false;
    if (d.kind === 'draw-rect' || d.kind === 'draw-poly') {
      // 绘制中可能拖到相邻板上方，仍以起画板局部坐标换算
      if (d.sheetIdx != null) {
        const off = Canvas.sheetOffsets[d.sheetIdx];
        if (off) {
          const wp = Canvas.screenToWorld(this._lastClientX, this._lastClientY);
          localPt = { x: wp.x - off.x, y: wp.y - off.y };
        }
      }
      this._draft.current = localPt;
      renderAll();
      return true;
    }
    const found = this.findDefect(d.key, d.id);
    const def = found.defect;
    if (!def) return false;
    // 顶点编辑使用当前板局部坐标；整体拖动须换算回起始板（缺陷不能跨板）
    if (d.kind === 'move' && d.sheetIdx != null && d.sheetIdx !== this._curSheetIdx) {
      const off = Canvas.sheetOffsets[d.sheetIdx];
      const wp = Canvas.screenToWorld(this._lastClientX, this._lastClientY);
      localPt = { x: wp.x - off.x, y: wp.y - off.y };
    }
    const dx = Math.round(localPt.x - d.start.x);
    const dy = Math.round(localPt.y - d.start.y);
    if (d.kind === 'move') {
      if (dx || dy) d.moved = true;
      const orig = JSON.parse(d.orig);
      def.points = orig.map(p => ({ x: p.x + dx, y: p.y + dy }));
      renderAll();
      return true;
    }
    if (d.kind === 'vertex') {
      const cur = def.points[d.hi];
      if (cur.x !== Math.round(localPt.x) || cur.y !== Math.round(localPt.y)) d.moved = true;
      def.points[d.hi] = { x: Math.round(localPt.x), y: Math.round(localPt.y) };
      renderAll();
      return true;
    }
    return false;
  },

  onPointerUp() {
    const d = this.drag;
    if (!d) return false;
    this.drag = null;
    if (d.kind === 'draw-rect') {
      this.finishRect();
      return true;
    }
    if (d.kind === 'move' || d.kind === 'vertex') {
      if (d.moved) App.pushHistory();
      else renderAll();
      return true;
    }
    return false;
  },

  finishRect() {
    const dr = this._draft;
    this._draft = null;
    if (!dr) return;
    const a = dr.anchor, b = dr.current;
    if (Math.abs(b.x - a.x) < 5 || Math.abs(b.y - a.y) < 5) { renderAll(); return; }
    const list = App.defects[dr.key] || (App.defects[dr.key] = []);
    list.push(this._newDefect('rect', [a, b], dr.key));
    this.commitDrawn(dr.key);
  },

  finishPoly() {
    const dr = this._draft;
    this._draft = null;
    if (!dr || dr.verts.length < 3) { renderAll(); return; }
    const list = App.defects[dr.key] || (App.defects[dr.key] = []);
    list.push(this._newDefect('poly', dr.verts.slice(), dr.key));
    this.commitDrawn(dr.key);
  },

  /* 双击结束多边形 */
  onDoubleClick(localPt) {
    if (App.defectMode === 'poly' && this._draft && this._draft.shape === 'poly') {
      if (this._draft.verts.length >= 3) { this.finishPoly(); return true; }
    }
    return false;
  },

  cancelDraft() {
    this._draft = null;
    this.drag = null;
  },

  _newDefect(shape, points, key) {
    return {
      id: this.nextDefectId(key),
      type: this._lastType || 'knot',
      grade: this._lastGrade || 2,
      face: this._lastFace || 'both',
      clearance: this._lastClearance != null ? this._lastClearance : 20,
      shape,
      points: points.map(p => ({ x: Math.round(p.x), y: Math.round(p.y) })),
    };
  },

  commitDrawn(key) {
    App.selectedDefect = { key, id: App.defects[key][App.defects[key].length - 1].id };
    App.pushHistory();
    renderAll();
    toast('缺陷已绘制，可在右侧修改类型/等级/影响面/外扩量');
  },

  setMode(mode) {
    if (!App.layout() && typeof Main !== 'undefined' && Main.ensureEmptyLayout) {
      if (!Main.ensureEmptyLayout()) { toast('请先定义至少一张原料板'); return; }
      Canvas.render();
      Canvas.zoomFit();
    }
    App.defectMode = App.defectMode === mode ? null : mode;
    this.cancelDraft();
    App.selectedDefect = null;
    if (App.defectMode) App.selected = null;
    Canvas.svg.classList.toggle('defect-mode', !!App.defectMode);
    Canvas.svg.classList.remove('place-mode');
    App.placeMode = null;
    renderAll();
    if (App.defectMode) toast(App.defectMode === 'rect'
      ? '矩形缺陷：在板材上按住拖出矩形（Esc 退出）'
      : '多边形缺陷：逐点单击，回到起点或双击闭合（Esc 退出）');
  },

  deleteSelected() {
    const sel = App.selectedDefect;
    if (!sel) return false;
    const f = this.findDefect(sel.key, sel.id);
    if (!f.defect) return false;
    f.list.splice(f.list.indexOf(f.defect), 1);
    App.selectedDefect = null;
    App.pushHistory();
    renderAll();
    return true;
  },

  /* 视图定位到某板材实例 */
  focusSheet(sheetIdx, pad = 120) {
    const off = Canvas.sheetOffsets[sheetIdx];
    if (!off) return;
    const r = Canvas.svg.getBoundingClientRect();
    let w = off.w + pad * 2, h = off.h + pad * 2;
    if (w / h > r.width / r.height) h = w * r.height / r.width;
    else w = h * r.width / r.height;
    App.view = { x: off.x - pad, y: off.y - pad, w, h };
    Canvas.applyView();
  },
};
