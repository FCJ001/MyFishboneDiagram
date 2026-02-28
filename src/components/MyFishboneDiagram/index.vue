<!--
  鱼骨图组件 (Fishbone / Ishikawa Diagram)
  ==========================================
  整体结构（从右到左）：
    鱼头 ─── 主骨线 ─── 鱼尾
              │
         ┌────┴────┐
       大骨(斜线)  大骨(斜线)    ← 上下交替排列，每两根为一组
         │           │
       中骨(水平)  中骨(水平)    ← 从大骨斜线上分支出来
         │
       小骨(方框)               ← 从中骨方框左侧延伸，多个时用弧线连接

  技术栈：
    - Vue 3 (Composition API + <script setup>)
    - @antv/x6 v3 — 用于绘制线条(edge)和节点(node)
    - Arco Design Vue — UI 组件（按钮、图标、单选等）

  核心思路：
    1. 数据驱动：fishData 是 reactive 对象，存储所有骨骼的树形结构
    2. 每次数据变化后调用 renderGraph() 重新计算布局并绘制
    3. 编辑模式下，骨骼标签用 HTML overlay 覆盖在 X6 画布上方，支持 hover 编辑
    4. 画布支持鼠标拖拽平移和滚轮缩放
-->
<script setup>
import { ref, reactive, onMounted, onBeforeUnmount, nextTick } from 'vue'
import { Graph } from '@antv/x6'
import { IconZoomIn, IconZoomOut, IconOriginalSize } from '@arco-design/web-vue/es/icon'

// ═══════════════════════════════════════════════════════════
// 1. 组件对外接口
// ═══════════════════════════════════════════════════════════
const emit = defineEmits(['confirm', 'cancel'])

/**
 * 初始化入口 —— 父组件调用 ref.init() 触发首次渲染。
 * 会等待 DOM 挂载完成后再执行 renderGraph()。
 */
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

// ═══════════════════════════════════════════════════════════
// 2. DOM 引用 & X6 实例
// ═══════════════════════════════════════════════════════════
const containerRef = ref(null)   // X6 Graph 的挂载容器
const viewportRef = ref(null)    // 可视窗口（负责裁剪）
const worldRef = ref(null)       // 世界容器（transform 缩放平移）
let graph = null                 // X6 Graph 实例
let needsCenter = true           // 是否需要自动居中
const callbackMap = {}           // 按钮节点 id → 点击回调

// ═══════════════════════════════════════════════════════════
// 3. 画布拖拽平移 & 滚轮缩放
//    原理：用 CSS transform 的 translate + scale 控制世界容器
// ═══════════════════════════════════════════════════════════
const panX = ref(0)              // 当前水平偏移
const panY = ref(0)              // 当前垂直偏移
const scale = ref(1)             // 当前缩放比例
const SCALE_MIN = 0.3
const SCALE_MAX = 2
let isPanning = false            // 是否正在拖拽
let panStartX = 0                // 拖拽起始鼠标 X
let panStartY = 0                // 拖拽起始鼠标 Y
let panOriginX = 0               // 拖拽起始 panX
let panOriginY = 0               // 拖拽起始 panY
let didDrag = false              // 本次 pointer 操作是否产生了拖拽（用来区分点击和拖拽）

