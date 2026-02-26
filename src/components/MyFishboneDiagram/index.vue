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

  三层 DOM 结构 (解决滚动问题):
    .fishbone-scroll  — 滚动容器 (overflow: auto)
      .fishbone-sizer — 占位 div，尺寸 = 画布大小，撑开滚动区域（因为 X6 内部 SVG 是 absolute 定位，不会撑开父容器）
      .fishbone-canvas — X6 画布挂载点 (absolute 定位覆盖在 sizer 上)
      鱼头/鱼尾/编辑overlay — 也是 absolute 定位
-->
<script setup>
import { ref, reactive, onMounted, nextTick } from 'vue'
import { Graph } from '@antv/x6'

// ============================== DOM 引用 ==============================
const containerRef = ref(null) // X6 画布挂载的 div
const scrollRef = ref(null)    // 外层滚动容器
const sizerRef = ref(null)     // 占位 div，用于撑开滚动区域
let graph = null               // AntV X6 Graph 实例（每次 renderGraph 会重建）
const callbackMap = {}         // 节点 id → 点击回调的映射表（用于 "+" 按钮）

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
// arr: 骨数组, key: 'position' 或 'side', values: ['top','bottom'] 或 ['left','right']
function rebalanceSides(arr, key, values) {
  arr.forEach((item, i) => { item[key] = values[i % values.length] })
}

// 根据 delInfo 定位到具体层级，执行删除并重平衡
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
const genId = () => `n_${++idSeq}`           // 简单的自增 id 生成器
const fishData = reactive({ bigBones: [] })   // 响应式数据源
const headLabel = ref('问题')                  // 鱼头文字（可编辑）

// 新增大骨: position 按索引奇偶交替 top/bottom
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

// 新增中骨: side 按索引奇偶交替 left/right
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

// 新增小骨: position 按索引奇偶交替 top/bottom
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
// 由 renderGraph 计算后写入，模板中用来定位 HTML overlay
const headPos = reactive({ x: 0, y: 0, w: 0, h: 0 })
const tailPos = reactive({ x: 0, y: 0, w: 0, h: 0 })

// ============================== 布局常量 ==============================
const CY = 350       // 主骨线的 Y 坐标（画布纵向中心）
const TAIL = 50      // 鱼尾区域宽度
const PAD_L = 70     // 画布左侧留白
const BIG_GAP = 250  // 大骨之间的最小间距
const DIAG = 150     // 大骨斜线的最小长度（无中骨时）
const MID_LEN = 90   // 中骨线的基础长度（无小骨时）
const SM_LEN = 42    // 小骨线的长度
const BTN = 24       // "+" 按钮的默认大小

// ============================== X6 绘制辅助函数 ==============================

// 画一条线段（无箭头），用于骨线
function addEdge(s, t, color, w) {
  graph.addEdge({
    shape: 'edge',
    source: { x: s[0], y: s[1] },
    target: { x: t[0], y: t[1] },
    attrs: {
      line: {
        stroke: color, strokeWidth: w, strokeLinecap: 'round',
        targetMarker: { tagName: 'path', d: '' }, // 空 marker = 无箭头
        sourceMarker: { tagName: 'path', d: '' },
      },
    },
  })
}

// 添加带文字的矩形节点（标签框）
// 编辑模式: 不创建 X6 节点，而是收集到 editOverlays 数组，由模板渲染 HTML input
// 查看模式: 创建 X6 rect 节点，文字超长时自动省略号
function addLabelNode(id, x, y, w, h, text, bg, border, fg, fs = 12, fw = 500, rx = 4, boneRef = null, delInfo = null) {
  const boneType = delInfo?.type || '' // 'big' | 'mid' | 'small'，用于 CSS class 区分 hover 效果
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
          textWrap: { width: w - 12, height: h, ellipsis: true }, // 文字溢出省略
        },
      },
    })
  }
}

