<!--
  鱼骨图组件 (Fishbone / Ishikawa Diagram)
  ==========================================
  整体架构:
    1. 数据层 (fishData)     — 用 reactive 存储三级树形数据: 大骨 → 中骨 → 小骨
    2. 布局计算 (renderGraph) — 每次数据变化后，根据骨的数量动态计算坐标，然后用 AntV X6 绘制线条和节点
    3. 编辑覆盖层 (editOverlays) — 编辑模式下，用 HTML input 覆盖在 X6 节点上方，实现原位编辑和删除
    4. 鱼头鱼尾 (fish-part)  — 用 HTML+SVG overlay 绘制，鱼头支持文字编辑

  渲染流程:
    用户操作(增/删/改) → 修改 fishData → 调用 renderGraph() → 销毁旧 Graph → 重新计算布局 → 创建新 Graph → 绘制所有元素

  拖拽平移方案:
    .fishbone-viewport — 外层容器 (overflow: hidden, 捕获鼠标拖拽事件)
      .fishbone-world — 内层世界容器 (trFISH_SCALEansform: translate 平移，包裹所有内容)
        .fishbone-canvas — X6 画布挂载点
        鱼头/鱼尾/编辑overlay — 都在 world 内，跟随 transform 一起移动
-->
<script setup>
import { ref, reactive, onMounted, onBeforeUnmount, nextTick } from 'vue'
import { Graph } from '@antv/x6'
import { IconZoomIn, IconZoomOut, IconOriginalSize } from '@arco-design/web-vue/es/icon'

const emit = defineEmits(['confirm', 'cancel'])

function init() {
  needsCenter = true
  const tryRender = () => {
    const c = containerRef.value
    const vp = viewportRef.value
    if (c && vp && vp.clientHeight > 0) {
      renderGraph()
    } else {
      setTimeout(tryRender, 60)
    }
  }
  nextTick(tryRender)
}

defineExpose({ init })

// ============================== DOM 引用 ==============================
const containerRef = ref(null)
const viewportRef = ref(null)
const worldRef = ref(null)
let graph = null
let needsCenter = true
const callbackMap = {}

// ============================== 拖拽平移 + 滚轮缩放 ==============================
const panX = ref(0)
const panY = ref(0)
const scale = ref(1)
const SCALE_MIN = 0.3
const SCALE_MAX = 2
let isPanning = false
let panStartX = 0
let panStartY = 0
let panOriginX = 0
let panOriginY = 0
let didDrag = false

function onPointerDown(e) {
  if (e.target.closest('.inline-edit-wrap') || e.target.closest('.fish-head-input')) return
  isPanning = true
  didDrag = false
  panStartX = e.clientX
  panStartY = e.clientY
  panOriginX = panX.value
  panOriginY = panY.value
  viewportRef.value.style.cursor = 'grabbing'
}
function onPointerMove(e) {
  if (!isPanning) return
  const dx = e.clientX - panStartX
  const dy = e.clientY - panStartY
  if (Math.abs(dx) > 3 || Math.abs(dy) > 3) didDrag = true
  panX.value = panOriginX + dx
  panY.value = panOriginY + dy
}

function onPointerUp() {
  if (!isPanning) return
  isPanning = false
  if (viewportRef.value) viewportRef.value.style.cursor = ''
}

function onWheel(e) {
  e.preventDefault()
  const rect = viewportRef.value.getBoundingClientRect()
  // 鼠标在视口内的坐标
  const mx = e.clientX - rect.left
  const my = e.clientY - rect.top
  const oldScale = scale.value
  const delta = e.deltaY > 0 ? -0.08 : 0.08
  const newScale = Math.min(SCALE_MAX, Math.max(SCALE_MIN, oldScale + delta))
  // 以鼠标位置为锚点：缩放前后鼠标指向的世界坐标不变
  panX.value = mx - (mx - panX.value) * (newScale / oldScale)
  panY.value = my - (my - panY.value) * (newScale / oldScale)
  scale.value = newScale
}
// ============================== 模式切换 ==============================
// 'edit' 模式: 标签变成 input 可编辑，显示 "+" 按钮和 "×" 删除按钮
// 'view' 模式: 标签由 X6 节点渲染，只读
const mode = ref('edit')