function onPointerDown(e) {
  // 如果点在编辑区域内，不启动拖拽
  if (e.target.closest('.inline-edit-wrap') || e.target.closest('.fish-head-label')) return
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

/**
 * 滚轮缩放 —— 以鼠标位置为缩放中心点。
 * 数学原理：缩放后保持鼠标指向的画布坐标不变。
 *   newPan = mousePos - (mousePos - oldPan) * (newScale / oldScale)
 */
function onWheel(e) {
  e.preventDefault()
  const rect = viewportRef.value.getBoundingClientRect()
  const mx = e.clientX - rect.left
  const my = e.clientY - rect.top
  const oldScale = scale.value
  const delta = e.deltaY > 0 ? -0.08 : 0.08
  const newScale = Math.min(SCALE_MAX, Math.max(SCALE_MIN, oldScale + delta))
  panX.value = mx - (mx - panX.value) * (newScale / oldScale)
  panY.value = my - (my - panY.value) * (newScale / oldScale)
  scale.value = newScale
}

// ═══════════════════════════════════════════════════════════
// 4. 编辑 / 详情 模式 & 文本参数
// ═══════════════════════════════════════════════════════════
const mode = ref('edit')         // 'edit' = 编辑模式, 'view' = 只读详情
const editOverlays = ref([])     // 编辑模式下的 HTML 覆盖层列表
const MAX_CHARS = 20             // 每个标签最多字符数
const LINE_CHARS = 10            // 每行最多字符数（超过则换行）

/** 根据文本长度计算方框宽度（至少 minW，最多 LINE_CHARS 个字） */
function calcBoxW(text, minW, fs = 11) {
  const len = text.length
  const lineW = Math.min(len, LINE_CHARS) * (fs * 0.7) + 24
  return Math.max(minW, lineW)
}

// ═══════════════════════════════════════════════════════════
// 5. 调色板 —— 每根大骨按索引循环取色
// ═══════════════════════════════════════════════════════════
const BONE_COLORS = [
  '#B37DD8', '#6C9E42', '#D77D1E', '#8793B9', '#CE75B8',
  '#668FF5', '#00A0C8', '#BB8C00', '#00A68D', '#E96F56',
]

function getBoneColor(bigIndex) {
  return BONE_COLORS[bigIndex % BONE_COLORS.length]
}

/** 将 hex 颜色转为指定透明度的 rgba（用于方框浅色背景） */
function lightenColor(hex, alpha = 0.12) {
  const r = parseInt(hex.slice(1, 3), 16)
  const g = parseInt(hex.slice(3, 5), 16)
  const b = parseInt(hex.slice(5, 7), 16)
  return `rgba(${r},${g},${b},${alpha})`
}

// ═══════════════════════════════════════════════════════════
// 6. 骨骼标签的 hover 编辑（大骨/中骨/小骨）
//    原理：鼠标移入时将 overlay div 切换为 input，
//          移出或失焦时恢复为文本并重绘。
// ═══════════════════════════════════════════════════════════
const hoveringOverlayId = ref(null)

function onOverlayBlur() {
  hoveringOverlayId.value = null
  renderGraph()
}

function onOverlayInput(e, ov) {
  const val = e.target.value
  if (val.length > MAX_CHARS) {
    e.target.value = val.slice(0, MAX_CHARS)
    ov.boneRef.label = e.target.value
  } else {
    ov.boneRef.label = val
  }
}

function onOverlayMouseEnter(ov) {
  if (mode.value === 'edit') {
    hoveringOverlayId.value = ov.id
    nextTick(() => {
      const el = document.querySelector(`#edit-input-${ov.id}`)
      if (el) el.focus()
    })
  }
}

function onOverlayMouseLeave(ov) {
  if (hoveringOverlayId.value === ov.id) {
    hoveringOverlayId.value = null
    renderGraph()
  }
}

// ═══════════════════════════════════════════════════════════
// 7. 骨骼增删操作
// ═══════════════════════════════════════════════════════════

/** 删除骨骼（大骨/中骨/小骨），删除后自动重绘 */
function deleteBone(delInfo) {
  if (!delInfo) return
  const { type, bigId, midId, smId } = delInfo
  if (type === 'big') {
    const idx = fishData.bigBones.findIndex((b) => b.id === bigId)
    if (idx >= 0) fishData.bigBones.splice(idx, 1)
    // 删除后重新分配上下位置：偶数索引在上，奇数在下
    fishData.bigBones.forEach((b, i) => {
      b.position = i % 2 === 0 ? 'top' : 'bottom'
    })
  } else if (type === 'mid') {
    const big = fishData.bigBones.find((b) => b.id === bigId)
    if (!big) return
    const idx = big.midBones.findIndex((m) => m.id === midId)
    if (idx >= 0) big.midBones.splice(idx, 1)
  } else if (type === 'small') {
    const big = fishData.bigBones.find((b) => b.id === bigId)
    if (!big) return
    const mid = big.midBones.find((m) => m.id === midId)
    if (!mid) return
    const idx = mid.smallBones.findIndex((s) => s.id === smId)
    if (idx >= 0) mid.smallBones.splice(idx, 1)
  }
  renderGraph()
}

// ═══════════════════════════════════════════════════════════
// 8. 数据模型
//    fishData.bigBones 是一个数组，每项结构：
//    {
//      id, label, position('top'|'bottom'),
//      midBones: [{ id, label, smallBones: [{ id, label }] }]
//    }
// ═══════════════════════════════════════════════════════════
let idSeq = 0
const genId = () => `n_${++idSeq}`
const fishData = reactive({ bigBones: [] })

// --- 鱼头标签（hover 编辑）---
const headLabel = ref('问题详情')
const headHovering = ref(false)
const headInputRef = ref(null)

function onHeadMouseEnter() {
  if (mode.value !== 'edit') return
  headHovering.value = true
  nextTick(() => { headInputRef.value?.focus() })
}
function onHeadMouseLeave() {
  headHovering.value = false
}
function onHeadInput(e) {
  const val = e.target.value
  if (val.length > MAX_CHARS) {
    e.target.value = val.slice(0, MAX_CHARS)
    headLabel.value = e.target.value
  } else {
    headLabel.value = val
  }
}

// --- 新增骨骼 ---
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
  b.midBones.unshift({
    id: genId(),
    label: `中骨 ${n + 1}`,
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
  })
  renderGraph()
}

