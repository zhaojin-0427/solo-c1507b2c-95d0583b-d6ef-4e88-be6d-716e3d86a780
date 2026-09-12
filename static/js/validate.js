/* 实时违规校验：重叠 / 越界 / 间距 / 纹理方向（含原料板纹理）/ 定义一致性 */
const Validate = {
  EPS: 1e-6,

  gap() { return (+App.settings.kerf || 0) + (+App.settings.spacing || 0); },
  margin() { return +App.settings.margin || 0; },

  /* 零件纹理与板材纹理是否冲突（双方均指定且不一致） */
  grainConflict(partGrain, sheetGrain) {
    return partGrain && partGrain !== 'none' &&
           sheetGrain && sheetGrain !== 'none' && partGrain !== sheetGrain;
  },
  grainLabel(g) { return { horizontal: '横向', vertical: '纵向' }[g] || '无'; },

  /* 全量校验当前方案，返回 {
       vmap: Map<uid, Set<code>>, dmap: Map<'key:did', [uid...]>, messages: [...] } */
  check() {
    const vmap = new Map();
    const dmap = new Map();
    const messages = [];
    const lay = App.layout();
    if (!lay) return { vmap, dmap, messages };
    const gap = this.gap();
    const margin = this.margin();
    const seenMsg = new Set();

    const flag = (uid, code) => {
      if (!vmap.has(uid)) vmap.set(uid, new Set());
      vmap.get(uid).add(code);
    };
    const flagDefect = (key, did, uid) => {
      const k = key + ':' + did;
      if (!dmap.has(k)) dmap.set(k, []);
      if (dmap.get(k).indexOf(uid) < 0) dmap.get(k).push(uid);
    };
    const say = (uid, code, msg, loc) => {
      if (seenMsg.has(msg)) return;
      seenMsg.add(msg);
      messages.push({ uid, code, msg, loc: loc || null });
    };

    lay.sheets.forEach((si, sheetIdx) => {
      const def = App.sheetDef(si.sheetId) || si;
      const W = +def.width, H = +def.height;
      const ps = si.placements;
      const dkey = App.defectKey(si.sheetId, si.instance);
      const defects = App.defectsOn(si.sheetId, si.instance);

      // 缺陷越界（超出板面）
      defects.forEach((d) => {
        const bb = Defects.bbox(d);
        if (bb && (bb.x < -this.EPS || bb.y < -this.EPS || bb.x1 > W + this.EPS || bb.y1 > H + this.EPS)) {
          say(null, 'defout', `${d.id}（${Defects.TYPES[d.type] || ''}）超出板材 ${si.sheetId} #${si.instance + 1} 板面`,
              { type: 'defect', key: dkey, id: d.id, sheetIndex: sheetIdx });
        }
      });

      ps.forEach((p) => {
        const pd = App.uidPart(p.uid);
        // 越界（含板边留量）
        if (p.x < margin - this.EPS || p.y < margin - this.EPS ||
            p.x + p.w > W - margin + this.EPS || p.y + p.h > H - margin + this.EPS) {
          flag(p.uid, 'bounds');
          say(p.uid, 'bounds', `${p.uid} 超出板材可用区域（四边需留 ${fmtNum(margin)}mm）`,
              { type: 'part', uid: p.uid, sheetIndex: sheetIdx });
        }
        if (!pd) {
          flag(p.uid, 'nodef');
          say(p.uid, 'nodef', `${p.uid} 的零件定义已被删除`);
        } else {
          // 纹理 / 旋转方向（与后端 orientations 规则一致）
          if (p.rotated && !pd.rotatable) {
            flag(p.uid, 'grain');
            say(p.uid, 'grain', `${p.uid}（${pd.name}）设为不可旋转，但当前被旋转`);
          }
          if (pd.grain === 'horizontal' && p.rotated) {
            flag(p.uid, 'grain');
            say(p.uid, 'grain', `${p.uid}（${pd.name}）纹理须水平，禁止旋转`);
          }
          if (pd.grain === 'vertical' && !p.rotated) {
            flag(p.uid, 'grain');
            say(p.uid, 'grain', `${p.uid}（${pd.name}）纹理须垂直，应旋转 90°`);
          }
          // 原料板纹理参与判断
          const sg = def.grain || 'none';
          if (this.grainConflict(pd.grain, sg)) {
            flag(p.uid, 'grain');
            say(p.uid, 'grain', `${p.uid}（${pd.name}）纹理（${this.grainLabel(pd.grain)}）与板材纹理（${this.grainLabel(sg)}）冲突`);
          }
          // 尺寸与定义一致性
          const ow = p.rotated ? +pd.height : +pd.width;
          const oh = p.rotated ? +pd.width : +pd.height;
          if (Math.abs(ow - p.w) > 0.01 || Math.abs(oh - p.h) > 0.01) {
            flag(p.uid, 'size');
            say(p.uid, 'size', `${p.uid} 尺寸与零件定义（${pd.width}×${pd.height}）不符`);
          }
          // 板面缺陷冲突（安全外扩/面别/等级/容许区）
          const hit = Defects.blockingDefect(p, pd, defects);
          if (hit) {
            flag(p.uid, 'defect');
            flagDefect(dkey, hit.id, p.uid);
            say(p.uid, 'defect',
              `${p.uid}（${pd.name}）侵入缺陷 ${Defects.label(hit)} 的避让范围（板材 ${si.sheetId} #${si.instance + 1}）`,
              { type: 'partdefect', uid: p.uid, key: dkey, id: hit.id, sheetIndex: sheetIdx });
          }
        }
      });

      // 两两检查：重叠 / 间距不足
      for (let i = 0; i < ps.length; i++) {
        for (let j = i + 1; j < ps.length; j++) {
          const a = ps[i], b = ps[j];
          const strict = a.x < b.x + b.w - this.EPS && b.x < a.x + a.w - this.EPS &&
                         a.y < b.y + b.h - this.EPS && b.y < a.y + a.h - this.EPS;
          if (strict) {
            flag(a.uid, 'overlap'); flag(b.uid, 'overlap');
            say(a.uid, 'overlap', `${a.uid} 与 ${b.uid} 重叠`);
          } else {
            const near = a.x < b.x + b.w + gap - this.EPS && b.x < a.x + a.w + gap - this.EPS &&
                         a.y < b.y + b.h + gap - this.EPS && b.y < a.y + a.h + gap - this.EPS;
            if (near) {
              flag(a.uid, 'spacing'); flag(b.uid, 'spacing');
              say(a.uid, 'spacing', `${a.uid} 与 ${b.uid} 间距不足（需 ≥ ${fmtNum(gap)}mm）`);
            }
          }
        }
      }
    });
    return { vmap, dmap, messages };
  },

  /* 拖拽过程中的快速校验：候选位置是否合法（越界 / 间距 / 重叠 / 板材纹理 / 缺陷） */
  checkPlacement(sheetIdx, uid, x, y, w, h) {
    const lay = App.layout();
    if (!lay || !lay.sheets[sheetIdx]) return false;
    const si = lay.sheets[sheetIdx];
    const def = App.sheetDef(si.sheetId) || si;
    const W = +def.width, H = +def.height;
    const m = this.margin(), gap = this.gap();
    // 原料板纹理与零件纹理冲突 → 该板不可放
    const pd = App.uidPart(uid);
    if (pd && this.grainConflict(pd.grain, def.grain || 'none')) return false;
    if (x < m - this.EPS || y < m - this.EPS ||
        x + w > W - m + this.EPS || y + h > H - m + this.EPS) return false;
    for (const p of si.placements) {
      if (p.uid === uid) continue;
      if (x < p.x + p.w + gap - this.EPS && p.x < x + w + gap - this.EPS &&
          y < p.y + p.h + gap - this.EPS && p.y < y + h + gap - this.EPS) return false;
    }
    // 缺陷避让
    if (pd && Defects.blockingDefect({ x, y, w, h, rotated: Math.abs(w - pd.width) > 0.01 },
                                     pd, App.defectsOn(si.sheetId, si.instance))) return false;
    return true;
  },
};