// ============================== 编辑覆盖层 ==============================
// 编辑模式下，每个骨的标签不走 X6 节点渲染，而是收集到这个数组里，
// 然后在 template 中用 v-for 渲染为 HTML input，叠加在画布上方。
// 每项包含: { id, x, y, w, h, boneRef(指向数据对象), bg, border, fg, fs, fw, rx, delInfo, boneType }
const editOverlays = ref([])

// 失焦时重绘，因为文本长度可能影响布局
function onOverlayBlur(overlay) {
  renderGraph()
}

// ============================== 删除后重平衡 ==============================
// 删除某条骨后，剩余的骨需要重新交替分配方向（上/下 或 左/右），
// 避免出现一侧有 2 条而另一侧 0 条的不平衡情况。
function rebalanceSides(arr, key, values) {
  arr.forEach((item, i) => {
    item[key] = values[i % values.length]
  })
}

function deleteBone(delInfo) {
  if (!delInfo) return
  const { type, bigId, midId, smId } = delInfo
  if (type === 'big') {
    const idx = fishData.bigBones.findIndex((b) => b.id === bigId)
    if (idx >= 0) fishData.bigBones.splice(idx, 1)
    rebalanceSides(fishData.bigBones, 'position', ['top', 'bottom'])
  } else if (type === 'mid') {
    const big = fishData.bigBones.find((b) => b.id === bigId)
    if (!big) return
    const idx = big.midBones.findIndex((m) => m.id === midId)
    if (idx >= 0) big.midBones.splice(idx, 1)
    rebalanceSides(big.midBones, 'side', ['left', 'right'])
  } else if (type === 'small') {
    const big = fishData.bigBones.find((b) => b.id === bigId)
    if (!big) return
    const mid = big.midBones.find((m) => m.id === midId)
    if (!mid) return
    const idx = mid.smallBones.findIndex((s) => s.id === smId)
    if (idx >= 0) mid.smallBones.splice(idx, 1)
    rebalanceSides(mid.smallBones, 'position', ['top', 'bottom'])
  }
  renderGraph()
}
// ============================== 数据层 ==============================
// 三级树形结构:
//   fishData.bigBones[] — 大骨数组
//     ├── id, label, position('top'|'bottom')
//     └── midBones[] — 中骨数组
//           ├── id, label, side('left'|'right')
//           └── smallBones[] — 小骨数组
//                 └── id, label, position('top'|'bottom')
let idSeq = 0
const genId = () => `n_${++idSeq}`
const fishData = reactive({ bigBones: [] })
const headLabel = ref('问题详情')
const headEditing = ref(false)
const headInputRef = ref(null)
function startHeadEdit() {
  headEditing.value = true
  nextTick(() => { headInputRef.value?.focus() })
}

function addBigBone() {
  const n = fishData.bigBones.length
  fishData.bigBones.unshift({
    id: genId(),
    label: `大骨 ${n + 1}`,
    position: n % 2 === 0 ? 'top' : 'bottom',
    midBones: [],
  })
  renderGraph()
}

function addMidBone(bigId) {
  const b = fishData.bigBones.find((x) => x.id === bigId)
  if (!b) return
  const n = b.midBones.length
  b.midBones.push({
    id: genId(),
    label: `中骨 ${n + 1}`,
    side: n % 2 === 0 ? 'left' : 'right',
    smallBones: [],
  })
  renderGraph()
}

const MAX_SMALL_BONES = 5

function addSmallBone(bigId, midId) {
  const b = fishData.bigBones.find((x) => x.id === bigId)
  if (!b) return
  const m = b.midBones.find((x) => x.id === midId)
  if (!m) return
  if (m.smallBones.length >= MAX_SMALL_BONES) return
  const n = m.smallBones.length
  m.smallBones.push({
    id: genId(),
    label: `小骨 ${n + 1}`,
    position: n % 2 === 0 ? 'top' : 'bottom',
  })
  renderGraph()
}

