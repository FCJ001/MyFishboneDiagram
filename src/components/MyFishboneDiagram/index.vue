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
import { ref, reactive, onMounted, onBeforeUnmount, nextTick, computed } from 'vue'
import { Graph } from '@antv/x6'
import { IconZoomIn, IconZoomOut, IconOriginalSize } from '@arco-design/web-vue/es/icon'
import { calculateLayout, LINE_CHARS, DIAG, MID_LEN, PAIR_GAP, PAD_L, TAIL, CY, MAX_SMALL_BONES, BIG_GAP } from './layout'
import { createDrawer, getBoneColor, lightenColor } from './drawer'

// ═══════════════════════════════════════════════════════════
// 1. 组件对外接口
// ═══════════════════════════════════════════════════════════
const emit = defineEmits(['confirm', 'cancel'])

const loading = ref(false)

/** 显示的缩放百分比（首次渲染显示100%，之后显示实际比例） */
const displayScale = computed(() => {
  if (isFirstRender.value) {
    return 100
  }
  return Math.round(scale.value / baseScale.value * 100)
})

/**
 * 初始化入口 —— 父组件调用 ref.init(dataOrPromise?) 触发渲染。
 * @param {Object|Promise|Function} [dataOrPromise]
 *   - 不传：渲染空图
 *   - 传对象：直接填充数据并渲染
 *   - 传 Promise / async 函数：先显示 loading，数据返回后渲染
 */