// ═══════════════════════════════════════════════════════════
// 9. 布局常量
//    下面的值决定了鱼骨图的整体尺寸和间距，
//    修改它们可以调整图表外观。
// ═══════════════════════════════════════════════════════════
const headPos = reactive({ x: 0, y: 0, w: 0, h: 0 })  // 鱼头位置尺寸
const tailPos = reactive({ x: 0, y: 0, w: 0, h: 0 })  // 鱼尾位置尺寸

const CY        = 350   // 主骨线的 Y 坐标（画布上的垂直中心）
const TAIL      = 50    // 鱼尾到主骨线起点的距离
const PAD_L     = 70    // 画布左侧留白
const BIG_GAP   = 100   // 大骨最小宽度
const DIAG      = 150   // 大骨斜线的默认长度（无中骨时）
const MID_LEN   = 90    // 中骨水平线长度
const BTN       = 24    // 加号按钮尺寸
const PAIR_GAP  = 60    // 同组上下两根大骨的主骨线间距
const MAX_SMALL_BONES = 6  // 每根中骨最多小骨数

// ═══════════════════════════════════════════════════════════
// 10. X6 绘图辅助函数
// ═══════════════════════════════════════════════════════════

/** 添加一条直线边（无箭头） */
function addEdge(s, t, color, w) {
  const none = { tagName: 'path', d: '' }
  graph.addEdge({
    shape: 'edge',
    source: { x: s[0], y: s[1] },
    target: { x: t[0], y: t[1] },
    attrs: {
      line: {
        stroke: color, strokeWidth: w, strokeLinecap: 'round',
        targetMarker: none, sourceMarker: none,
      },
    },
  })
}

/**
 * 添加一条贝塞尔弧线（用于多小骨的大括号连线）。
 * 用自定义 SVG <path> 节点实现，不依赖 X6 的 connector，
 * 这样可以精确控制弧线两端水平出入的方向。
 *
 * 控制点 cpX = 65% 的水平距离，确保：
 *   - 从起点水平出发（像大括号的根部）
 *   - 到终点水平到达（像大括号的枝端）
 */
function addCurvedEdge(s, t, color, w) {
  const x1 = Math.min(s[0], t[0])
  const y1 = Math.min(s[1], t[1])
  const padW = Math.abs(t[0] - s[0]) + 4
  const padH = Math.max(Math.abs(t[1] - s[1]), 2) + 4
  const ox = x1 - 2, oy = y1 - 2
  const sx = s[0] - ox, sy = s[1] - oy
  const tx = t[0] - ox, ty = t[1] - oy
  const cpX = Math.abs(t[0] - s[0]) * 0.65
  const d = `M ${sx} ${sy} C ${sx - cpX} ${sy}, ${tx + cpX} ${ty}, ${tx} ${ty}`
  graph.addNode({
    shape: 'rect',
    x: ox, y: oy,
    width: padW, height: padH,
    markup: [
      { tagName: 'rect', selector: 'body' },
      { tagName: 'path', selector: 'curve' },
    ],
    attrs: {
      body: { fill: 'transparent', stroke: 'none', pointerEvents: 'none' },
      curve: { d, fill: 'none', stroke: color, strokeWidth: w, strokeLinecap: 'round' },
    },
  })
}

/**
 * 添加带文本的矩形节点。
 * 编辑模式下不画 X6 节点，而是把信息推入 editOverlays 数组，
 * 由 Vue template 渲染为可交互的 HTML overlay。
 *
 * @param growDir  文本超长时方框的扩展方向：-1=向上扩展, 1=向下, 0=居中扩展
 */