// ============================== 鱼头鱼尾位置 ==============================
const headPos = reactive({ x: 0, y: 0, w: 0, h: 0 })
const tailPos = reactive({ x: 0, y: 0, w: 0, h: 0 })
// ============================== 布局常量 ==============================
const CY = 350 // 垂直中线Y坐标
const TAIL = 50 // 鱼尾长度
const PAD_L = 70 // 左侧内边距
const BIG_GAP = 100 // 大骨垂直间距
const DIAG = 150 // 大骨斜向长度
const MID_LEN = 90 // 中骨基础长度
const SM_LEN = 42 // 小骨基础长度
const BTN = 24 // 加号按钮尺寸

// ============================== X6 绘制辅助函数 ==============================

function addEdge(s, t, color, w, arrow = false) {
  const none = { tagName: 'path', d: '' }
  const arrowMarker = {
    tagName: 'path',
    d: 'M 10 -6 L 0 0 L 10 6 Z',
    fill: color,
    stroke: 'none',
    cursor: 'default',
  }
  graph.addEdge({
    shape: 'edge',
    source: { x: s[0], y: s[1] },
    target: { x: t[0], y: t[1] },
    attrs: {
      line: {
        stroke: color,
        strokeWidth: w,
        strokeLinecap: 'round',
        targetMarker: none,
        sourceMarker: arrow ? arrowMarker : none,
      },
    },
  })
}

function addLabelNode(
  id,
  x,
  y,
  w,
  h,
  text,
  bg,
  border,
  fg,
  fs = 12,
  fw = 500,
  rx = 4,
  boneRef = null,
  delInfo = null,
) {
  const boneType = delInfo?.type || ''
  if (mode.value === 'edit' && boneRef) {
    editOverlays.value.push({
      id,
      x,
      y,
      w,
      h,
      boneRef,
      bg,
      border,
      fg,
      fs,
      fw,
      rx,
      delInfo,
      boneType,
    })
  } else {
    graph.addNode({
      id,
      shape: 'rect',
      x,
      y,
      width: w,
      height: h,
      attrs: {
        body: { fill: bg, stroke: border, strokeWidth: 1.2, rx, ry: rx },
        label: {
          text,
          fill: fg,
          fontSize: fs,
          fontWeight: fw,
          textWrap: { width: w - 12, height: h, ellipsis: true },
        },
      },
    })
  }
}

function addBtn(id, x, y, color, tip, fn, size) {
  if (mode.value !== 'edit') return
  const s = size || BTN
  callbackMap[id] = fn
  graph.addNode({
    id,
    shape: 'rect',
    x,
    y,
    width: s,
    height: s,
    attrs: {
      body: { fill: color, stroke: '#fff', strokeWidth: 1.5, rx: 4, ry: 4, cursor: 'pointer' },
      label: {
        text: '+',
        fill: '#fff',
        fontSize: s === BTN ? 16 : 13,
        fontWeight: 'bold',
        cursor: 'pointer',
      },
    },
  })
}

