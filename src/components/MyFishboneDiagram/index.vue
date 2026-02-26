<script setup>
import { ref, reactive, onMounted, nextTick } from 'vue'
import { Graph } from '@antv/x6'

const containerRef = ref(null)
const scrollRef = ref(null)
const sizerRef = ref(null)
let graph = null
const callbackMap = {}

// ======================== 模式 ========================
const mode = ref('edit') // 'edit' | 'view'

// ======================== 原位编辑覆盖层 ========================
const editOverlays = ref([]) // [{ id, x, y, w, h, boneRef, bg, border, fg, fs, fw }]

function onOverlayInput(overlay, val) {
  overlay.boneRef.label = val
}

function onOverlayBlur(overlay) {
  renderGraph()
}

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

// ======================== 数据层 ========================
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

// ======================== 鱼头鱼尾位置(由 renderGraph 更新) ========================
const headPos = reactive({ x: 0, y: 0, w: 0, h: 0 })
const tailPos = reactive({ x: 0, y: 0, w: 0, h: 0 })

// ======================== 布局参数 ========================
const CY = 350
const TAIL = 50
const PAD_L = 70
const BIG_GAP = 250
const DIAG = 150
const MID_LEN = 90
const SM_LEN = 42
const BTN = 24

// ======================== 辅助函数 ========================
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

