/* 封边尺寸补偿与封边工序：纯计算模块（不操作 DOM，可在 Node 中回归测试）。
 *
 * 约定（与后端 nesting.py 同口径）：
 * - 零件 width/height 为【成品尺寸】；四边按零件定义坐标系
 *   top / right / bottom / left 各有 {kind, material, thickness, trim}；
 *   kind: exposed=外露（须封边） join=拼接（不得封边） none=不处理。
 * - 毛坯 = 成品 − 两侧封边厚度 + 两侧修边余量（仅实际封边的外露边参与）。
 * - 排样、缺陷避让、裁切树使用毛坯外廓；拼纹接缝按成品边与成品间隙计算。
 * - 旋转 90° 后边属性随外形换向：canonical top→visual right、right→bottom、
 *   bottom→left、left→top。
 */
const Edging = {
  EPS: 1e-6,
  KEYS: ['top', 'right', 'bottom', 'left'],
  LABELS: { top: '上边', right: '右边', bottom: '下边', left: '左边' },
  KIND_LABELS: { exposed: '外露', join: '拼接', none: '不处理' },
  // canonical → visual（视觉顺时针 90°）
  ROT_MAP: { top: 'right', right: 'bottom', bottom: 'left', left: 'top' },

  edge(p, key) {
    const e = ((p && p.edges) || {})[key];
    const kind = (e && (e.kind === 'exposed' || e.kind === 'join' || e.kind === 'none'))
      ? e.kind : 'none';
    return {
      kind,
      material: (e && e.material) ? String(e.material) : '',
      thickness: Math.max(0, +(e && e.thickness) || 0),
      trim: Math.max(0, +(e && e.trim) || 0),
    };
  },

  /* 旧项目/旧数据兼容：无 edges 视为四边均不处理（毛坯=成品） */
  ensureEdges(p) {
    if (!p.edges || typeof p.edges !== 'object') {
      p.edges = {};
      this.KEYS.forEach(k => { p.edges[k] = { kind: 'none', material: '', thickness: 0, trim: 0 }; });
    } else {
      this.KEYS.forEach(k => {
        const e = p.edges[k];
        if (!e || typeof e !== 'object') {
          p.edges[k] = { kind: 'none', material: '', thickness: 0, trim: 0 };
        } else {
          if (!['exposed', 'join', 'none'].includes(e.kind)) e.kind = 'none';
          e.material = e.material || '';
          e.thickness = Math.max(0, +e.thickness || 0);
          e.trim = Math.max(0, +e.trim || 0);
        }
      });
    }
    return p.edges;
  },

  banded(e) { return e.kind === 'exposed' && e.thickness > this.EPS; },

  /* 单条边补偿量 = −封边厚度 + 修边余量（未封边为 0） */
  edgeComp(e) { return this.banded(e) ? (-e.thickness + e.trim) : 0; },

  /* 毛坯尺寸 {bw, bh, comp:{left,right,top,bottom}}（comp 为沿轴向的补偿） */
  blankDims(p) {
    const pw = +p.width || 0, ph = +p.height || 0;
    const comp = {};
    this.KEYS.forEach(k => { comp[k] = this.edgeComp(this.edge(p, k)); });
    return {
      bw: pw + comp.left + comp.right,
      bh: ph + comp.top + comp.bottom,
      comp,
      pw, ph,
    };
  },

  /* canonical 边 → 外形边（旋转后换向） */
  visualKey(canonical, rotated) {
    return rotated ? this.ROT_MAP[canonical] : canonical;
  },
  canonicalKey(visual, rotated) {
    if (!rotated) return visual;
    const inv = { top: 'right', right: 'bottom', bottom: 'left', left: 'top' };
    return inv[visual];
  },

  /* 外形四边（按 top,right,bottom,left）；每项附 canonical 原边名与 banded */
  visualEdges(p, rotated) {
    const order = rotated
      ? ['right', 'bottom', 'left', 'top']   // visual top,right,bottom,left 对应的 canonical
      : ['top', 'right', 'bottom', 'left'];
    return this.KEYS.map((vk, i) => {
      const ck = order[i];
      const e = this.edge(p, ck);
      return { key: vk, canonical: ck, ...e, banded: this.banded(e) };
    });
  },

  /* 放置方向上的成品在毛坯外形坐标中的几何 {w,h,ox,oy}（ox/oy 可为负=封边条悬出）。
     未旋转：成品 = 毛坯平移 comp.left/comp.top；
     旋转：canonical 左/上 → visual 顶，成品占据外形 [0,ph]×[0,pw]。 */
  productGeom(p, rotated) {
    const { bw, bh, comp, pw, ph } = this.blankDims(p);
    if (!rotated) return { w: pw, h: ph, ox: comp.left, oy: comp.top, blankW: bw, blankH: bh };
    return { w: ph, h: pw, ox: 0, oy: 0, blankW: bh, blankH: bw };
  },

  /* 放置记录 → 成品外形（画布绝对坐标，单位 mm）。
     后端结果在 p.product 已带 {w,h,ox,oy}；本地编辑/旧布局按零件定义现算。 */
  productRect(p, pd, rotated) {
    const rot = arguments.length >= 3 ? !!rotated : !!p.rotated;
    if (p.product && (p.product.w != null)) {
      const pr = p.product;
      return { x: p.x + (+pr.ox || 0), y: p.y + (+pr.oy || 0),
               w: +pr.w, h: +pr.h, ox: +pr.ox || 0, oy: +pr.oy || 0 };
    }
    const g = pd ? this.productGeom(pd, rot) : { w: p.w, h: p.h, ox: 0, oy: 0 };
    return { x: p.x + g.ox, y: p.y + g.oy, w: g.w, h: g.h, ox: g.ox, oy: g.oy };
  },

  /* 毛坯尺寸（放置方向上）：兼容后端 product.blankW 与本地定义现算 */
  blankSize(p, pd) {
    if (p.product && (p.product.blankW != null)) return { w: p.product.blankW, h: p.product.blankH };
    if (pd) {
      const g = this.productGeom(pd, !!p.rotated);
      return { w: g.blankW, h: g.blankH };
    }
    return { w: p.w, h: p.h };
  },

  /* 定义级工序核对：毛坯非正 / 外露边未封 / 拼接边误封。
     返回 [{code, partId, edge(canonical), msg}] */
  partIssues(p) {
    const issues = [];
    const { bw, bh } = this.blankDims(p);
    const name = p.name || p.id;
    if (!(bw > this.EPS) || !(bh > this.EPS)) {
      issues.push({ code: 'blanknonpositive', partId: p.id, edge: null,
        msg: `${p.id}（${name}）封边补偿后毛坯尺寸为 ${fmtNum(bw)}×${fmtNum(bh)}mm，` +
             `非正值无法下料（请减小封边厚度或修改成品尺寸）` });
    }
    this.KEYS.forEach((k) => {
      const e = this.edge(p, k);
      const lab = this.LABELS[k];
      if (e.kind === 'exposed' && !this.banded(e)) {
        const why = [];
        if (!(+e.thickness > 0)) why.push('未填写封边厚度');
        if (!e.material) why.push('未填写封边材料');
        issues.push({ code: 'exposedunbanded', partId: p.id, edge: k,
          msg: `${p.id}（${name}）${lab}标为外露但${why.join('、') || '未封边'}，外露边必须封边` });
      }
      if (e.kind === 'join' && +e.thickness > this.EPS) {
        issues.push({ code: 'joinbanded', partId: p.id, edge: k,
          msg: `${p.id}（${name}）${lab}标为拼接却封了 ${fmtNum(e.thickness)}mm 厚的边` +
               `（材料 ${e.material || '未填'}），拼接边不得封边` });
      }
    });
    return issues;
  },

  allIssues(parts) {
    const out = [];
    (parts || []).forEach(p => this.partIssues(p).forEach(i => out.push(i)));
    return out;
  },

  /* ---- 封边批次（按材料 + 厚度合并） ----
     输入：当前方案 placements（App.layout().sheets[*].placements）。
     每条实际封边（外露且厚度>0）生成一个 segment：
       {uid, partId, name, edgeVisual, edgeCanonical, material, thickness, trim,
        length(=封边条长度，取成品边长度，旋转随边换向), x,y(画布起点), angle}
     批次键 = 材料 + '\x1f' + 厚度（材料缺省记为"未命名材料"）。 */
  collectSegments(lay) {
    const segs = [];
    if (!lay) return segs;
    lay.sheets.forEach((si, sheetIdx) => {
      si.placements.forEach((p) => {
        const pd = App.partDef ? App.partDef(p.partId) : null;
        if (!pd) return;
        this.ensureEdges(pd);
        const pr = this.productRect(p, pd);
        const ves = this.visualEdges(pd, !!p.rotated);
        ves.forEach((e) => {
          if (!e.banded) return;
          let x, y, angle, length;
          if (e.key === 'top') {
            x = pr.x; y = pr.y; angle = 0; length = pr.w;
          } else if (e.key === 'bottom') {
            x = pr.x; y = pr.y + pr.h; angle = 0; length = pr.w;
          } else if (e.key === 'left') {
            x = pr.x; y = pr.y + pr.h; angle = -90; length = pr.h;
          } else {
            x = pr.x + pr.w; y = pr.y; angle = 90; length = pr.h;
          }
          segs.push({
            uid: p.uid, partId: p.partId, name: pd.name,
            edgeVisual: e.key, edgeCanonical: e.canonical,
            kind: e.kind, material: e.material, thickness: e.thickness,
            trim: e.trim, length, x, y, angle,
            sheetIndex: sheetIdx, sheetId: si.sheetId, instance: si.instance,
          });
        });
      });
    });
    return segs;
  },

  /* 分段排序：'shortFirst'=先短边后长边（同长度按 uid/边名稳定排序），
     'longFirst'=先长边后短边；'manual' 时使用 order 中保存的 uid|edge 次序。 */
  orderSegments(segs, mode, savedOrder) {
    const idOf = s => s.uid + '|' + s.edgeVisual;
    if (mode === 'manual' && Array.isArray(savedOrder) && savedOrder.length) {
      const idx = new Map(savedOrder.map((id, i) => [id, i]));
      const rest = segs.filter(s => !idx.has(idOf(s)));
      const known = segs.filter(s => idx.has(idOf(s)))
        .sort((a, b) => idx.get(idOf(a)) - idx.get(idOf(b)));
      rest.sort((a, b) => a.length - b.length || idOf(a).localeCompare(idOf(b)));
      return known.concat(rest);
    }
    const arr = segs.slice();
    arr.sort((a, b) => {
      if (mode === 'longFirst') {
        if (Math.abs(b.length - a.length) > this.EPS) return b.length - a.length;
      } else {
        if (Math.abs(a.length - b.length) > this.EPS) return a.length - b.length;
      }
      return idOf(a).localeCompare(idOf(b));
    });
    return arr;
  },

  /* 汇总封边批次：[{key, material, thickness, count, total(mm), segments[]}]，
     批次按材料名、厚度排序，顺序稳定。orderMode/orders 控制每批内部段序。 */
  batches(lay, orderMode, orders) {
    const segs = this.collectSegments(lay);
    const map = new Map();
    segs.forEach((s) => {
      const key = `${s.material || '未命名材料'}\x1f${s.thickness}`;
      if (!map.has(key)) map.set(key, {
        key, material: s.material || '未命名材料', thickness: s.thickness,
        segments: [],
      });
      map.get(key).segments.push(s);
    });
    const out = [...map.values()].map((b) => {
      const segOrder = this.orderSegments(b.segments, orderMode || 'shortFirst',
        (orders || {})[b.key]);
      const total = segOrder.reduce((t, s) => t + s.length, 0);
      return {
        key: b.key, material: b.material, thickness: b.thickness,
        count: segOrder.length,
        total: Math.round(total * 100) / 100,
        segments: segOrder,
      };
    });
    out.sort((a, b) => a.material.localeCompare(b.material, 'zh') ||
                        a.thickness - b.thickness);
    out.forEach((b, i) => { b.index = i + 1; });
    return out;
  },

  /* 批次颜色（材料+厚度稳定取色，供画布/打印标记封边方向） */
  batchColor(key) {
    let h = 0;
    for (const c of String(key)) h = (h * 31 + c.charCodeAt(0)) % 360;
    return `hsl(${h}, 72%, 42%)`;
  },

  /* 点选零件：四边计算过程（供选中面板展开） */
  edgeCalcRows(p, rotated) {
    const { bw, bh, comp, pw, ph } = this.blankDims(p);
    const blankW = rotated ? bh : bw, blankH = rotated ? bw : bh;
    const prodW = rotated ? ph : pw, prodH = rotated ? pw : ph;
    return {
      bw, bh, pw, ph, blankW, blankH, prodW, prodH, comp,
      edges: this.visualEdges(p, rotated).map(e => ({
        visual: e.key, canonical: e.canonical,
        kind: e.kind, material: e.material, thickness: e.thickness,
        trim: e.trim, banded: e.banded, comp: this.edgeComp(e),
      })),
    };
  },
};