// ============================== 核心渲染函数 ==============================
function renderGraph() {
  if (!viewportRef.value) return

  // --- 1. 清理旧状态 ---
  if (graph) graph.dispose()
  containerRef.value.innerHTML = ''
  Object.keys(callbackMap).forEach((k) => delete callbackMap[k])
  editOverlays.value = []

  // --- 2. 布局计算 ---
  // 每个小骨在大骨斜线方向上占用的长度（控制大骨线增长幅度）
  function midBoneSpan(m) {
    return Math.max(60, m.smallBones.length * 22 + 30)
  }
  function calcDiag(b) {
    if (b.midBones.length === 0) return DIAG
    let total = 70
    for (const m of b.midBones) total += midBoneSpan(m)
    total += 40
    return Math.max(DIAG, total)
  }
  function midLen(m) {
    return MID_LEN + m.smallBones.length * 50
  }
  function boneW(b) {
    const diagDx = calcDiag(b) / Math.SQRT2
    let mw = 0
    for (const m of b.midBones) mw = Math.max(mw, midLen(m) + 80)
    return Math.max(BIG_GAP, diagDx + 80, mw + 80)
  }

  const boneWidths = fishData.bigBones.map((b) => ({ b, w: boneW(b) }))

  let totalBoneW = 0
  for (const bw of boneWidths) totalBoneW += bw.w

  const TAIL_MARGIN = 80   // 大骨区域左侧距鱼尾的安全距离（需覆盖中骨向左延伸）
  const HEAD_MARGIN = 20   // 大骨区域右侧距鱼头的间距（减小鱼头与大骨的空隙）

  const boneStartX = PAD_L + TAIL + TAIL_MARGIN
  const mainEnd = boneStartX + totalBoneW + HEAD_MARGIN

  let cx = boneStartX
  const slots = boneWidths.map(({ b, w }) => {
    const x = cx + w / 2
    cx += w
    return { b, x, w }
  })

  // 精确计算所有元素的实际坐标极值
  let xMin = PAD_L - 20,
    xMax = mainEnd + 140
  let yMin = CY,
    yMax = CY
  for (const slot of slots) {
    const { b, x: bx } = slot
    const dir = b.position === 'top' ? -1 : 1
    const dynamicDiag = calcDiag(b)
    const dd = dynamicDiag / Math.SQRT2
    const sx = bx,
      ex = bx - dd
    const ey = CY + dir * dd
    yMin = Math.min(yMin, ey - 80)
    yMax = Math.max(yMax, ey + 80)
    xMin = Math.min(xMin, ex - 80)
    xMax = Math.max(xMax, sx + 80)

    const smdd = SM_LEN / Math.SQRT2
    let accumOff = 60
    for (const m of b.midBones) {
      const span = midBoneSpan(m)
      const centerOff = accumOff + span / 2
      accumOff += span
      const t = centerOff / dynamicDiag
      const ax = sx + (ex - sx) * t
      const ay = CY + (ey - CY) * t
      const msign = m.side === 'left' ? -1 : 1
      const ml = midLen(m)
      const mex = ax + msign * ml
      xMin = Math.min(xMin, mex - 100, ax - 60)
      xMax = Math.max(xMax, mex + 100, ax + 60)
      yMin = Math.min(yMin, ay - 60)
      yMax = Math.max(yMax, ay + 60)
      const SM_BTN = 18, btnGap = 20
      const smBtnX = mex + (msign === 1 ? -SM_BTN - btnGap : btnGap)
      const smZoneS = ax + msign * 40
      const smZoneE = smBtnX + (msign === 1 ? 0 : SM_BTN)
      for (let j = 0; j < m.smallBones.length; j++) {
        const st2 = (j + 1) / (m.smallBones.length + 1)
        const smx = smZoneS + (smZoneE - smZoneS) * st2
        const smEndX = smx - smdd
        xMin = Math.min(xMin, smEndX - 40)
        xMax = Math.max(xMax, smEndX + 40, smx + 10)
      }
    }
  }

  // 所有骨线元素不可侵入鱼尾区域，安全线 = 鱼尾右边缘 + 间距
  const tailSafeRight = PAD_L + TAIL + 50
  const shiftX = xMin < tailSafeRight ? tailSafeRight - xMin : 0
  const shiftY = yMin < 0 ? -yMin + 40 : 0
  if (shiftX > 0 || shiftY > 0) {
    for (const s of slots) {
      s.x += shiftX
    }
  }
  let shiftedMainEnd = mainEnd + shiftX
  const cy = CY + shiftY

  // 如果最右元素超出主骨线终点，稍作扩展
  const rightmost = xMax + shiftX + 20
  if (rightmost > shiftedMainEnd) {
    shiftedMainEnd = rightmost
  }

  // --- 3. 鱼头鱼尾尺寸 ---
  const FISH_SCALE = 1.6  // 鱼头鱼尾放大倍数
  const TAIL_SVG_W = 120 * FISH_SCALE, TAIL_SVG_H = 120 * FISH_SCALE
  const HEAD_SVG_W = 120 * FISH_SCALE, HEAD_SVG_H = 120 * FISH_SCALE

  const PAD = 40
  const canvasW = Math.max(shiftedMainEnd + HEAD_SVG_W + 40, 900)
  const canvasH = Math.max(yMax + shiftY + PAD, Math.max(TAIL_SVG_H, HEAD_SVG_H) + 100, 700)

  // --- 4. 创建 X6 Graph ---
  graph = new Graph({
    container: containerRef.value,
    width: canvasW,
    height: canvasH,
    background: { color: '#FFFFFF' },
    grid: { visible: true, type: 'dot', size: 20, args: { color: '#E5E6EB', thickness: 1 } },
    panning: false,
    mousewheel: false,
    interacting: { nodeMovable: false },
  })

  graph.on('node:click', ({ node }) => {
    if (didDrag) return
    const fn = callbackMap[node.id]
    if (fn) fn()
  })

  const mainLeft = PAD_L + shiftX + TAIL
  const mainRight = shiftedMainEnd

  // 鱼尾：右边缘对齐 mainLeft，纵向中心对齐 cy
  tailPos.x = mainLeft - TAIL_SVG_W
  tailPos.y = cy - TAIL_SVG_H / 2
  tailPos.w = TAIL_SVG_W
  tailPos.h = TAIL_SVG_H

  // 鱼头：左边缘对齐 mainRight，纵向中心对齐 cy
  headPos.x = mainRight
  headPos.y = cy - HEAD_SVG_H / 2
  headPos.w = HEAD_SVG_W
  headPos.h = HEAD_SVG_H

  // --- 5. 主骨线：向两端延伸深入鱼头鱼尾内部，确保无空隙 ---
  addEdge([mainLeft - TAIL_SVG_W * 0.3, cy], [mainRight + HEAD_SVG_W * 0.3, cy], '#00A68DFF', 3)
  addBtn('btn_add_big', mainLeft + 15, cy - BTN / 2, '#3270FF', '新增大骨', addBigBone)

  let btnSeq = 0

  // --- 6. 大骨 → 中骨 → 小骨 ---
  for (const slot of slots) {
    const { b, x: bx } = slot
    const dir = b.position === 'top' ? -1 : 1
    const dynamicDiag = calcDiag(b)
    const dd = dynamicDiag / Math.SQRT2
    const sx = bx,
      sy = cy
    const ex = bx - dd,
      ey = cy + dir * dd

    const lw = 120,
      lh = 32
    const boxX = ex - lw / 2
    const boxY = dir === -1 ? ey - lh : ey
    const bigLabelId = `big_label_${b.id}`
    addLabelNode(
      bigLabelId,
      boxX,
      boxY,
      lw,
      lh,
      b.label,
      '#FFFFFF',
      '#DCDEE2',
      '#1D2129',
      13,
      600,
      22,
      b,
      { type: 'big', bigId: b.id },
    )

    addEdge([sx, sy], [ex, ey], '#00A68DFF', 2, true)

    const bid = b.id
    const MID_BTN = 20
    const btnT = 40 / dynamicDiag
    const mbx = ex + (sx - ex) * btnT
    const mby = ey + (sy - ey) * btnT
    addBtn(`btn_mid_${b.id}`, mbx - MID_BTN / 2, mby - MID_BTN / 2, '#3270FF', '新增中骨', () => addMidBone(bid), MID_BTN)

    let accumOffset = 60
    for (let i = 0; i < b.midBones.length; i++) {
      const m = b.midBones[i]
      const span = midBoneSpan(m)
      const centerOffset = accumOffset + span / 2
      accumOffset += span

      const t = centerOffset / dynamicDiag
      const ax = sx + (ex - sx) * t
      const ay = sy + (ey - sy) * t
      const msign = m.side === 'left' ? -1 : 1
      const dynamicMidLen = midLen(m)
      const mex = ax + msign * dynamicMidLen
      const mey = ay

      addEdge([ax, ay], [mex, mey], '#00A68DFF', 1.5, true)

      const mlw = 80,
        mlh = 24
      const midLabelId = `mid_label_${m.id}`
      addLabelNode(
        midLabelId,
        mex + (msign === 1 ? 0 : -mlw),
        mey - mlh / 2,
        mlw,
        mlh,
        m.label,
        '#E8F3FF',
        '#165DFF',
        '#1D2129',
        11,
        500,
        4,
        m,
        { type: 'mid', bigId: b.id, midId: m.id },
      )

      const capMid = m.id
      const SM_BTN = 18
      const btnGap = 20
      const smBtnX = mex + (msign === 1 ? -SM_BTN - btnGap : btnGap)
      addBtn(
        `btn_sm_${++btnSeq}`,
        smBtnX,
        mey - SM_BTN / 2,
        '#3270FF',
        '新增小骨',
        () => addSmallBone(bid, capMid),
        SM_BTN,
      )

      const smdd = SM_LEN / Math.SQRT2
      const smZoneStart = ax + msign * 40
      const smZoneEnd = smBtnX + (msign === 1 ? 0 : SM_BTN)
      for (let j = 0; j < m.smallBones.length; j++) {
        const sm = m.smallBones[j]
        const st2 = (j + 1) / (m.smallBones.length + 1)
        const smx = smZoneStart + (smZoneEnd - smZoneStart) * st2
        const smy = ay
        const sd = sm.position === 'top' ? -1 : 1
        const smEndX = smx - smdd
        const smEndY = smy + sd * smdd

        addEdge([smx, smy], [smEndX, smEndY], '#00A68DFF', 1)

        const slw = 64,
          slh = 18
        const smLabelId = `sm_label_${sm.id}`
        addLabelNode(
          smLabelId,
          smEndX - slw / 2,
          smEndY + (sd === 1 ? 3 : -slh - 3),
          slw,
          slh,
          sm.label,
          'transparent',
          'transparent',
          '#4E5969',
          10,
          400,
          3,
          sm,
          { type: 'small', bigId: b.id, midId: m.id, smId: sm.id },
        )
      }
    }
  }

  // --- 7. 首次打开时居中，后续操作保持当前视角 ---
  if (needsCenter) {
    scale.value = 1
    nextTick(() => {
      if (!viewportRef.value) return
      const vw = viewportRef.value.clientWidth
      const vh = viewportRef.value.clientHeight
      panX.value = canvasW < vw ? Math.round((vw - canvasW) / 2) : 0
      panY.value = canvasH < vh ? Math.round((vh - canvasH) / 2) : 0
    })
    needsCenter = false
  }
}

