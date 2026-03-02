/**
 * 鱼骨图布局计算模块
 * 负责：尺寸计算、坐标定位、画布边界计算等
 */

// ═══════════════════════════════════════════════════════════
// 常量配置
// ═══════════════════════════════════════════════════════════
export const LINE_CHARS = 10            // 每行最多字符数（超过则换行）
export const BIG_GAP   = 100   // 大骨最小宽度
export const DIAG      = 150   // 大骨斜线的默认长度（无中骨时）
export const MID_LEN   = 90    // 中骨水平线长度
export const PAIR_GAP  = 60    // 同组上下两根大骨的主骨线间距
export const PAD_L     = 30    // 画布左侧留白
export const TAIL      = 50    // 鱼尾到主骨线起点的距离
export const CY        = 350   // 主骨线的 Y 坐标（画布上的垂直中心）
export const EMPTY_MAIN_LEN = 100   // 空图时主骨线长度

// 方框尺寸常量
const SM_BOX_MIN_W = 60,  SM_BOX_H = 24, SM_GAP_Y = 8   // 小骨方框
const MID_BOX_MIN_W = 80, MID_BOX_H = 24                 // 中骨方框
const BIG_BOX_MIN_W = 100, BIG_BOX_H = 32                 // 大骨方框
const SM_LINK_LEN = 40    // 小骨到中骨方框的连线长度
const GROUP_GAP = 30             // 相邻大骨组之间的基础间距
const HEAD_TO_FIRST_BONE = 0 // 鱼头到第一组大骨节点的固定距离（极大缩短）

/**
 * 布局计算入口函数
 * @param {Object} fishData - 鱼骨图数据
 * @returns {Object} 布局结果 { slots, canvasW, canvasH, shiftedMainEnd, cy, shiftX, shiftY, fishScale, ... }
 */