function addLabelNode(
  id, x, y, w, h, text, bg, border, fg,
  fs = 12, fw = 500, rx = 4, boneRef = null, delInfo = null, growDir = 0,
) {
  const boneType = delInfo?.type || ''
  const lineH = Math.round(fs * 1.5)
  const needTwoLines = text.length > LINE_CHARS
  const displayH = needTwoLines ? lineH * 2 + 6 : h
  let displayY = y
  if (needTwoLines) {
    const extra = displayH - h
    if (growDir === -1) displayY = y - extra
    else if (growDir === 1) displayY = y
    else displayY = y - extra / 2
  }
  if (mode.value === 'edit' && boneRef) {
    editOverlays.value.push({
      id, x, y: displayY, w, h: displayH,
      boneRef, bg, border, fg, fs, fw, rx, delInfo, boneType,
    })
  } else {
    graph.addNode({
      id, shape: 'rect',
      x, y: displayY, width: w, height: displayH,
      attrs: {
        body: { fill: bg, stroke: border, strokeWidth: 1.2, rx, ry: rx },
        label: {
          text, fill: fg, fontSize: fs, fontWeight: fw,
          textWrap: { width: w - 12, height: displayH - 4, ellipsis: true },
        },
      },
    })
  }
}

/** 添加加号按钮节点（仅编辑模式可见） */
function addBtn(id, x, y, color, tip, fn, size) {
  if (mode.value !== 'edit') return
  const s = size || BTN
  callbackMap[id] = fn
  graph.addNode({
    id, shape: 'rect', x, y, width: s, height: s,
    attrs: {
      body: { fill: color, stroke: '#fff', strokeWidth: 1.5, rx: 4, ry: 4, cursor: 'pointer' },
      label: {
        text: '+', fill: '#fff',
        fontSize: s === BTN ? 16 : 13,
        fontWeight: 'bold', cursor: 'pointer',
      },
    },
  })
}