function zoomIn() { scale.value = Math.min(SCALE_MAX, scale.value + 0.1) }
function zoomOut() { scale.value = Math.max(SCALE_MIN, scale.value - 0.1) }
function resetZoom() { needsCenter = true; scale.value = 1; renderGraph() }
function onConfirm() { emit('confirm') }
function onCancel() { emit('cancel') }

onMounted(() => {
  window.addEventListener('pointermove', onPointerMove)
  window.addEventListener('pointerup', onPointerUp)
})

onBeforeUnmount(() => {
  window.removeEventListener('pointermove', onPointerMove)
  window.removeEventListener('pointerup', onPointerUp)
})
</script>

<template>
  <div class="fishbone-page">
    <!-- 视口 -->
    <div
      class="fishbone-viewport"
      ref="viewportRef"
      @pointerdown="onPointerDown"
      @wheel.prevent="onWheel"
    >
      <!-- 世界容器: translate 平移 + scale 缩放 -->
      <div
        class="fishbone-world"
        ref="worldRef"
        :style="{ transform: `translate(${panX}px, ${panY}px) scale(${scale})` }"
      >
        <!-- X6 画布 -->
        <div class="fishbone-canvas" ref="containerRef" />

        <!-- 鱼尾 -->
        <div
          class="fish-part"
          :style="{
            left: tailPos.x + 'px',
            top: tailPos.y + 'px',
            width: tailPos.w + 'px',
            height: tailPos.h + 'px',
          }"
        >
          <svg
            viewBox="11 0 96 190"
            xmlns="http://www.w3.org/2000/svg"
            width="100%"
            height="100%"
            fill="none"
            preserveAspectRatio="xMaxYMid meet"
          >
            <path
              d="M102.879 2.01658C110.261 8.22382 133.26 27.9612 154 50.0001C166.018 62.7703 177.277 76.3132 185.752 86.9654C188.582 90.5227 183.642 95.9408 179.641 93.7839C160.338 83.3791 130.399 70.5002 100.459 70.5002C68.7726 70.5002 37.086 84.926 18.0092 95.577C14.1488 97.7323 9.50671 92.9223 12.1185 89.355C20.1483 78.3874 31.5642 63.7461 44.5001 50.0001C65.3453 27.8495 90.1375 8.02381 97.9645 1.92325C99.4219 0.787285 101.464 0.827429 102.879 2.01658Z"
              fill="rgb(0,166,141)"
              fill-rule="evenodd"
              transform="matrix(0,1,-1,0,106.75,0)"
            />
          </svg>
        </div>

        <!-- 鱼头 -->
        <div
          class="fish-part"
          :style="{
            left: headPos.x + 'px',
            top: headPos.y + 'px',
            width: headPos.w + 'px',
            height: headPos.h + 'px',
          }"
        >
          <svg
            viewBox="0 0 125 197"
            xmlns="http://www.w3.org/2000/svg"
            width="100%"
            height="100%"
            fill="none"
            preserveAspectRatio="xMinYMid meet"
          >
            <path
              d="M110.059 8.15895C120.529 17.2515 137.941 32.9359 154 50.0001C170.851 67.907 186.212 87.3332 194.496 98.178C197.741 102.427 195.836 108.471 190.711 109.996C173.495 115.118 136.977 124.5 100.459 124.5C63.536 124.5 26.613 114.909 9.64137 109.827C4.69317 108.346 2.72161 102.608 5.67516 98.3702C13.2072 87.5639 27.5485 68.0132 44.5001 50.0001C60.7663 32.7152 79.436 16.846 90.5724 7.80947C96.3118 3.15221 104.479 3.3124 110.059 8.15895Z"
              fill="rgb(0,166,141)"
              fill-rule="evenodd"
              transform="matrix(0,1,-1,0,124.5,0)"
            />
          </svg>
          <div class="fish-head-label" :title="headLabel">
            <textarea
              v-if="headEditing"
              ref="headInputRef"
              class="fish-head-input"
              :value="headLabel"
              @input="(e) => (headLabel = e.target.value)"
              rows="2"
              @blur="headEditing = false"
            ></textarea>
            <span
              v-else
              class="fish-head-text"
              @click="startHeadEdit"
            >{{ headLabel }}</span>
          </div>
        </div>

        <!-- 编辑覆盖层 -->
        <div
          v-for="ov in editOverlays"
          :key="ov.id"
          :class="['inline-edit-wrap', 'inline-edit-' + ov.boneType]"
          :style="{
            left: ov.x + 'px',
            top: ov.y + 'px',
            width: ov.w + 'px',
            height: ov.h + 'px',
          }"
        >
          <input
            class="inline-edit-input"
            :style="{
              fontSize: ov.fs + 'px',
              fontWeight: ov.fw,
              color: ov.fg,
              background: ov.bg,
              borderColor: ov.border,
              borderRadius: ov.rx + 'px',
            }"
            :value="ov.boneRef.label"
            :title="ov.boneRef.label"
            @input="(e) => (ov.boneRef.label = e.target.value)"
            @blur="onOverlayBlur(ov)"
          />
          <span
            v-if="ov.delInfo"
            class="inline-edit-del"
            @mousedown.prevent.stop="deleteBone(ov.delInfo)"
            >&times;</span
          >
        </div>
      </div>
    </div>
    <!-- 百分比：右上角 -->
    <div class="scale-text">{{ (scale * 100).toFixed(0) }}%</div>
    <!-- 缩放控件：底部操作栏上方居中 -->
    <div class="zoom-control">
      <a-space size="medium">
        <a-tooltip content="放大"><icon-zoom-in @click="zoomIn" /></a-tooltip>
        <a-tooltip content="还原缩放"><icon-original-size @click="resetZoom" /></a-tooltip>
        <a-tooltip content="缩小"><icon-zoom-out @click="zoomOut" /></a-tooltip>
      </a-space>
    </div>
    <!-- 底部操作栏 -->
    <footer class="fishbone-footer">
      <div class="footer-left">
        <a-radio-group v-model="mode" type="button" size="small" @change="renderGraph">
          <a-radio value="edit">编辑</a-radio>
          <a-radio value="view">详情</a-radio>
        </a-radio-group>
      </div>
      <div class="footer-right">
        <a-button size="small" @click="onCancel">取消</a-button>
        <a-button type="primary" size="small" @click="onConfirm">确定</a-button>
      </div>
    </footer>
  </div>