// 添加 "+" 按钮节点（仅编辑模式）
// 点击事件通过 callbackMap 映射: 节点 id → 回调函数
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
// 每次数据变化后调用，完整重绘整个鱼骨图。
// 流程: 保存滚动位置 → 销毁旧 Graph → 计算布局尺寸 → 创建新 Graph → 逐个绘制元素 → 恢复滚动位置
function renderGraph() {
  if (!scrollRef.value) return

  // --- 1. 保存当前滚动位置（重绘后恢复） ---
  const wrap = scrollRef.value
  const sl = wrap.scrollLeft
  const st = wrap.scrollTop

  // --- 2. 清理旧状态 ---
  if (graph) graph.dispose()
  containerRef.value.innerHTML = ''
  Object.keys(callbackMap).forEach((k) => delete callbackMap[k])
  editOverlays.value = []

  // --- 3. 布局计算 ---

  // 计算一条中骨在大骨斜线上需要占据的长度（取决于它有多少小骨）
  function midBoneSpan(m) {
    return Math.max(60, m.smallBones.length * 40 + 30)
  }

  // 计算一根大骨的斜线总长度（取决于它有多少中骨，以及每条中骨的 span）
  function calcDiag(b) {
    if (b.midBones.length === 0) return DIAG
    let total = 50
    for (const m of b.midBones) total += midBoneSpan(m)
    total += 40
    return Math.max(DIAG, total)
  }

  // 计算一根大骨在主骨线上占据的水平宽度
  // 取三个值的最大值: 最小间距、斜线水平投影+余量、最长中骨+余量
  function boneW(b) {
    const diagDx = calcDiag(b) / Math.SQRT2 // 斜线45°的水平投影
    let mw = 0
    for (const m of b.midBones) mw = Math.max(mw, MID_LEN + m.smallBones.length * 50 + 80)
    return Math.max(BIG_GAP, diagDx + 80, mw + 80)
  }

  // 计算所有大骨的总宽度和每根大骨的分配位置
  const boneWidths = fishData.bigBones.map((b) => ({ b, w: boneW(b) }))
  let totalBoneW = 0
  for (const bw of boneWidths) totalBoneW += bw.w
  const mainEnd = PAD_L + TAIL + 80 + totalBoneW + 60 // 主骨线右端点（鱼头左侧）

  // 从右(鱼头)往左(鱼尾)分配每根大骨的 x 中心位置
  let cx = mainEnd - 60
  const slots = boneWidths.map(({ b, w }) => {
    cx -= w
    return { b, x: cx + w / 2, w }
  })

  // 画布尺寸 = max(内容所需, 容器可视区域)，确保内容少时也能撑满
  const wrapW = wrap.clientWidth
  const wrapH = wrap.clientHeight
  const canvasW = Math.max(mainEnd + 100, wrapW)

  // 计算纵向范围（遍历所有大骨的末端 y 坐标，取极值）
  let yMin = CY, yMax = CY
  for (const sl2 of slots) {
    const dir = sl2.b.position === 'top' ? -1 : 1
    const dd = calcDiag(sl2.b) / Math.SQRT2
    const ey = CY + dir * dd
    yMin = Math.min(yMin, ey - 80)
    yMax = Math.max(yMax, ey + 80)
  }
  const canvasH = Math.max(yMax - yMin + 200, wrapH)

  // 设置 sizer div 尺寸，让滚动容器能感知到内容大小并显示滚动条
  sizerRef.value.style.width = canvasW + 'px'
  sizerRef.value.style.height = canvasH + 'px'

  // --- 4. 创建 X6 Graph 实例 ---
  graph = new Graph({
    container: containerRef.value,
    width: canvasW,
    height: canvasH,
    background: { color: '#FAFBFC' },
    grid: { visible: true, type: 'dot', size: 20, args: { color: '#E5E6EB', thickness: 1 } },
    panning: false,        // 禁用画布拖拽（用外层 scroll 代替）
    mousewheel: false,     // 禁用滚轮缩放
    interacting: { nodeMovable: false }, // 节点不可拖动
  })

  // 监听节点点击，转发到 callbackMap 中注册的回调（"+" 按钮用）
  graph.on('node:click', ({ node }) => {
    const fn = callbackMap[node.id]
    if (fn) fn()
  })

  // --- 5. 绘制鱼尾和鱼头（计算位置，实际图形由 HTML overlay 渲染） ---
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

  // --- 6. 绘制主骨线（鱼尾右侧 → 鱼头左侧的水平线） ---
  addEdge([tailPos.x + TAIL_W, CY], [headPos.x, CY], '#0FC6C2', 3)

  // "新增大骨" 按钮，紧贴鱼尾右侧
  addBtn('btn_add_big', tailPos.x + TAIL_W + 6, CY - BTN / 2, '#165DFF', '新增大骨', addBigBone)

  let btnSeq = 0

  // --- 7. 遍历每根大骨，绘制大骨线、中骨线、小骨线 ---
  for (const slot of slots) {
    const { b, x: bx } = slot
    const dir = b.position === 'top' ? -1 : 1 // top 向上(-1), bottom 向下(+1)
    const dynamicDiag = calcDiag(b)
    const dd = dynamicDiag / Math.SQRT2        // 斜线的水平/垂直投影（45°角）

    // 大骨线: 起点(sx,sy)在主骨线上, 终点(ex,ey)在斜上方或斜下方
    const sx = bx, sy = CY
    const ex = bx - dd, ey = CY + dir * dd

    // 大骨标签框（白底黑边，120×32）
    const lw = 120, lh = 32
    const boxX = ex - lw / 2
    const boxY = dir === -1 ? ey - lh : ey // top 时标签在线的上方，bottom 时在下方
    const bigLabelId = `big_label_${b.id}`
    addLabelNode(bigLabelId, boxX, boxY, lw, lh, b.label, '#FFFFFF', '#1D2129', '#1D2129', 13, 600, 8, b, { type: 'big', bigId: b.id })

    // 大骨斜线
    addEdge([ex, ey], [sx, sy], '#0FC6C2', 2)

    // "新增中骨" 按钮，位于大骨线靠近主骨的一端
    const bid = b.id
    const MID_BTN = 20
    const btnT = 40 / dynamicDiag // 按钮在大骨线上的比例位置（靠近主骨端）
    const mbx = ex + (sx - ex) * btnT
    const mby = ey + (sy - ey) * btnT
    addBtn(`btn_mid_${b.id}`, mbx - MID_BTN / 2, mby - MID_BTN / 2, '#165DFF', '新增中骨', () => addMidBone(bid), MID_BTN)

    // --- 8. 遍历该大骨下的中骨 ---
    // 中骨沿大骨线方向排列，用 accumOffset 累积偏移量
    let accumOffset = 40
    for (let i = 0; i < b.midBones.length; i++) {
      const m = b.midBones[i]
      const span = midBoneSpan(m)
      const centerOffset = accumOffset + span / 2
      accumOffset += span

      // 用 t 值在大骨线上插值，得到中骨的起点 (ax, ay)
      const t = centerOffset / dynamicDiag
      const ax = sx + (ex - sx) * t
      const ay = sy + (ey - sy) * t

      // msign: 中骨向左(-1)还是向右(+1)延伸
      const msign = m.side === 'left' ? -1 : 1
      // 中骨长度随小骨数量动态增长
      const dynamicMidLen = MID_LEN + m.smallBones.length * 50
      const mex = ax + msign * dynamicMidLen // 中骨终点 x
      const mey = ay                         // 中骨是水平的，y 不变

      // 中骨线
      addEdge([ax, ay], [mex, mey], '#0FC6C2', 1.5)

      // 中骨标签框（浅蓝底蓝边，80×24）
      const mlw = 80, mlh = 24
      const midLabelId = `mid_label_${m.id}`
      addLabelNode(midLabelId, mex + (msign === 1 ? 4 : -mlw - 4), mey - mlh / 2, mlw, mlh, m.label, '#E8F3FF', '#165DFF', '#1D2129', 11, 500, 4, m, { type: 'mid', bigId: b.id, midId: m.id })

      // "新增小骨" 按钮
      const capMid = m.id
      const SM_BTN = 18
      const btnGap = 20
      const smBtnX = mex + (msign === 1 ? -SM_BTN - btnGap : btnGap)
      addBtn(`btn_sm_${++btnSeq}`, smBtnX, mey - SM_BTN / 2, '#165DFF', '新增小骨', () => addSmallBone(bid, capMid), SM_BTN)

      // --- 9. 遍历该中骨下的小骨 ---
      const smdd = SM_LEN / Math.SQRT2 // 小骨线也是 45° 角

      // 小骨均匀分布在中骨线的起点到按钮之间
      const smZoneStart = ax + msign * 40
      const smZoneEnd = smBtnX + (msign === 1 ? 0 : SM_BTN)
      for (let j = 0; j < m.smallBones.length; j++) {
        const sm = m.smallBones[j]
        // 均匀分布: 第 j 条小骨在区间上的比例位置
        const st2 = (j + 1) / (m.smallBones.length + 1)
        const smx = smZoneStart + (smZoneEnd - smZoneStart) * st2
        const smy = ay
        const sd = sm.position === 'top' ? -1 : 1
        const smEndX = smx - smdd
        const smEndY = smy + sd * smdd

        // 小骨斜线
        addEdge([smx, smy], [smEndX, smEndY], '#0FC6C2', 1)

        // 小骨标签（透明无边框，只显示文字）
        const slw = 64, slh = 18
        const smLabelId = `sm_label_${sm.id}`
        addLabelNode(smLabelId, smEndX - slw / 2, smEndY + (sd === 1 ? 3 : -slh - 3), slw, slh, sm.label, 'transparent', 'transparent', '#4E5969', 10, 400, 3, sm, { type: 'small', bigId: b.id, midId: m.id, smId: sm.id })
      }
    }
  }

  // --- 10. 恢复滚动位置 ---
  nextTick(() => {
    wrap.scrollLeft = sl
    wrap.scrollTop = st
  })
}