// ═══════════════════════════════════════════════════════════
// 11. 核心渲染函数 renderGraph()
//     每次调用会销毁旧画布、重新计算布局、绘制所有元素。
//
//     渲染流程：
//       ① 计算每根骨骼需要的空间（midBoneSpan, calcDiag, boneLeftExtent）
//       ② 将大骨两两分组，从右到左排列在主骨线上
//       ③ 计算画布边界，创建 X6 Graph
//       ④ 绘制主骨线、鱼头、鱼尾
//       ⑤ 遍历每根大骨 → 中骨 → 小骨，绘制斜线/水平线/弧线/方框
// ═══════════════════════════════════════════════════════════
function renderGraph() {
  if (!viewportRef.value) return

  // --- 清理旧画布 ---
  if (graph) graph.dispose()
  containerRef.value.innerHTML = ''
  Object.keys(callbackMap).forEach((k) => delete callbackMap[k])
  editOverlays.value = []

  // ─────────────────────────────────────
  // 11a. 方框尺寸常量
  // ─────────────────────────────────────
  const SM_BOX_MIN_W = 80,  SM_BOX_H = 32, SM_GAP_Y = 8   // 小骨方框
  const MID_BOX_MIN_W = 100, MID_BOX_H = 36                 // 中骨方框
  const BIG_BOX_MIN_W = 120, BIG_BOX_H = 44                 // 大骨方框
  const SM_LINK_LEN = 40    // 小骨到中骨方框的连线长度

  // ─────────────────────────────────────
  // 11b. 尺寸计算辅助函数
  // ─────────────────────────────────────

  /** 单个小骨方框高度（超过 LINE_CHARS 则增高） */
  function smBoxH(sm) {
    return sm.label.length > LINE_CHARS ? SM_BOX_H * 1.8 : SM_BOX_H
  }

  /** 一根中骨下所有小骨的总高度（含间距） */
  function totalSmallBonesH(m) {
    if (m.smallBones.length === 0) return 0
    let h = 0
    for (let j = 0; j < m.smallBones.length; j++) {
      if (j > 0) h += SM_GAP_Y
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
    const needed = Math.max(MID_BOX_H + 20, smH + MID_BOX_H)
    return Math.ceil(needed * Math.SQRT2)
  }

  /** 大骨斜线顶端（靠近主骨侧）给大骨标签留的空间 */
  function calcHeadMargin(b) {
    if (b.midBones.length === 0) return 80
    return Math.max(80, BIG_BOX_H + 40)
  }

  /**
   * 大骨斜线总长度 = 顶端留白 + 所有中骨间距之和 + 底端留白。
   * 中骨越多 / 小骨越多，斜线越长。
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

  function smBoxW(sm)  { return calcBoxW(sm.label, SM_BOX_MIN_W, 18) }
  function midBoxW(m)  { return calcBoxW(m.label, MID_BOX_MIN_W, 20) }
  function bigBoxW(b)  { return calcBoxW(b.label, BIG_BOX_MIN_W, 24) }

  /** 一根中骨下所有小骨方框的最大宽度 */
  function maxSmBoxW(m) {
    if (m.smallBones.length === 0) return 0
    let mx = SM_BOX_MIN_W
    for (const sm of m.smallBones) mx = Math.max(mx, smBoxW(sm))
    return mx
  }

  /**
   * 大骨从主骨交点(bx)向左延伸的最大距离。
   * = max(斜线末端, 各中骨+小骨的水平延伸)
   */
  function boneLeftExtent(b) {
    const dynamicDiag = calcDiag(b)
    const dd = dynamicDiag / Math.SQRT2   // 斜线在 X 轴的投影长度
    let maxLeft = dd + 80
    let accumOff = calcHeadMargin(b)
    for (const m of b.midBones) {
      const span = midBoneSpan(m)
      const centerOff = accumOff + span / 2
      accumOff += span
      const t = centerOff / dynamicDiag
      const axOff = dd * t
      const ml = midLen()
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

  // ─────────────────────────────────────
  // 11c. 大骨分组 & 主骨线布局
  //      大骨按添加顺序两两分组：第1根在上、第2根在下...
  //      组从鱼头（右）向鱼尾（左）排列。
  //      关键设计：鱼头到第一组的距离固定(HEAD_TO_FIRST_BONE)，
  //      增加中骨/小骨只会向鱼尾方向扩展。
  // ─────────────────────────────────────
  const GROUP_GAP = 30             // 相邻大骨组之间的基础间距（可调）

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

  const HEAD_TO_FIRST_BONE = 120   // 鱼头到第一组大骨节点的固定距离（可调）
  const tailSafeRight = PAD_L + TAIL + 50

  // 计算每组相对于第一组的向左偏移量
  const slots = []
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

  // 确定第一组 top 节点的绝对 X（保证最左侧不越过鱼尾安全线）
  let firstBoneX = tailSafeRight
  for (let gi = 0; gi < groups.length; gi++) {
    const g = groups[gi]
    const topExt = boneLeftExtent(g.top)
    const botExt = g.bot ? boneLeftExtent(g.bot) + PAIR_GAP : 0
    const needed = relOffsets[gi] + Math.max(topExt, botExt)
    firstBoneX = Math.max(firstBoneX, tailSafeRight + needed)
  }

  let mainEnd = firstBoneX + HEAD_TO_FIRST_BONE

  for (let gi = 0; gi < groups.length; gi++) {
    const g = groups[gi]
    const topX = firstBoneX - relOffsets[gi]
    slots.push({ b: g.top, x: topX, w: groupWidths[gi].w })
    if (g.bot) {
      slots.push({ b: g.bot, x: topX - PAIR_GAP, w: groupWidths[gi].w })
    }
  }

  // ─────────────────────────────────────
  // 11d. 计算画布边界（遍历所有骨骼找极值）
  // ─────────────────────────────────────
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
      const ml = midLen()
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
  if (shiftX > 0 || shiftY > 0) {
    for (const s of slots) s.x += shiftX
  }
  let shiftedMainEnd = mainEnd + shiftX
  const cy = CY + shiftY

  const rightmost = xMax + shiftX + 20
  if (rightmost > shiftedMainEnd) shiftedMainEnd = rightmost

  // ─────────────────────────────────────
  // 11e. 鱼头鱼尾动态缩放
  //      中骨越多，鱼头鱼尾越大（最大 2.5 倍）
  // ─────────────────────────────────────
  const FISH_SCALE_BASE = 1.6       // 基础缩放（无中骨时）
  const FISH_SCALE_MAX  = 2.5       // 最大缩放
  const totalMidCount = fishData.bigBones.reduce((sum, b) => sum + b.midBones.length, 0)
  const FISH_SCALE = Math.min(FISH_SCALE_MAX, FISH_SCALE_BASE + totalMidCount * 0.12)
  const TAIL_SVG_W = 120 * FISH_SCALE, TAIL_SVG_H = 120 * FISH_SCALE
  const HEAD_SVG_W = 120 * FISH_SCALE, HEAD_SVG_H = 120 * FISH_SCALE

  // ─────────────────────────────────────
  // 11f. 创建 X6 Graph 实例
  // ─────────────────────────────────────
  const PAD = 40
  const canvasW = Math.max(shiftedMainEnd + HEAD_SVG_W + 40, 900)
  const canvasH = Math.max(yMax + shiftY + PAD, Math.max(TAIL_SVG_H, HEAD_SVG_H) + 100, 700)

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

  // ─────────────────────────────────────
  // 11g. 绘制主骨线 + 鱼头鱼尾定位 + 新增大骨按钮
  // ─────────────────────────────────────
  const mainLeft = PAD_L + shiftX + TAIL
  const mainRight = shiftedMainEnd

  tailPos.x = mainLeft - TAIL_SVG_W
  tailPos.y = cy - TAIL_SVG_H / 2
  tailPos.w = TAIL_SVG_W
  tailPos.h = TAIL_SVG_H

  headPos.x = mainRight
  headPos.y = cy - HEAD_SVG_H / 2
  headPos.w = HEAD_SVG_W
  headPos.h = HEAD_SVG_H

  addEdge([mainLeft - TAIL_SVG_W * 0.3, cy], [mainRight + HEAD_SVG_W * 0.3, cy], '#00A68DFF', 3)
  addBtn('btn_add_big', mainLeft + 15, cy - BTN / 2, '#00A68D', '新增大骨', addBigBone)

  // ─────────────────────────────────────
  // 11h. 遍历每根大骨，绘制斜线 → 中骨 → 小骨
  // ─────────────────────────────────────
  let btnSeq = 0

  for (const slot of slots) {
    const { b, x: bx } = slot
    const bigIdx = fishData.bigBones.indexOf(b)
    const boneColor = getBoneColor(bigIdx)
    const dir = b.position === 'top' ? -1 : 1   // -1=向上, 1=向下

    // 大骨斜线起点(主骨上) → 终点
    const dynamicDiag = calcDiag(b)
    const dd = dynamicDiag / Math.SQRT2
    const sx = bx, sy = cy            // 起点（主骨交点）
    const ex = bx - dd, ey = cy + dir * dd   // 终点（斜线末端）

    // 大骨标签方框（放在斜线末端）
    const lw = bigBoxW(b), lh = BIG_BOX_H
    const boxX = ex - lw / 2
    const boxY = dir === -1 ? ey - lh : ey
    addLabelNode(
      `big_label_${b.id}`, boxX, boxY, lw, lh, b.label,
      boneColor, 'transparent', '#FFFFFF', 24, 600, 0,
      b, { type: 'big', bigId: b.id }, dir,
    )

    addEdge([sx, sy], [ex, ey], boneColor, 2)

    // 新增中骨按钮（靠近主骨交点侧）
    const bid = b.id
    const MID_BTN = 20
    const btnT = 40 / dynamicDiag
    const mbx = sx + (ex - sx) * btnT
    const mby = sy + (ey - sy) * btnT
    addBtn(`btn_mid_${b.id}`, mbx - MID_BTN / 2, mby - MID_BTN / 2, boneColor, '新增中骨', () => addMidBone(bid), MID_BTN)

    // --- 遍历中骨 ---
    let accumOffset = calcHeadMargin(b)
    for (let i = 0; i < b.midBones.length; i++) {
      const m = b.midBones[i]
      const span = midBoneSpan(m)
      const centerOffset = accumOffset + span / 2
      accumOffset += span

      // 中骨在斜线上的锚点(ax,ay)：按比例 t 插值
      const t = centerOffset / dynamicDiag
      const ax = sx + (ex - sx) * t
      const ay = sy + (ey - sy) * t

      // 中骨水平线：从锚点向左延伸
      const dynamicMidLen = midLen()
      const mex = ax - dynamicMidLen

      addEdge([ax, ay], [mex, ay], boneColor, 1.5)

      // 中骨方框（紧接水平线左端）
      const mlw = midBoxW(m), mlh = MID_BOX_H
      const midBoxX = mex - mlw
      const midBoxY = ay - mlh / 2
      addLabelNode(
        `mid_label_${m.id}`, midBoxX, midBoxY, mlw, mlh, m.label,
        boneColor, boneColor, '#FFFFFF', 20, 500, 16,
        m, { type: 'mid', bigId: b.id, midId: m.id },
      )

      // 新增小骨按钮（中骨水平线中间）
      const capMid = m.id
      if (m.smallBones.length < MAX_SMALL_BONES) {
        const SM_BTN = 18
        const smBtnCX = (ax + mex) / 2
        addBtn(
          `btn_sm_${++btnSeq}`,
          smBtnCX - SM_BTN / 2, ay - SM_BTN / 2,
          boneColor, '新增小骨',
          () => addSmallBone(bid, capMid),
          SM_BTN,
        )
      }

      // --- 小骨 ---
      if (m.smallBones.length > 0) {
        const smCount = m.smallBones.length
        const tSmH = totalSmallBonesH(m)
        const smStartY = ay - tSmH / 2       // 小骨群垂直居中于中骨锚点
        const lineOriginX = midBoxX           // 连线起点 = 中骨方框左边缘
        const smBoxRightX = lineOriginX - SM_LINK_LEN  // 小骨方框右边缘

        if (smCount === 1) {
          // 单个小骨：直线连接
          const sm = m.smallBones[0]
          const sw = smBoxW(sm), sh = smBoxH(sm)
          const smBoxCenterY = smStartY + sh / 2
          addEdge([lineOriginX, ay], [smBoxRightX, smBoxCenterY], boneColor, 1)
          addLabelNode(
            `sm_label_${sm.id}`, smBoxRightX - sw, smStartY, sw, sh, sm.label,
            'transparent', boneColor, '#1D2129', 18, 400, 16,
            sm, { type: 'small', bigId: b.id, midId: m.id, smId: sm.id },
          )
        } else {
          // 多个小骨：先画短横线，再用贝塞尔弧线分叉到各小骨
          const branchX = lineOriginX - 12
          addEdge([lineOriginX, ay], [branchX, ay], boneColor, 1)

          let curY = smStartY
          for (let j = 0; j < smCount; j++) {
            const sm = m.smallBones[j]
            const sw = smBoxW(sm), sh = smBoxH(sm)
            const smBoxCenterY = curY + sh / 2

            addCurvedEdge([branchX, ay], [smBoxRightX, smBoxCenterY], boneColor, 1)

            addLabelNode(
              `sm_label_${sm.id}`, smBoxRightX - sw, curY, sw, sh, sm.label,
              'transparent', boneColor, '#1D2129', 18, 400, 16,
              sm, { type: 'small', bigId: b.id, midId: m.id, smId: sm.id },
            )
            curY += sh + SM_GAP_Y
          }
        }
      }
    }
  }

  // ─────────────────────────────────────
  // 11i. 首次渲染时自动居中
  // ─────────────────────────────────────
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

// ═══════════════════════════════════════════════════════════
// 12. 缩放控制 & 生命周期
// ═══════════════════════════════════════════════════════════
function zoomIn()    { scale.value = Math.min(SCALE_MAX, scale.value + 0.1) }
function zoomOut()   { scale.value = Math.max(SCALE_MIN, scale.value - 0.1) }
function resetZoom() { needsCenter = true; scale.value = 1; renderGraph() }
function onConfirm() { emit('confirm') }
function onCancel()  { emit('cancel') }

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
    <!-- 视口：负责裁剪和接收鼠标事件 -->
    <div
      class="fishbone-viewport"
      ref="viewportRef"
      @pointerdown="onPointerDown"
      @wheel.prevent="onWheel"
    >
      <!-- 世界容器：通过 transform 实现平移+缩放 -->
      <div
        class="fishbone-world"
        ref="worldRef"
        :style="{ transform: `translate(${panX}px, ${panY}px) scale(${scale})` }"
      >
        <!-- X6 画布挂载点 -->
        <div class="fishbone-canvas" ref="containerRef" />

        <!-- 鱼尾 SVG -->
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
            viewBox="11 5 96 190"
            xmlns="http://www.w3.org/2000/svg"
            width="100%" height="100%"
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

        <!-- 鱼头 SVG + 标签 -->
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
            width="100%" height="100%"
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
          <!-- 鱼头标签：hover 切换为 input 编辑 -->
          <div
            class="fish-head-label"
            :title="headLabel"
            @mouseenter="onHeadMouseEnter"
            @mouseleave="onHeadMouseLeave"
          >
            <input
              v-if="headHovering && mode === 'edit'"
              ref="headInputRef"
              class="fish-head-input"
              :value="headLabel"
              :maxlength="MAX_CHARS"
              @input="onHeadInput"
              @blur="onHeadMouseLeave"
            />
            <span v-else class="fish-head-text">{{ headLabel }}</span>
          </div>
        </div>

        <!-- 骨骼编辑覆盖层：hover 时切换为 input -->
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
          @mouseenter="onOverlayMouseEnter(ov)"
          @mouseleave="onOverlayMouseLeave(ov)"
        >
          <input
            v-if="hoveringOverlayId === ov.id"
            :id="'edit-input-' + ov.id"
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
            :maxlength="MAX_CHARS"
            @input="(e) => onOverlayInput(e, ov)"
            @blur="onOverlayBlur(ov)"
          />
          <div
            v-else
            class="inline-edit-label"
            :style="{
              fontSize: ov.fs + 'px',
              fontWeight: ov.fw,
              color: ov.fg,
              background: ov.bg,
              borderColor: ov.border,
              borderRadius: ov.rx + 'px',
            }"
            :title="ov.boneRef.label"
          >{{ ov.boneRef.label }}</div>
          <span
            v-if="ov.delInfo"
            class="inline-edit-del"
            @mousedown.prevent.stop="deleteBone(ov.delInfo)"
          >&times;</span>
        </div>
      </div>
    </div>

    <!-- 右上角缩放百分比 -->
    <div class="scale-text">{{ (scale * 100).toFixed(0) }}%</div>

    <!-- 缩放控件 -->
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

/* ==================== 右上角缩放百分比 ==================== */
.scale-text {
  position: absolute;
  top: 12px;
  right: 16px;
  z-index: 20;
  font-size: 13px;
  color: #1d2129;
  user-select: none;
}

/* ==================== 缩放控件 ==================== */
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
.footer-left,
.footer-right {
  display: flex;
  align-items: center;
  gap: 8px;
}

/* ==================== 视口 + 世界容器 ==================== */
.fishbone-viewport {
  flex: 1;
  overflow: hidden;
  position: relative;
  cursor: grab;
  user-select: none;
}
.fishbone-world {
  position: absolute;
  top: 0;
  left: 0;
  transform-origin: 0 0;
  will-change: transform;
}

/* ==================== 鱼头鱼尾 ==================== */
.fish-part {
  position: absolute;
  z-index: 8;
  pointer-events: none;
}
.fish-head-label {
  position: absolute;
  top: 0;
  left: -4%;
  width: 55%;
  height: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  padding-top: 4px;
  pointer-events: auto;
  box-sizing: border-box;
}
.fish-head-text {
  width: 72px;
  font-size: 16px;
  font-weight: 600;
  color: #fff;
  text-align: center;
  line-height: 1.4;
  display: -webkit-box;
  -webkit-line-clamp: 4;
  -webkit-box-orient: vertical;
  overflow: hidden;
  word-break: break-all;
  cursor: default;
}
.fish-head-input {
  pointer-events: auto;
  width: 72px;
  text-align: center;
  border: none;
  background: transparent;
  font-size: 16px;
  font-weight: 600;
  color: #fff;
  outline: none;
  padding: 0 4px;
  border-radius: 0;
  box-sizing: border-box;
  cursor: text;
  user-select: text;
  font-family: inherit;
  line-height: 1.4;
}
.fish-head-input:focus {
  box-shadow: none;
}

/* ==================== 骨骼编辑覆盖层 ==================== */
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
  overflow: hidden;
  text-overflow: ellipsis;
  cursor: text;
  user-select: text;
  line-height: 1.4;
  font-family: inherit;
}
.inline-edit-input:focus {
  box-shadow: 0 0 0 2px rgba(22, 93, 255, 0.2);
}
.inline-edit-label {
  width: 100%;
  height: 100%;
  border: 1px solid;
  padding: 0 6px;
  text-align: center;
  box-sizing: border-box;
  overflow: hidden;
  display: flex;
  align-items: center;
  justify-content: center;
  line-height: 1.3;
  word-break: break-all;
  cursor: default;
}

/* 大骨标签无边框（与背景融为一体） */
.inline-edit-big .inline-edit-input,
.inline-edit-big .inline-edit-label {
  border: none;
}

/* 删除按钮（红色圆点 ×） */
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