export function calculateLayout(fishData) {
  // ═══════════════════════════════════════════════════════════
  // 11a. 方框尺寸常量（内部使用）
  // ═══════════════════════════════════════════════════════════════════
  const SM_BOX_MIN_Wi = 60,  SM_BOX_Hi = 24, SM_GAP_Yi = 8
  const MID_BOX_MIN_Wi = 80, MID_BOX_Hi = 24
  const BIG_BOX_MIN_Wi = 100, BIG_BOX_Hi = 32

  // ═══════════════════════════════════════════════════════════
  // 11b. 尺寸计算辅助函数
  // ═══════════════════════════════════════════════════════════

  /** 单个小骨方框高度（超过 LINE_CHARS 则增高） */
  function smBoxH(sm) {
    return sm.label.length > LINE_CHARS ? SM_BOX_Hi * 1.8 : SM_BOX_Hi
  }

  /** 一根中骨下所有小骨的总高度（含间距） */
  function totalSmallBonesH(m) {
    if (m.smallBones.length === 0) return 0
    let h = 0
    for (let j = 0; j < m.smallBones.length; j++) {
      if (j > 0) h += SM_GAP_Yi
      h += smBoxH(m.smallBones[j])
    }
    return h
  }

  /**
   * 中骨沿大骨斜线方向占用的间距。
   * 需要足够容纳该中骨的小骨群垂直高度。
   * 因为斜线是 45°，Y轴间距 = span/√2，所以 span 要乘以 √2 补偿。
   */
  function midBoneSpan(m) {
    const smH = totalSmallBonesH(m)
    const needed = Math.max(MID_BOX_Hi + 20, smH + MID_BOX_Hi)
    return Math.ceil(needed * Math.SQRT2)
  }

  /** 大骨斜线顶端（靠近主骨侧）给大骨标签留的空间 */
  function calcHeadMargin(b) {
    if (b.midBones.length === 0) return 80
    return Math.max(80, BIG_BOX_Hi + 40)
  }

  /**
   * 大骨斜线总长度 = 顶端留白 + 所有中骨间距之和 + 底端留白。
   */
  function calcDiag(b) {
    if (b.midBones.length === 0) return DIAG
    const headMargin = calcHeadMargin(b)
    const tailMargin = 50
    let total = headMargin
    for (const m of b.midBones) total += midBoneSpan(m)
    total += tailMargin
    return Math.max(DIAG, total)
  }

  function midLen() { return MID_LEN }

  /**
   * 动态计算中骨横向长度。
   * 根据该中骨下小骨的总高度动态调整，避免小骨与中骨碰撞。
   * 小骨越多，中骨需要横向延伸更长。
   */
  function calcDynamicMidLen(m) {
    const smH = totalSmallBonesH(m)
    if (smH === 0) return MID_LEN
    // 小骨高度的一半作为额外需要避让的距离
    const extra = smH / 2
    return MID_LEN + extra
  }

  /** 根据文字计算方框宽度（至少 minW，最多 LINE_CHARS 个字一行） */
  function calcBoxW(text, minW, fs = 11) {
    const len = text.length
    const lineW = Math.min(len, LINE_CHARS) * (fs * 1.1) + 24
    return Math.max(minW, lineW)
  }

  function smBoxW(sm)  { return calcBoxW(sm.label, SM_BOX_MIN_Wi, 18) }
  function midBoxW(m)  { return calcBoxW(m.label, MID_BOX_MIN_Wi, 20) }
  function bigBoxW(b)  { return calcBoxW(b.label, BIG_BOX_MIN_Wi, 24) }

  /** 一根中骨下所有小骨方框的最大宽度 */
  function maxSmBoxW(m) {
    if (m.smallBones.length === 0) return 0
    let mx = SM_BOX_MIN_Wi
    for (const sm of m.smallBones) mx = Math.max(mx, smBoxW(sm))
    return mx
  }

  /**
   * 大骨从主骨交点(bx)向左延伸的最大距离。
   */
  function boneLeftExtent(b) {
    const dynamicDiag = calcDiag(b)
    const dd = dynamicDiag / Math.SQRT2
    let maxLeft = dd + 80
    let accumOff = calcHeadMargin(b)
    for (const m of b.midBones) {
      const span = midBoneSpan(m)
      const centerOff = accumOff + span / 2
      accumOff += span
      const t = centerOff / dynamicDiag
      const axOff = dd * t
      const ml = calcDynamicMidLen(m)
      const mw = midBoxW(m)
      let leftFromBx = axOff + ml + mw + 10
      if (m.smallBones.length > 0) leftFromBx += SM_LINK_LEN + maxSmBoxW(m) + 10
      maxLeft = Math.max(maxLeft, leftFromBx)
    }
    return maxLeft
  }

  function boneW(b) {
    return Math.max(BIG_GAP, boneLeftExtent(b) + 40)
  }

  // ═══════════════════════════════════════════════════════════
  // 11c. 大骨分组 & 主骨线布局
  // ═══════════════════════════════════════════════════════════
  const groups = []
  for (let i = 0; i < fishData.bigBones.length; i += 2) {
    const top = fishData.bigBones[i]
    const bot = fishData.bigBones[i + 1] || null
    groups.push({ top, bot })
  }

  const groupWidths = groups.map(g => {
    const wTop = boneW(g.top)
    const wBot = g.bot ? boneW(g.bot) : 0
    return { g, w: Math.max(wTop, wBot) + (g.bot ? PAIR_GAP : 0) }
  })

  const tailSafeRight = PAD_L + TAIL + 50

  // 计算每组相对于第一组的向左偏移量
  const relOffsets = []
  let cursor = 0
  for (let gi = 0; gi < groupWidths.length; gi++) {
    const { g } = groupWidths[gi]
    if (gi === 0) {
      relOffsets.push(0)
      const topExt = boneLeftExtent(g.top)
      const botExt = g.bot ? boneLeftExtent(g.bot) + PAIR_GAP : 0
      cursor = Math.max(topExt, botExt) + GROUP_GAP
    } else {
      const dd = calcDiag(g.top) / Math.SQRT2
      const ddBot = g.bot ? calcDiag(g.bot) / Math.SQRT2 : 0
      const rightHalf = Math.max(dd, ddBot) * 0.2 + 20
      const off = cursor + rightHalf
      relOffsets.push(off)
      const topExt = boneLeftExtent(g.top)
      const botExt = g.bot ? boneLeftExtent(g.bot) + PAIR_GAP : 0
      cursor = off + Math.max(topExt, botExt) + GROUP_GAP
    }
  }

  // 确定第一组 top 节点的绝对 X
  // 需要确保最左侧大骨的中骨/小骨文字框与鱼尾保持固定间距 50px
  const TAIL_GAP = 150  // 左侧第一组大骨的中骨/小骨文字框与鱼尾的固定间距
  let firstBoneX = tailSafeRight
  for (let gi = 0; gi < groups.length; gi++) {
    const g = groups[gi]
    const topExt = boneLeftExtent(g.top)
    const botExt = g.bot ? boneLeftExtent(g.bot) + PAIR_GAP : 0
    const needed = relOffsets[gi] + Math.max(topExt, botExt)
    
    // 确保第一组大骨的中骨/小骨文字框与鱼尾保持固定间距 50px
    // 文字框左边界 = bx - boneLeftExtent(b)，需要 >= tailSafeRight + TAIL_GAP
    if (gi === 0) {
      // 需要同时考虑 top 和 bot 大骨的 leftExtent，确保两者都有足够空间
      const minFirstBoneX = tailSafeRight + TAIL_GAP + Math.max(topExt, botExt)
      firstBoneX = Math.max(firstBoneX, minFirstBoneX)
    } else {
      // 所有组都需要与鱼尾保持固定间距
      firstBoneX = Math.max(firstBoneX, tailSafeRight + TAIL_GAP + needed)
    }
  }

  let mainEnd = fishData.bigBones.length === 0
    ? PAD_L + TAIL + EMPTY_MAIN_LEN
    : firstBoneX + HEAD_TO_FIRST_BONE

  const slots = []
  for (let gi = 0; gi < groups.length; gi++) {
    const g = groups[gi]
    const topX = firstBoneX - relOffsets[gi]
    slots.push({ b: g.top, x: topX, w: groupWidths[gi].w })
    if (g.bot) {
      slots.push({ b: g.bot, x: topX - PAIR_GAP, w: groupWidths[gi].w })
    }
  }

  // ═══════════════════════════════════════════════════════════
  // 11d. 计算画布边界（遍历所有骨骼找极值）
  // ═══════════════════════════════════════════════════════════
  let xMin = PAD_L - 20, xMax = mainEnd + 20
  let yMin = CY, yMax = CY

  for (const slot of slots) {
    const { b, x: bx } = slot
    const dir = b.position === 'top' ? -1 : 1
    const dynamicDiag = calcDiag(b)
    const dd = dynamicDiag / Math.SQRT2
    const ex = bx - dd
    const ey = CY + dir * dd
    yMin = Math.min(yMin, ey - 80)
    yMax = Math.max(yMax, ey + 80)
    xMin = Math.min(xMin, ex - 80)
    xMax = Math.max(xMax, bx + 80)

    let accumOff = calcHeadMargin(b)
    for (const m of b.midBones) {
      const span = midBoneSpan(m)
      const centerOff = accumOff + span / 2
      accumOff += span
      const t = centerOff / dynamicDiag
      const ax = bx + (ex - bx) * t
      const ay = CY + (ey - CY) * t
      const ml = calcDynamicMidLen(m)
      const mex = ax - ml
      const mw = midBoxW(m)
      const midBoxXCalc = mex - mw
      xMin = Math.min(xMin, midBoxXCalc - 60, ax - 60)
      xMax = Math.max(xMax, ax + 60)
      yMin = Math.min(yMin, ay - 60)
      yMax = Math.max(yMax, ay + 60)

      if (m.smallBones.length > 0) {
        const tSmH = totalSmallBonesH(m)
        yMin = Math.min(yMin, ay - tSmH / 2 - 20)
        yMax = Math.max(yMax, ay + tSmH / 2 + 20)
        xMin = Math.min(xMin, midBoxXCalc - SM_LINK_LEN - maxSmBoxW(m) - 20)
      }
    }
  }

  // 如果有元素超出左侧/上侧，整体平移画布
  const shiftX = xMin < tailSafeRight ? tailSafeRight - xMin : 0
  const shiftY = yMin < 0 ? -yMin + 40 : 0
  let shiftedMainEnd = mainEnd + shiftX
  
  // 关键：不使用 rightmost 推远 shiftedMainEnd，让鱼头更靠近最后的大骨节点
  // const rightmost = xMax + shiftX + 20
  // if (rightmost > shiftedMainEnd) shiftedMainEnd = rightmost
  const cy = CY + shiftY

  // ═══════════════════════════════════════════════════════════
  // 11e. 鱼头鱼尾动态缩放
  // ═══════════════════════════════════════════════════════════
  const FISH_SCALE_BASE = 1.6
  const FISH_SCALE_MAX  = 2.5
  const totalMidCount = fishData.bigBones.reduce((sum, b) => sum + b.midBones.length, 0)
  const FISH_SCALE = Math.min(FISH_SCALE_MAX, FISH_SCALE_BASE + totalMidCount * 0.12)

  // ═══════════════════════════════════════════════════════════
  // 11f. 计算画布尺寸
  // ═══════════════════════════════════════════════════════════
  const PAD = 40
  const HEAD_SVG_W = 120 * FISH_SCALE, HEAD_SVG_H = 120 * FISH_SCALE
  const TAIL_SVG_W = 120 * FISH_SCALE, TAIL_SVG_H = 120 * FISH_SCALE

  const canvasW = Math.max(shiftedMainEnd + HEAD_SVG_W + 40, 900)
  const canvasH = Math.max(yMax + shiftY + PAD, Math.max(TAIL_SVG_H, HEAD_SVG_H) + 100, 700)

  // ═══════════════════════════════════════════════════════════
  // 返回布局结果
  // ═══════════════════════════════════════════════════════════
  return {
    // 布局常量
    SM_BOX_MIN_W: SM_BOX_MIN_Wi,
    SM_BOX_H: SM_BOX_Hi,
    SM_GAP_Y: SM_GAP_Yi,
    MID_BOX_MIN_W: MID_BOX_MIN_Wi,
    MID_BOX_H: MID_BOX_Hi,
    BIG_BOX_MIN_W: BIG_BOX_MIN_Wi,
    BIG_BOX_H: BIG_BOX_Hi,
    SM_LINK_LEN,
    MID_BOX_MIN_Wi,
    // 辅助函数
    smBoxH,
    totalSmallBonesH,
    midBoneSpan,
    calcHeadMargin,
    calcDiag,
    smBoxW,
    midBoxW,
    bigBoxW,
    maxSmBoxW,
    midLen,
    calcDynamicMidLen,
    // 布局结果
    slots,
    canvasW,
    canvasH,
    shiftedMainEnd,
    cy,
    shiftX,
    shiftY,
    FISH_SCALE,
    fishScale: FISH_SCALE,  // 兼容别名
    HEAD_SVG_W,
    HEAD_SVG_H,
    TAIL_SVG_W,
    TAIL_SVG_H,
  }
}