// ======================== 核心渲染 ========================
function renderGraph() {
  if (!scrollRef.value) return

  const wrap = scrollRef.value
  const sl = wrap.scrollLeft
  const st = wrap.scrollTop

  if (graph) graph.dispose()
  containerRef.value.innerHTML = ''
  Object.keys(callbackMap).forEach((k) => delete callbackMap[k])
  editOverlays.value = []

  function midBoneSpan(m) {
    return Math.max(60, m.smallBones.length * 40 + 30)
  }
  function calcDiag(b) {
    if (b.midBones.length === 0) return DIAG
    let total = 50
    for (const m of b.midBones) total += midBoneSpan(m)
    total += 40
    return Math.max(DIAG, total)
  }
  function boneW(b) {
    const diagDx = calcDiag(b) / Math.SQRT2
    let mw = 0
    for (const m of b.midBones) mw = Math.max(mw, MID_LEN + m.smallBones.length * 50 + 80)
    return Math.max(BIG_GAP, diagDx + 80, mw + 80)
  }

  // 先算所有大骨总宽度
  const boneWidths = fishData.bigBones.map((b) => ({ b, w: boneW(b) }))
  let totalBoneW = 0
  for (const bw of boneWidths) totalBoneW += bw.w
  const mainEnd = PAD_L + TAIL + 80 + totalBoneW + 60

  // 从鱼头向鱼尾方向排列（从右往左分配位置）
  let cx = mainEnd - 60
  const slots = boneWidths.map(({ b, w }) => {
    cx -= w
    return { b, x: cx + w / 2, w }
  })
  const wrapW = wrap.clientWidth
  const wrapH = wrap.clientHeight
  const canvasW = Math.max(mainEnd + 100, wrapW)

  let yMin = CY, yMax = CY
  for (const sl2 of slots) {
    const dir = sl2.b.position === 'top' ? -1 : 1
    const dd = calcDiag(sl2.b) / Math.SQRT2
    const ey = CY + dir * dd
    yMin = Math.min(yMin, ey - 80)
    yMax = Math.max(yMax, ey + 80)
  }
  const canvasH = Math.max(yMax - yMin + 200, wrapH)

  sizerRef.value.style.width = canvasW + 'px'
  sizerRef.value.style.height = canvasH + 'px'

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

  graph.on('node:click', ({ node }) => {
    const fn = callbackMap[node.id]
    if (fn) fn()
  })

  const TAIL_W = 80, TAIL_H = 60
  const HEAD_W = 100, HEAD_H = 60

  tailPos.x = PAD_L - 10
  tailPos.y = CY - TAIL_H / 2
  tailPos.w = TAIL_W
  tailPos.h = TAIL_H

  headPos.x = mainEnd - 10
  headPos.y = CY - HEAD_H / 2
  headPos.w = HEAD_W
  headPos.h = HEAD_H

  // 主骨线（从鱼尾区域右侧到鱼头区域左侧）
  addEdge([tailPos.x + TAIL_W, CY], [headPos.x, CY], '#0FC6C2', 3)

  addBtn('btn_add_big', tailPos.x + TAIL_W + 6, CY - BTN / 2, '#165DFF', '新增大骨', addBigBone)

  let btnSeq = 0

  for (const slot of slots) {
    const { b, x: bx } = slot
    const dir = b.position === 'top' ? -1 : 1
    const dynamicDiag = calcDiag(b)
    const dd = dynamicDiag / Math.SQRT2
    const sx = bx, sy = CY
    const ex = bx - dd, ey = CY + dir * dd

    // 大骨标签（可点击编辑）
    const lw = 120, lh = 32
    const boxX = ex - lw / 2
    const boxY = dir === -1 ? ey - lh : ey
    const bigLabelId = `big_label_${b.id}`
    addLabelNode(bigLabelId, boxX, boxY, lw, lh, b.label, '#FFFFFF', '#1D2129', '#1D2129', 13, 600, 8, b, { type: 'big', bigId: b.id })

    addEdge([ex, ey], [sx, sy], '#0FC6C2', 2)

    const bid = b.id
    const MID_BTN = 20
    const btnT = 40 / dynamicDiag
    // 按钮在远离主骨的方框端附近
    const mbx = ex + (sx - ex) * btnT
    const mby = ey + (sy - ey) * btnT
    addBtn(`btn_mid_${b.id}`, mbx - MID_BTN / 2, mby - MID_BTN / 2, '#165DFF', '新增中骨', () => addMidBone(bid), MID_BTN)

    // 中骨从主骨端向方框端方向排列
    let accumOffset = 40 // 主骨端留白
    for (let i = 0; i < b.midBones.length; i++) {
      const m = b.midBones[i]
      const span = midBoneSpan(m)
      const centerOffset = accumOffset + span / 2
      accumOffset += span
      const t = centerOffset / dynamicDiag
      // t 从主骨端(sx,sy)向方框端(ex,ey)方向
      const ax = sx + (ex - sx) * t
      const ay = sy + (ey - sy) * t
      const msign = m.side === 'left' ? -1 : 1
      const dynamicMidLen = MID_LEN + m.smallBones.length * 50
      const mex = ax + msign * dynamicMidLen
      const mey = ay

      addEdge([ax, ay], [mex, mey], '#0FC6C2', 1.5)

      // 中骨标签（可点击编辑）
      const mlw = 80, mlh = 24
      const midLabelId = `mid_label_${m.id}`
      addLabelNode(midLabelId, mex + (msign === 1 ? 4 : -mlw - 4), mey - mlh / 2, mlw, mlh, m.label, '#E8F3FF', '#165DFF', '#1D2129', 11, 500, 4, m, { type: 'mid', bigId: b.id, midId: m.id })

      const capMid = m.id
      const SM_BTN = 18
      const btnGap = 20
      const smBtnX = mex + (msign === 1 ? -SM_BTN - btnGap : btnGap)
      addBtn(`btn_sm_${++btnSeq}`, smBtnX, mey - SM_BTN / 2, '#165DFF', '新增小骨', () => addSmallBone(bid, capMid), SM_BTN)

      const smdd = SM_LEN / Math.SQRT2
      // 小骨区间整体向远离大骨线方向偏移，拉开与大骨线的距离
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

        // 小骨标签（可点击编辑）
        const slw = 64, slh = 18
        const smLabelId = `sm_label_${sm.id}`
        addLabelNode(smLabelId, smEndX - slw / 2, smEndY + (sd === 1 ? 3 : -slh - 3), slw, slh, sm.label, 'transparent', 'transparent', '#4E5969', 10, 400, 3, sm, { type: 'small', bigId: b.id, midId: m.id, smId: sm.id })
      }
    }
  }

  nextTick(() => {
    wrap.scrollLeft = sl
    wrap.scrollTop = st
  })
}

// ======================== 初始化 ========================
onMounted(async () => {
  await nextTick()
  renderGraph()
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
    <div class="fishbone-scroll" ref="scrollRef">
      <div class="fishbone-sizer" ref="sizerRef"></div>
      <div class="fishbone-canvas" ref="containerRef" />

      <!-- 鱼尾 overlay -->
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

      <!-- 鱼头 overlay -->
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
</template>

<style scoped>
.fishbone-page {
  width: 100%;
  height: 100%;
  display: flex;
  flex-direction: column;
  background: #f2f3f5;
}
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
.fishbone-scroll {
  flex: 1;
  overflow: auto;
  position: relative;
}
.fishbone-sizer {
  pointer-events: none;
}
.fishbone-canvas {
  position: absolute;
  top: 0;
  left: 0;
}
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