</template>

<style scoped>
/* ==================== 页面整体布局 ==================== */
.fishbone-page {
  width: 100%;
  height: 100%;
  display: flex;
  flex-direction: column;
  background: #fff;
  position: relative;
}

/* ==================== 百分比（右上角） ==================== */
.scale-text {
  position: absolute;
  top: 12px;
  right: 16px;
  z-index: 20;
  font-size: 13px;
  color: #1d2129;
  user-select: none;
}

/* ==================== 缩放控件（底部栏上方居中） ==================== */
.zoom-control {
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 6px 0;
  flex-shrink: 0;
}
.zoom-control :deep(.arco-space) {
  background: #fff;
  border-radius: 8px;
  padding: 6px 14px;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.12);
}
.zoom-control :deep(.arco-icon) {
  font-size: 18px;
  color: #165dff;
  cursor: pointer;
  transition: color 0.2s;
}
.zoom-control :deep(.arco-icon:hover) {
  color: #0e42d2;
}

/* ==================== 底部操作栏 ==================== */
.fishbone-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 8px 16px;
  border-top: 1px solid #e5e6eb;
  background: #fff;
  flex-shrink: 0;
}
.footer-left {
  display: flex;
  align-items: center;
  gap: 8px;
}
.footer-right {
  display: flex;
  align-items: center;
  gap: 8px;
}