/**
 * 计算大骨在斜线上的锚点坐标
 */
export function getBigBoneAnchor(bx, cy, b, calcDiag) {
  const dynamicDiag = calcDiag(b)
  const dd = dynamicDiag / Math.SQRT2
  const dir = b.position === 'top' ? -1 : 1
  const sx = bx, sy = cy
  const ex = bx - dd, ey = cy + dir * dd
  return { sx, sy, ex, ey, dd, dir, dynamicDiag }
}

/**
 * 计算中骨在斜线上的锚点坐标
 */
export function getMidBoneAnchor(bx, cy, b, m, layout) {
  const { calcDiag, calcHeadMargin, midBoneSpan, midLen, midBoxW, smBoxW, totalSmallBonesH, smBoxH, SM_GAP_Y, maxSmBoxW } = layout
  
  const dynamicDiag = calcDiag(b)
  const dir = b.position === 'top' ? -1 : 1
  const dd = dynamicDiag / Math.SQRT2
  const sx = bx, sy = cy
  const ex = bx - dd, ey = cy + dir * dd

  let accumOffset = calcHeadMargin(b)
  const midIndex = b.midBones.indexOf(m)
  for (let i = 0; i < midIndex; i++) {
    accumOffset += midBoneSpan(b.midBones[i])
  }
  
  const span = midBoneSpan(m)
  const centerOffset = accumOffset + span / 2
  const t = centerOffset / dynamicDiag
  const ax = sx + (ex - sx) * t
  const ay = sy + (ey - sy) * t

  return { ax, ay, t, dynamicMidLen: calcDynamicMidLen(m), mex: ax - calcDynamicMidLen(m) }
}
