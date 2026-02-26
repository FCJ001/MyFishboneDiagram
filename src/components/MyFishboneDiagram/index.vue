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
      .fishbone-world — 内层世界容器 (transform: translate 平移，包裹所有内容)
        .fishbone-canvas — X6 画布挂载点
        鱼头/鱼尾/编辑overlay — 都在 world 内，跟随 transform 一起移动
-->
<script setup>
import { ref, reactive, onMounted, onBeforeUnmount, nextTick } from 'vue'
import { Graph } from '@antv/x6'

// ============================== DOM 引用 ==============================
const containerRef = ref(null) // X6 画布挂载的 div
const viewportRef = ref(null)  // 外层视口容器（捕获拖拽）
const worldRef = ref(null)     // 内层世界容器（transform 平移）
let graph = null               // AntV X6 Graph 实例（每次 renderGraph 会重建）
const callbackMap = {}         // 节点 id → 点击回调的映射表（用于 "+" 按钮）

// ============================== 拖拽平移 ==============================
const panX = ref(0)
const panY = ref(0)
let isPanning = false
let panStartX = 0
let panStartY = 0
let panOriginX = 0
let panOriginY = 0
let didDrag = false // 区分拖拽和点击

function onPointerDown(e) {
  // 不拦截 input / 按钮上的事件
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

// ============================== 模式切换 ==============================
// 'edit' 模式: 标签变成 input 可编辑，显示 "+" 按钮和 "×" 删除按钮
// 'view' 模式: 标签由 X6 节点渲染，只读
const mode = ref('edit')

// ============================== 编辑覆盖层 ==============================
// 编辑模式下，每个骨的标签不走 X6 节点渲染，而是收集到这个数组里，
// 然后在 template 中用 v-for 渲染为 HTML input，叠加在画布上方。
// 每项包含: { id, x, y, w, h, boneRef(指向数据对象), bg, border, fg, fs, fw, rx, delInfo, boneType }
const editOverlays = ref([])

function onOverlayInput(overlay, val) {
  overlay.boneRef.label = val
}

// 失焦时重绘，因为文本长度可能影响布局
function onOverlayBlur(overlay) {
  renderGraph()
}

// ============================== 删除后重平衡 ==============================
// 删除某条骨后，剩余的骨需要重新交替分配方向（上/下 或 左/右），
// 避免出现一侧有 2 条而另一侧 0 条的不平衡情况。
function rebalanceSides(arr, key, values) {
  arr.forEach((item, i) => { item[key] = values[i % values.length] })
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
const headLabel = ref('问题')

function addBigBone() {
  const n = fishData.bigBones.length
  fishData.bigBones.push({
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

function addSmallBone(bigId, midId) {
  const b = fishData.bigBones.find((x) => x.id === bigId)
  if (!b) return
  const m = b.midBones.find((x) => x.id === midId)
  if (!m) return
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
const CY = 350
const TAIL = 50
const PAD_L = 70
const BIG_GAP = 250
const DIAG = 150
const MID_LEN = 90
const SM_LEN = 42
const BTN = 24

// ============================== X6 绘制辅助函数 ==============================

function addEdge(s, t, color, w) {
  graph.addEdge({
    shape: 'edge',
    source: { x: s[0], y: s[1] },
    target: { x: t[0], y: t[1] },
    attrs: {
      line: {
        stroke: color, strokeWidth: w, strokeLinecap: 'round',
        targetMarker: { tagName: 'path', d: '' },
        sourceMarker: { tagName: 'path', d: '' },
      },
    },
  })
}

function addLabelNode(id, x, y, w, h, text, bg, border, fg, fs = 12, fw = 500, rx = 4, boneRef = null, delInfo = null) {
  const boneType = delInfo?.type || ''
  if (mode.value === 'edit' && boneRef) {
    editOverlays.value.push({ id, x, y, w, h, boneRef, bg, border, fg, fs, fw, rx, delInfo, boneType })
  } else {
    graph.addNode({
      id,
      shape: 'rect', x, y, width: w, height: h,
      attrs: {
        body: { fill: bg, stroke: border, strokeWidth: 1.2, rx, ry: rx },
        label: {
          text, fill: fg, fontSize: fs, fontWeight: fw,
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
    id, shape: 'rect', x, y, width: s, height: s,
    attrs: {
      body: { fill: color, stroke: '#fff', strokeWidth: 1.5, rx: 4, ry: 4, cursor: 'pointer' },
      label: { text: '+', fill: '#fff', fontSize: s === BTN ? 16 : 13, fontWeight: 'bold', cursor: 'pointer' },
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
    let total = 50
    for (const m of b.midBones) total += midBoneSpan(m)
    total += 40
    return Math.max(DIAG, total)
  }
  // 中骨水平长度随小骨数量增长（每个小骨增加 30px）
  function midLen(m) {
    return MID_LEN + m.smallBones.length * 30
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
  const mainEnd = PAD_L + TAIL + 80 + totalBoneW + 60

  let cx = mainEnd - 60
  const slots = boneWidths.map(({ b, w }) => {
    cx -= w
    return { b, x: cx + w / 2, w }
  })

  // 精确计算所有元素的实际坐标极值
  let xMin = PAD_L - 20, xMax = mainEnd + 100
  let yMin = CY, yMax = CY
  for (const slot of slots) {
    const { b, x: bx } = slot
    const dir = b.position === 'top' ? -1 : 1
    const dynamicDiag = calcDiag(b)
    const dd = dynamicDiag / Math.SQRT2
    const sx = bx, ex = bx - dd
    const ey = CY + dir * dd
    yMin = Math.min(yMin, ey - 80)
    yMax = Math.max(yMax, ey + 80)
    xMin = Math.min(xMin, ex - 80)
    xMax = Math.max(xMax, sx + 80)

    let accumOff = 40
    for (const m of b.midBones) {
      const span = midBoneSpan(m)
      const centerOff = accumOff + span / 2
      accumOff += span
      const t = centerOff / dynamicDiag
      const ax = sx + (ex - sx) * t
      const ay = CY + (ey - CY) * t
      const msign = m.side === 'left' ? -1 : 1
      const mex = ax + msign * midLen(m)
      xMin = Math.min(xMin, mex - 100, ax - 60)
      xMax = Math.max(xMax, mex + 100, ax + 60)
      yMin = Math.min(yMin, ay - 60)
      yMax = Math.max(yMax, ay + 60)
    }
  }

  // 如果内容坐标超出左边界或上边界，整体偏移所有坐标
  const shiftX = xMin < 0 ? -xMin + 40 : 0
  const shiftY = yMin < 0 ? -yMin + 40 : 0
  if (shiftX > 0 || shiftY > 0) {
    for (const s of slots) { s.x += shiftX }
  }
  const shiftedMainEnd = mainEnd + shiftX
  const cy = CY + shiftY

  const PAD = 40
  const canvasW = Math.max(xMax + shiftX + PAD, 900)
  const canvasH = Math.max(yMax + shiftY + PAD, 700)

  // --- 3. 创建 X6 Graph ---
  graph = new Graph({
    container: containerRef.value,
    width: canvasW,
    height: canvasH,
    background: { color: '#FAFBFC' },
    grid: { visible: true, type: 'dot', size: 20, args: { color: '#E5E6EB', thickness: 1 } },
    panning: false,
    mousewheel: false,
    interacting: { nodeMovable: false },
  })

  // 拦截拖拽中的点击：如果刚拖拽过，不触发按钮回调
  graph.on('node:click', ({ node }) => {
    if (didDrag) return
    const fn = callbackMap[node.id]
    if (fn) fn()
  })

  // --- 4. 鱼尾鱼头位置 ---
  const TAIL_W = 80, TAIL_H = 60
  const HEAD_W = 100, HEAD_H = 60

  tailPos.x = PAD_L + shiftX - 10
  tailPos.y = cy - TAIL_H / 2
  tailPos.w = TAIL_W
  tailPos.h = TAIL_H

  headPos.x = shiftedMainEnd - 10
  headPos.y = cy - HEAD_H / 2
  headPos.w = HEAD_W
  headPos.h = HEAD_H

  // --- 5. 主骨线 ---
  addEdge([tailPos.x + TAIL_W, cy], [headPos.x, cy], '#0FC6C2', 3)
  addBtn('btn_add_big', tailPos.x + TAIL_W + 6, cy - BTN / 2, '#165DFF', '新增大骨', addBigBone)

  let btnSeq = 0

  // --- 6. 大骨 → 中骨 → 小骨 ---
  for (const slot of slots) {
    const { b, x: bx } = slot
    const dir = b.position === 'top' ? -1 : 1
    const dynamicDiag = calcDiag(b)
    const dd = dynamicDiag / Math.SQRT2
    const sx = bx, sy = cy
    const ex = bx - dd, ey = cy + dir * dd

    const lw = 120, lh = 32
    const boxX = ex - lw / 2
    const boxY = dir === -1 ? ey - lh : ey
    const bigLabelId = `big_label_${b.id}`
    addLabelNode(bigLabelId, boxX, boxY, lw, lh, b.label, '#FFFFFF', '#1D2129', '#1D2129', 13, 600, 8, b, { type: 'big', bigId: b.id })

    addEdge([ex, ey], [sx, sy], '#0FC6C2', 2)

    const bid = b.id
    const MID_BTN = 20
    const btnT = 40 / dynamicDiag
    const mbx = ex + (sx - ex) * btnT
    const mby = ey + (sy - ey) * btnT
    addBtn(`btn_mid_${b.id}`, mbx - MID_BTN / 2, mby - MID_BTN / 2, '#165DFF', '新增中骨', () => addMidBone(bid), MID_BTN)

    let accumOffset = 40
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

      addEdge([ax, ay], [mex, mey], '#0FC6C2', 1.5)

      const mlw = 80, mlh = 24
      const midLabelId = `mid_label_${m.id}`
      addLabelNode(midLabelId, mex + (msign === 1 ? 4 : -mlw - 4), mey - mlh / 2, mlw, mlh, m.label, '#E8F3FF', '#165DFF', '#1D2129', 11, 500, 4, m, { type: 'mid', bigId: b.id, midId: m.id })

      const capMid = m.id
      const SM_BTN = 18
      const btnGap = 20
      const smBtnX = mex + (msign === 1 ? -SM_BTN - btnGap : btnGap)
      addBtn(`btn_sm_${++btnSeq}`, smBtnX, mey - SM_BTN / 2, '#165DFF', '新增小骨', () => addSmallBone(bid, capMid), SM_BTN)

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

        addEdge([smx, smy], [smEndX, smEndY], '#0FC6C2', 1)

        const slw = 64, slh = 18
        const smLabelId = `sm_label_${sm.id}`
        addLabelNode(smLabelId, smEndX - slw / 2, smEndY + (sd === 1 ? 3 : -slh - 3), slw, slh, sm.label, 'transparent', 'transparent', '#4E5969', 10, 400, 3, sm, { type: 'small', bigId: b.id, midId: m.id, smId: sm.id })
      }
    }
  }

  // --- 7. 内容居中：画布小于视口时居中，大于视口时从原点开始 ---
  nextTick(() => {
    if (!viewportRef.value) return
    const vw = viewportRef.value.clientWidth
    const vh = viewportRef.value.clientHeight
    panX.value = canvasW < vw ? Math.round((vw - canvasW) / 2) : 0
    panY.value = canvasH < vh ? Math.round((vh - canvasH) / 2) : 0
  })
}

// ============================== 生命周期 ==============================
onMounted(async () => {
  await nextTick()
  renderGraph()
  // 全局 pointermove/up 保证拖拽出视口后也能正常结束
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
    <header class="fishbone-bar">
      <span class="fishbone-logo">鱼骨图分析</span>
      <a-space>
        <a-radio-group v-model="mode" type="button" size="small" @change="renderGraph">
          <a-radio value="edit">编辑</a-radio>
          <a-radio value="view">详情</a-radio>
        </a-radio-group>
        <a-tag color="arcoblue">大骨 {{ fishData.bigBones.length }}</a-tag>
        <a-tag color="cyan">中骨 {{ fishData.bigBones.reduce((a, b) => a + b.midBones.length, 0) }}</a-tag>
        <a-tag color="orangered">小骨 {{ fishData.bigBones.reduce((a, b) => a + b.midBones.reduce((c, m) => c + m.smallBones.length, 0), 0) }}</a-tag>
      </a-space>
    </header>

    <!-- 视口: 裁剪溢出，捕获拖拽 -->
    <div
      class="fishbone-viewport"
      ref="viewportRef"
      @pointerdown="onPointerDown"
    >
      <!-- 世界容器: 通过 transform 平移，所有内容都在里面 -->
      <div
        class="fishbone-world"
        ref="worldRef"
        :style="{ transform: `translate(${panX}px, ${panY}px)` }"
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
          <svg viewBox="0 0 80 60" class="fish-part-svg">
            <polygon points="0,0 80,30 0,60" fill="#0FC6C2" opacity="0.15" />
            <polyline points="0,0 80,30 0,60" fill="none" stroke="#0FC6C2" stroke-width="2.5" stroke-linejoin="round" />
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
          <svg viewBox="0 0 100 60" class="fish-part-svg">
            <path d="M0,0 L0,60 L85,60 Q100,30 85,0 Z" fill="#0FC6C2" opacity="0.15" />
            <path d="M0,0 L0,60 L85,60 Q100,30 85,0 Z" fill="none" stroke="#0FC6C2" stroke-width="2.5" stroke-linejoin="round" />
          </svg>
          <div class="fish-head-label">
            <input
              v-if="mode === 'edit'"
              class="fish-head-input"
              :value="headLabel"
              :title="headLabel"
              @input="e => headLabel = e.target.value"
            />
            <span v-else class="fish-head-text" :title="headLabel">{{ headLabel }}</span>
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
            @input="e => ov.boneRef.label = e.target.value"
            @blur="onOverlayBlur(ov)"
          />
          <span
            v-if="ov.delInfo"
            class="inline-edit-del"
            @mousedown.prevent.stop="deleteBone(ov.delInfo)"
          >&times;</span>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
/* ==================== 页面整体布局 ==================== */
.fishbone-page {
  width: 100%;
  height: 100%;
  display: flex;
  flex-direction: column;
  background: #f2f3f5;
}

/* ==================== 顶部工具栏 ==================== */
.fishbone-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 24px;
  background: #fff;
  border-bottom: 1px solid #e5e6eb;
  flex-shrink: 0;
}
.fishbone-logo {
  font-size: 17px;
  font-weight: 700;
  color: #1d2129;
  letter-spacing: .5px;
}

/* ==================== 视口 + 世界容器 ==================== */
.fishbone-viewport {
  flex: 1;
  overflow: hidden;    /* 裁剪溢出，不显示滚动条 */
  position: relative;
  cursor: grab;        /* 提示可拖拽 */
  user-select: none;   /* 拖拽时禁止选中文字 */
}
.fishbone-world {
  position: absolute;
  top: 0;
  left: 0;
  will-change: transform; /* GPU 加速 */
}
.fishbone-canvas {
  /* X6 画布，由 Graph 设置宽高 */
}

/* ==================== 鱼头鱼尾 overlay ==================== */
.fish-part {
  position: absolute;
  z-index: 8;
}
.fish-part-svg {
  width: 100%;
  height: 100%;
  display: block;
}

.fish-head-label {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  pointer-events: none;
}
.fish-head-input {
  pointer-events: auto;
  width: 80%;
  text-align: center;
  border: none;
  background: transparent;
  font-size: 14px;
  font-weight: 600;
  color: #0A7B79;
  outline: none;
  padding: 2px 4px;
  border-radius: 4px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  cursor: text;
  user-select: text;
}
.fish-head-input:focus {
  background: rgba(255,255,255,0.8);
  box-shadow: 0 0 0 2px rgba(15,198,194,0.25);
}
.fish-head-text {
  font-size: 14px;
  font-weight: 600;
  color: #0A7B79;
  max-width: 80%;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
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
  box-shadow: 0 0 0 2px rgba(22,93,255,0.2);
}
.inline-edit-big:hover .inline-edit-input {
  border-color: #165DFF;
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
  background: #F53F3F;
  color: #fff;
  font-size: 12px;
  line-height: 16px;
  text-align: center;
  cursor: pointer;
  user-select: none;
  box-shadow: 0 1px 3px rgba(0,0,0,0.2);
}
.inline-edit-del:hover {
  background: #cb2634;
}
</style>