async function init(dataOrPromise) {
  needsCenter = true
  isFirstRender.value = true  // 重置为首次渲染
  if (dataOrPromise && (typeof dataOrPromise === 'function' || typeof dataOrPromise.then === 'function')) {
    loading.value = true
    try {
      const result = typeof dataOrPromise === 'function' ? await dataOrPromise() : await dataOrPromise
      if (result) setData(result)
    } finally {
      loading.value = false
    }
  } else if (dataOrPromise) {
    setData(dataOrPromise)
  }
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

/**
 * 从外部数据填充鱼骨图。
 * 会自动生成 id、分配 position，外部只需提供 label。
 */
function setData(data) {
  idSeq = 0
  fishData.bigBones = []
  if (data.headLabel) headLabel.value = data.headLabel
  if (Array.isArray(data.bigBones)) {
    data.bigBones.forEach((bigItem, i) => {
      const big = {
        id: genId(),
        label: bigItem.label || `大骨 ${i + 1}`,
        position: i % 2 === 0 ? 'top' : 'bottom',
        midBones: [],
      }
      if (Array.isArray(bigItem.midBones)) {
        bigItem.midBones.forEach((midItem, j) => {
          const mid = {
            id: genId(),
            label: midItem.label || `中骨 ${j + 1}`,
            smallBones: [],
          }
          if (Array.isArray(midItem.smallBones)) {
            midItem.smallBones.forEach((smItem, k) => {
              mid.smallBones.push({
                id: genId(),
                label: smItem.label || `小骨 ${k + 1}`,
              })
            })
          }
          big.midBones.push(mid)
        })
      }
      fishData.bigBones.push(big)
    })
  }
}

/**
 * 获取当前鱼骨图的纯数据（不含 id/position，可用于持久化）。
 */
function getData() {
  return {
    headLabel: headLabel.value,
    bigBones: fishData.bigBones.map(b => ({
      label: b.label,
      midBones: b.midBones.map(m => ({
        label: m.label,
        smallBones: m.smallBones.map(s => ({ label: s.label })),
      })),
    })),
  }
}

defineExpose({ init, setData, getData })

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
const baseScale = ref(1)          // 基准缩放比例（首次渲染时自动计算，用于百分比显示）
const isFirstRender = ref(true)  // 是否首次渲染（用于显示100%）
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
const headFontSize = ref(16)      // 随鱼头缩放动态调整
const headTextWidth = ref(72)     // 随鱼头缩放动态调整

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

const BTN       = 24    // 加号按钮尺寸

// ═══════════════════════════════════════════════════════════
// 11. 核心渲染函数 renderGraph()
//     每次调用会销毁旧画布、重新计算布局、绘制所有元素。
//
//     渲染流程：
//       ① 使用 layout.js 计算布局
//       ② 使用 drawer.js 绘制元素
// ═══════════════════════════════════════════════════════════
function renderGraph() {
  if (!viewportRef.value) return

  // --- 清理旧画布 ---
  if (graph) graph.dispose()
  containerRef.value.innerHTML = ''
  Object.keys(callbackMap).forEach((k) => delete callbackMap[k])
  editOverlays.value = []

  // ─────────────────────────────────────
  // 1. 使用 layout.js 计算布局
  // ─────────────────────────────────────
  const layout = calculateLayout(fishData)
  const {
    slots, canvasW, canvasH, shiftedMainEnd, cy, shiftX, shiftY,
    FISH_SCALE, HEAD_SVG_W, HEAD_SVG_H, TAIL_SVG_W, TAIL_SVG_H,
    smBoxH, totalSmallBonesH, midBoneSpan, calcHeadMargin, calcDiag,
    smBoxW, midBoxW, bigBoxW, maxSmBoxW, BIG_BOX_H, MID_BOX_H, SM_LINK_LEN, SM_GAP_Y,
  } = layout

  // ─────────────────────────────────────
  // 2. 创建 X6 Graph 实例
  // ─────────────────────────────────────
  const PAD = 40

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

  // ─────────────────────────────────────
  // 3. 创建绘图器（在 graph 创建之后）
  // ─────────────────────────────────────
  const { addEdge, addCurvedEdge, addLabelNode, addBtn } = createDrawer({
    graph, mode, editOverlays, callbackMap, LINE_CHARS,
  })

  // 鱼头文字尺寸随缩放联动
  const FISH_SCALE_BASE = 1.6
  headFontSize.value = Math.round(16 * (FISH_SCALE / FISH_SCALE_BASE))
  headTextWidth.value = Math.round(72 * (FISH_SCALE / FISH_SCALE_BASE))

  graph.on('node:click', ({ node }) => {
    if (didDrag) return
    const fn = callbackMap[node.id]
    if (fn) fn()
  })

  // ─────────────────────────────────────
  // 4. 绘制主骨线 + 鱼头鱼尾定位 + 新增大骨按钮
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
  // 5. 遍历每根大骨，绘制斜线 → 中骨 → 小骨
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

    // 新增中骨按钮（靠近主骨交点侧，距离随斜线长度动态调整）
    const bid = b.id
    const MID_BTN = 20
    const btnDist = Math.min(40 + dynamicDiag * 0.06, 80)
    const btnT = btnDist / dynamicDiag
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
      const dynamicMidLen = MID_LEN
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
  // 6. 首次渲染时自动居中
  // ─────────────────────────────────────
  if (needsCenter) {
    scale.value = 1
    const doCenter = () => {
      if (!viewportRef.value) return
      const vw = viewportRef.value.clientWidth
      const vh = viewportRef.value.clientHeight
      
      // 计算合适的缩放比例，让整个图形都能显示在视口内
      const padding = 60 // 四周留白
      const scaleX = (vw - padding * 2) / canvasW
      const scaleY = (vh - padding * 2) / canvasH
      
      // 取较小的缩放比例，确保图形完全显示
      let fitScale = Math.min(scaleX, scaleY, 1)
      fitScale = Math.max(fitScale, SCALE_MIN) // 不小于最小缩放
      
      // 只有当图形比视口大时才自动缩放
      if (scaleX < 1 || scaleY < 1) {
        scale.value = fitScale
      } else {
        scale.value = 1
      }
      
      // 居中显示
      const scaledW = canvasW * scale.value
      const scaledH = canvasH * scale.value
      panX.value = Math.round((vw - scaledW) / 2)
      panY.value = Math.round((vh - scaledH) / 2)
      
      // 标记首次渲染完成，设置参考缩放值为当前实际缩放比例
      if (isFirstRender.value) {
        baseScale.value = scale.value  // 记录当前缩放比例作为基准
        isFirstRender.value = false
      }
      
      needsCenter = false
    }
    nextTick(doCenter)
  }
}

// ═══════════════════════════════════════════════════════════
// 12. 缩放控制 & 生命周期
// ═══════════════════════════════════════════════════════════
function zoomIn()    { scale.value = Math.min(SCALE_MAX * baseScale.value, scale.value + 0.1 * baseScale.value) }
function zoomOut()   { scale.value = Math.max(SCALE_MIN * baseScale.value, scale.value - 0.1 * baseScale.value) }
function resetZoom() { 
  if (isFirstRender.value) {
    // 首次渲染时重置，保持当前全貌显示
    return
  }
  needsCenter = true; scale.value = baseScale.value; renderGraph() 
}
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
    <!-- 加载遮罩 -->
    <div v-if="loading" class="fishbone-loading">
      <a-spin tip="加载中..." />
    </div>
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
              :style="{ width: headTextWidth + 'px', fontSize: headFontSize + 'px' }"
              :value="headLabel"
              :maxlength="MAX_CHARS"
              @input="onHeadInput"
              @blur="onHeadMouseLeave"
            />
            <span
              v-else
              class="fish-head-text"
              :style="{ width: headTextWidth + 'px', fontSize: headFontSize + 'px' }"
            >{{ headLabel }}</span>
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
    <div class="scale-text">{{ displayScale }}%</div>

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

/* ==================== 加载遮罩 ==================== */
.fishbone-loading {
  position: absolute;
  inset: 0;
  z-index: 50;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(255, 255, 255, 0.7);
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
  text-align: center;
  border: none;
  background: transparent;
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