// ============================== 初始化 ==============================
onMounted(async () => {
  await nextTick()
  renderGraph()
})
</script>

<!--
  模板结构说明:
  ┌─ .fishbone-page (全屏 flex 纵向布局)
  │  ├─ header.fishbone-bar — 顶部工具栏（编辑/查看切换、统计标签）
  │  └─ .fishbone-scroll — 滚动容器
  │     ├─ .fishbone-sizer — 占位 div（撑开滚动区域）
  │     ├─ .fishbone-canvas — X6 画布挂载点
  │     ├─ .fish-part (鱼尾) — SVG 三角形
  │     ├─ .fish-part (鱼头) — SVG 弧形 + 可编辑文字
  │     └─ .inline-edit-wrap × N — 编辑模式的标签覆盖层 (input + 删除按钮)
-->
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
      <!-- 占位 div: 宽高由 renderGraph 动态设置，在文档流中撑开滚动区域 -->
      <div class="fishbone-sizer" ref="sizerRef"></div>
      <!-- X6 画布挂载点: absolute 定位，覆盖在 sizer 上 -->
      <div class="fishbone-canvas" ref="containerRef" />

      <!-- 鱼尾: SVG 三角形，位置由 tailPos 控制 -->
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

      <!-- 鱼头: SVG 弧形矩形 + 居中文字（编辑模式为 input，查看模式为 span） -->
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

      <!--
        编辑覆盖层: 编辑模式下，每个骨标签渲染为一个 absolute 定位的 input
        - 位置/尺寸由 renderGraph 计算
        - boneType class 用于区分 hover 样式（大骨 hover 边框变蓝，中骨 hover 边框消失）
        - 右上角 "×" 按钮用于删除
      -->
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
  flex-shrink: 0; /* 不被压缩 */
}
.fishbone-logo {
  font-size: 17px;
  font-weight: 700;
  color: #1d2129;
  letter-spacing: .5px;
}

