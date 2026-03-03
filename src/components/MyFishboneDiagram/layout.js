// 布局常量
export const LINE_CHARS = 10       // 每行最多字符数，超过换行
export const BIG_GAP = 100         // 大骨最小宽度
export const DIAG = 150            // 大骨斜线默认长度
export const MID_LEN = 90          // 中骨水平线默认长度
export const PAIR_GAP = 60         // 上下两根大骨的间距
export const PAD_L = 70            // 画布左侧留白
export const TAIL = 50             // 鱼尾到主骨线的距离
export const CY = 350              // 主骨线 Y 坐标
export const EMPTY_OFFSET_X = -250 // 空图时整体偏移
export const BTN_SIZE = 20        // 加号按钮尺寸

// 计算布局入口
export function calculateLayout(fishData) {
  const isEmpty = !fishData.bigBones || fishData.bigBones.length === 0

  // 内部常量
  const SM_BOX_H = 24, SM_GAP_Y = 8   // 小骨方框高度、间距
  const MID_BOX_H = 24                  // 中骨方框高度
  const BIG_BOX_H = 32                  // 大骨方框高度
  const SM_LINK_LEN = 40                // 小骨连线长度
  const GROUP_GAP = 30                   // 大骨组间距

  // 小骨方框高度，超过10字换行时增高
  function smBoxH(sm) {
    return sm.label.length > LINE_CHARS ? SM_BOX_H * 1.8 : SM_BOX_H
  }

  // 中骨方框高度，超过10字换行时增高
  function midBoxH(m) {
    return m.label.length > LINE_CHARS ? MID_BOX_H * 1.8 : MID_BOX_H
  }

  // 大骨方框高度，超过10字换行时增高
  function bigBoxH(b) {
    return b.label.length > LINE_CHARS ? BIG_BOX_H * 1.8 : BIG_BOX_H
  }

  // 中骨下所有小骨的总高度
  function totalSmallBonesH(m) {
    if (m.smallBones.length === 0) return 0
    let h = 0
    for (let j = 0; j < m.smallBones.length; j++) {
      if (j > 0) h += SM_GAP_Y
      h += smBoxH(m.smallBones[j])
    }
    return h
  }

  // 中骨沿斜线方向占用的间距
  function midBoneSpan(m) {
    const midH = midBoxH(m)
    const smH = totalSmallBonesH(m)
    const needed = Math.max(midH + 20, smH + midH)
    return Math.ceil(needed * Math.SQRT2)
  }

  // 大骨斜线顶端留白
  function calcHeadMargin(b) {
    const bigH = bigBoxH(b)
    if (b.midBones.length === 0) return Math.max(80, bigH + 40)
    return Math.max(80, bigH + 40)
  }

  // 大骨斜线总长度
  function calcDiag(b) {
    if (b.midBones.length === 0) return DIAG
    const headMargin = calcHeadMargin(b)
    const tailMargin = 50
    let total = headMargin
    for (const m of b.midBones) total += midBoneSpan(m)
    total += tailMargin
    return Math.max(DIAG, total)
  }

  // 动态计算中骨横向长度（至少要能容纳中骨方框宽度，字体大小14对应渲染时的字体大小）
  function calcDynamicMidLen(m) {
    const smH = totalSmallBonesH(m)
    const boxW = calcBoxW(m.label, 14)
    const baseLen = Math.max(MID_LEN, boxW) + 5
    if (smH === 0) return baseLen
    return baseLen + smH / 2
  }

  // 根据文字计算方框宽度
  function calcBoxW(text, fs = 11) {
    const len = text.length
    const lineW = Math.min(len, LINE_CHARS) * (fs * 1.0) + 20
    return Math.max(lineW, 80)
  }

  function smBoxW(sm) { return calcBoxW(sm.label, 12) }
  function midBoxW(m) { return calcBoxW(m.label, 14) }  // 使用14，与渲染时的字体大小一致
  function bigBoxW(b) { return calcBoxW(b.label, 14) }

  // 中骨下所有小骨方框的最大宽度
  function maxSmBoxW(m) {
    if (m.smallBones.length === 0) return 0
    let mx = 0
    for (const sm of m.smallBones) mx = Math.max(mx, smBoxW(sm))
    return mx
  }

  // 大骨从主骨交点向左延伸的最大距离
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

  // 大骨宽度
  function boneW(b) {
    return Math.max(BIG_GAP, boneLeftExtent(b) + 40)
  }

  // 大骨分组，每组最多上下两根
  const groups = []
  for (let i = 0; i < fishData.bigBones.length; i += 2) {
    const top = fishData.bigBones[i]
    const bot = fishData.bigBones[i + 1] || null
    groups.push({ top, bot })
  }

  // 计算每组宽度
  const groupWidths = groups.map(g => {
    const wTop = boneW(g.top)
    const wBot = g.bot ? boneW(g.bot) : 0
    return { g, w: Math.max(wTop, wBot) + (g.bot ? PAIR_GAP : 0) }
  })

  const tailSafeRight = PAD_L + TAIL + 50

  // 计算每组相对偏移
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

  // 第一根大骨的 X 坐标
  const TAIL_GAP = 150
  let firstBoneX = tailSafeRight
  for (let gi = 0; gi < groups.length; gi++) {
    const g = groups[gi]
    const topExt = boneLeftExtent(g.top)
    const botExt = g.bot ? boneLeftExtent(g.bot) + PAIR_GAP : 0
    const needed = relOffsets[gi] + Math.max(topExt, botExt)
    if (gi === 0) {
      const minFirstBoneX = tailSafeRight + TAIL_GAP + Math.max(topExt, botExt)
      firstBoneX = Math.max(firstBoneX, minFirstBoneX)
    } else {
      firstBoneX = Math.max(firstBoneX, tailSafeRight + TAIL_GAP + needed)
    }
  }

  let mainEnd = firstBoneX
  if (isEmpty) mainEnd += 50

  // 生成槽位信息
  const slots = []
  for (let gi = 0; gi < groups.length; gi++) {
    const g = groups[gi]
    const topX = firstBoneX - relOffsets[gi]
    slots.push({ b: g.top, x: topX, w: groupWidths[gi].w })
    if (g.bot) {
      slots.push({ b: g.bot, x: topX - PAIR_GAP, w: groupWidths[gi].w })
    }
  }

  // 计算画布边界
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

  // 整体偏移
  let shiftX = xMin < tailSafeRight ? tailSafeRight - xMin : 0
  const shiftY = yMin < 0 ? -yMin + 40 : 0

  const shiftedMainEnd = mainEnd + shiftX
  const cy = CY + shiftY

  // 鱼头鱼尾缩放
  const FISH_SCALE_BASE = isEmpty ? 2.0 : 1.6
  const FISH_SCALE_MAX = 2.5
  const totalMidCount = fishData.bigBones.reduce((sum, b) => sum + b.midBones.length, 0)
  const FISH_SCALE = Math.min(FISH_SCALE_MAX, FISH_SCALE_BASE + totalMidCount * 0.12)

  const PAD = 40
  const HEAD_SVG_W = 120 * FISH_SCALE, HEAD_SVG_H = 120 * FISH_SCALE
  const TAIL_SVG_W = 120 * FISH_SCALE, TAIL_SVG_H = 120 * FISH_SCALE

  const canvasW = Math.max(shiftedMainEnd + HEAD_SVG_W + 40, 900)
  const canvasH = Math.max(yMax + shiftY + PAD, Math.max(TAIL_SVG_H, HEAD_SVG_H) + 100, 700)

  return {
    SM_BOX_H,
    SM_GAP_Y,
    MID_BOX_H,
    BIG_BOX_H,
    SM_LINK_LEN,
    smBoxH,
    midBoxH,
    bigBoxH,
    totalSmallBonesH,
    midBoneSpan,
    calcHeadMargin,
    calcDiag,
    smBoxW,
    midBoxW,
    bigBoxW,
    maxSmBoxW,
    calcDynamicMidLen,
    slots,
    canvasW,
    canvasH,
    shiftedMainEnd,
    cy,
    shiftX,
    shiftY,
    FISH_SCALE,
    HEAD_SVG_W,
    HEAD_SVG_H,
    TAIL_SVG_W,
    TAIL_SVG_H,
  }
}