/* ==================== 视口 + 世界容器 ==================== */
.fishbone-viewport {
  flex: 1;
  overflow: hidden; /* 裁剪溢出，不显示滚动条 */
  position: relative;
  cursor: grab; /* 提示可拖拽 */
  user-select: none; /* 拖拽时禁止选中文字 */
}
.fishbone-world {
  position: absolute;
  top: 0;
  left: 0;
  transform-origin: 0 0;
  will-change: transform;
}
.fishbone-canvas {
  /* X6 画布，由 Graph 设置宽高 */
}

/* ==================== 鱼头鱼尾 overlay ==================== */
.fish-part {
  position: absolute;
  z-index: 8;
  pointer-events: none;
}

.fish-head-label {
  position: absolute;
  top: 0;
  left: 0;
  width: 55%;
  height: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  pointer-events: auto;
}
.fish-head-text {
  width: 56px;
  font-size: 13px;
  font-weight: 600;
  color: #0a7b79;
  text-align: center;
  line-height: 1.4;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
  word-break: break-all;
  cursor: pointer;
}
.fish-head-input {
  pointer-events: auto;
  width: 64px;
  text-align: center;
  border: 1px solid #0fc6c2;
  background: rgba(255, 255, 255, 0.9);
  font-size: 13px;
  font-weight: 600;
  color: #0a7b79;
  outline: none;
  padding: 2px 4px;
  border-radius: 4px;
  resize: none;
  line-height: 1.4;
  box-sizing: border-box;
  cursor: text;
  user-select: text;
}
.fish-head-input:focus {
  box-shadow: 0 0 0 2px rgba(15, 198, 194, 0.25);
}

/* ==================== 编辑覆盖层 (input + 删除按钮) ==================== */
.inline-edit-wrap {
  position: absolute;
  z-index: 10;
}
.inline-edit-input {
  width: 100%;
  height: 100%;
  border: 1px solid;
  padding: 0 6px;
  text-align: center;
  outline: none;
  box-sizing: border-box;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  cursor: text;
  user-select: text;
}
.inline-edit-input:focus {
  box-shadow: 0 0 0 2px rgba(22, 93, 255, 0.2);
}
.inline-edit-big:hover .inline-edit-input {
  border-color: #165dff;
}
.inline-edit-mid:hover .inline-edit-input {
  border-color: transparent;
}

.inline-edit-del {
  position: absolute;
  top: -8px;
  right: -8px;
  width: 16px;
  height: 16px;
  border-radius: 50%;
  background: #f53f3f;
  color: #fff;
  font-size: 12px;
  line-height: 16px;
  text-align: center;
  cursor: pointer;
  user-select: none;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.2);
}
.inline-edit-del:hover {
  background: #cb2634;
}
</style>