/* ==================== 滚动容器 + 画布 ==================== */
/* 三层结构: scroll(滚动) > sizer(占位) + canvas(X6画布，absolute) */
.fishbone-scroll {
  flex: 1;           /* 占据剩余高度 */
  overflow: auto;    /* 内容超出时显示滚动条 */
  position: relative; /* 作为子元素 absolute 的定位基准 */
}
.fishbone-sizer {
  pointer-events: none; /* 不拦截鼠标事件，穿透到下面的画布 */
}
.fishbone-canvas {
  position: absolute;
  top: 0;
  left: 0;
}

/* ==================== 鱼头鱼尾 overlay ==================== */
.fish-part {
  position: absolute;
  z-index: 8; /* 在画布之上，在编辑层之下 */
}
.fish-part-svg {
  width: 100%;
  height: 100%;
  display: block;
}

/* 鱼头文字层: 绝对定位覆盖在鱼头 SVG 上，居中显示 */
.fish-head-label {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  pointer-events: none; /* 容器不拦截事件 */
}
.fish-head-input {
  pointer-events: auto; /* input 本身可以点击 */
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

/* ==================== 编辑覆盖层 (input + 删除按钮) ==================== */
.inline-edit-wrap {
  position: absolute;
  z-index: 10; /* 在所有画布元素之上 */
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
/* 大骨标签: hover 时边框变蓝 */
.inline-edit-big:hover .inline-edit-input {
  border-color: #165DFF;
}
/* 中骨标签: hover 时边框消失 */
.inline-edit-mid:hover .inline-edit-input {
  border-color: transparent;
}

/* 删除按钮: 红色圆形 "×"，右上角 */
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
