<!-- 鱼骨图组件 -->
<script setup>
import { ref, reactive, onMounted, onBeforeUnmount, nextTick, computed } from 'vue'
import { Graph } from '@antv/x6'
import { IconZoomIn, IconZoomOut, IconOriginalSize } from '@arco-design/web-vue/es/icon'
import { calculateLayout, LINE_CHARS, PAD_L, TAIL, EMPTY_OFFSET_X, BTN_SIZE } from './layout'
import { createDrawer, getBoneColor } from './drawer'

// 事件
const emit = defineEmits(['confirm', 'cancel'])

// 加载状态
const loading = ref(false)

// 显示缩放百分比
const displayScale = computed(() => {
  if (isFirstRender.value) return 100
  return Math.round(scale.value / baseScale.value * 100)
})

// 初始化入口，外部调用 init(data) 渲染图表
async function init(dataOrPromise) {
  needsCenter = true
  isFirstRender.value = true
  // 支持 Promise 或 async 函数
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
  // 等待 DOM 准备好后渲染
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

// 填充数据，自动生成 id 和 position
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

// 获取纯数据（不含 id），用于持久化
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

// DOM 引用
const containerRef = ref(null)
const viewportRef = ref(null)
const worldRef = ref(null)
let graph = null
let needsCenter = true
const callbackMap = {}

// 画布拖拽平移
const panX = ref(0)
const panY = ref(0)
const scale = ref(1)
const baseScale = ref(1)
const isFirstRender = ref(true)
const SCALE_MIN = 0.001
const SCALE_MAX = 1000
let isPanning = false
let panStartX = 0
let panStartY = 0
let panOriginX = 0
let panOriginY = 0
let didDrag = false

// 指针按下，开始拖拽
function onPointerDown(e) {
  if (e.target.closest('.inline-edit-wrap') || e.target.closest('.fish-head-label')) return
  isPanning = true
  didDrag = false
  panStartX = e.clientX
  panStartY = e.clientY
  panOriginX = panX.value
  panOriginY = panY.value
  viewportRef.value.style.cursor = 'grabbing'
}

// 指针移动，拖拽画布
function onPointerMove(e) {
  if (!isPanning) return
  const dx = e.clientX - panStartX
  const dy = e.clientY - panStartY
  if (Math.abs(dx) > 3 || Math.abs(dy) > 3) didDrag = true
  panX.value = panOriginX + dx
  panY.value = panOriginY + dy
}

// 指针抬起，结束拖拽
function onPointerUp() {
  if (!isPanning) return
  isPanning = false
  if (viewportRef.value) viewportRef.value.style.cursor = ''
}

// 滚轮缩放，以鼠标位置为中心
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

// 模式：编辑/详情
const mode = defineModel({ default: 'edit' })
const editOverlays = ref([])
const MAX_CHARS = 20

// 骨骼编辑覆盖层
const hoveringOverlayId = ref(null)
const originalLabel = ref('')

// 覆盖层失焦，值变化时重绘
function onOverlayBlur() {
  const currentLabel = hoveringOverlayId.value
    ? editOverlays.value.find(ov => ov.id === hoveringOverlayId.value)?.boneRef.label
    : ''
  if (currentLabel !== originalLabel.value) {
    renderGraph()
  }
  hoveringOverlayId.value = null
}

// 输入框输入
function onOverlayInput(e, ov) {
  const val = e.target.value
  if (val.length > MAX_CHARS) {
    e.target.value = val.slice(0, MAX_CHARS)
    ov.boneRef.label = e.target.value
  } else {
    ov.boneRef.label = val
  }
}

// 鼠标进入覆盖层
function onOverlayMouseEnter(ov) {
  if (mode.value === 'edit') {
    originalLabel.value = ov.boneRef.label
    hoveringOverlayId.value = ov.id
    nextTick(() => {
      const el = document.querySelector(`#edit-input-${ov.id}`)
      if (el) el.focus()
    })
  }
}

// 获取显示标签，超过10字换行，最多20字
function getDisplayLabel(text) {
  let label = text || ''
  if (label.length > 20) label = label.slice(0, 20)
  if ((mode.value === 'view' || mode.value === 'edit') && label.length > 10) {
    return label.slice(0, 10) + '\n' + label.slice(10)
  }
  return label
}

// 鼠标离开覆盖层
function onOverlayMouseLeave(ov) {
  if (hoveringOverlayId.value === ov.id) {
    hoveringOverlayId.value = null
    renderGraph()
  }
}

// 删除骨骼
function deleteBone(delInfo) {
  if (!delInfo) return
  const { type, bigId, midId, smId } = delInfo
  if (type === 'big') {
    const idx = fishData.bigBones.findIndex((b) => b.id === bigId)
    if (idx >= 0) fishData.bigBones.splice(idx, 1)
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

// ID 生成器
let idSeq = 0
const genId = () => `n_${++idSeq}`
const fishData = reactive({ bigBones: [] })

// 鱼头标签
const headLabel = ref('问题详情')
const headHovering = ref(false)
const headInputRef = ref(null)
const headFontSize = ref(14)
const headTextWidth = ref(72)

// 鱼头显示文本
const displayHeadLabel = computed(() => {
  let text = headLabel.value
  if (text.length > 20) text = text.slice(0, 20)
  if ((mode.value === 'view' || (mode.value === 'edit' && !headHovering.value)) && text.length > 10) {
    return text.slice(0, 10) + '\n' + text.slice(10)
  }
  return text
})

// 鱼头鱼尾位置
const headPos = reactive({ x: 0, y: 0, w: 0, h: 0 })
const tailPos = reactive({ x: 0, y: 0, w: 0, h: 0 })
const originalHeadLabel = ref('')

// 鼠标进入鱼头
function onHeadMouseEnter() {
  if (mode.value !== 'edit') return
  originalHeadLabel.value = headLabel.value
  headHovering.value = true
  nextTick(() => { headInputRef.value?.focus() })
}

// 鼠标离开鱼头
function onHeadMouseLeave() {
  if (headLabel.value !== originalHeadLabel.value) {
    renderGraph()
  }
  headHovering.value = false
}

// 鱼头输入
function onHeadInput(e) {
  const val = e.target.value
  if (val.length > MAX_CHARS) {
    e.target.value = val.slice(0, MAX_CHARS)
    headLabel.value = e.target.value
  } else {
    headLabel.value = val
  }
}

// 新增大骨
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

// 新增中骨
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

// 新增小骨
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

// 核心渲染函数
function renderGraph() {
  if (!viewportRef.value) return

  // 清理旧画布
  if (graph) graph.dispose()
  containerRef.value.innerHTML = ''
  Object.keys(callbackMap).forEach((k) => delete callbackMap[k])
  editOverlays.value = []

  // 计算布局
  const layout = calculateLayout(fishData)
  const {
    slots, canvasW, canvasH, shiftedMainEnd, cy, shiftX, shiftY,
    FISH_SCALE, HEAD_SVG_W, HEAD_SVG_H, TAIL_SVG_W, TAIL_SVG_H,
    smBoxH, midBoxH, bigBoxH, totalSmallBonesH, midBoneSpan, calcHeadMargin, calcDiag,
    smBoxW, midBoxW, bigBoxW, maxSmBoxW, BIG_BOX_H, MID_BOX_H, SM_LINK_LEN, SM_GAP_Y,
    calcDynamicMidLen,
  } = layout

  const PAD = 40

  // 创建 X6 画布
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

  // 创建绘图器
  const { addEdge, addCurvedEdge, addLabelNode, addBtn } = createDrawer({
    graph, mode, editOverlays, callbackMap, LINE_CHARS,
  })

  // 鱼头文字尺寸随缩放联动
  const FISH_SCALE_BASE = 1.6
  headFontSize.value = Math.round(14 * (FISH_SCALE / FISH_SCALE_BASE))
  headTextWidth.value = Math.round(72 * (FISH_SCALE / FISH_SCALE_BASE))

  // 节点点击事件
  graph.on('node:click', ({ node }) => {
    if (didDrag) return
    const fn = callbackMap[node.id]
    if (fn) fn()
  })

  // 主骨线位置
  const mainLeft = PAD_L + shiftX + TAIL
  const mainRight = shiftedMainEnd

  // 鱼尾位置
  tailPos.x = mainLeft - TAIL_SVG_W
  tailPos.y = cy - TAIL_SVG_H / 2
  tailPos.w = TAIL_SVG_W
  tailPos.h = TAIL_SVG_H

  // 鱼头位置
  headPos.x = mainRight
  headPos.y = cy - HEAD_SVG_H / 2
  headPos.w = HEAD_SVG_W
  headPos.h = HEAD_SVG_H

  // 绘制主骨线
  addEdge([mainLeft - TAIL_SVG_W * 0.3, cy], [mainRight + HEAD_SVG_W * 0.3, cy], '#00A68DFF', 4)
  // 新增大骨按钮
  addBtn('btn_add_big', mainLeft + 15, cy - BTN_SIZE / 2, '#00A68D', '新增大骨', addBigBone, BTN_SIZE)

  let btnSeq = 0

  // 遍历每根大骨
  for (const slot of slots) {
    const { b, x: bx } = slot
    const bigIdx = fishData.bigBones.indexOf(b)
    const boneColor = getBoneColor(bigIdx)
    const dir = b.position === 'top' ? -1 : 1

    // 大骨斜线
    const dynamicDiag = calcDiag(b)
    const dd = dynamicDiag / Math.SQRT2
    const sx = bx, sy = cy
    const ex = bx - dd, ey = cy + dir * dd

    // 大骨标签
    const lw = bigBoxW(b), lh = bigBoxH(b)
    const boxX = ex - lw / 2
    const boxY = dir === -1 ? ey - lh : ey
    addLabelNode(
      `big_label_${b.id}`, boxX, boxY, lw, lh, b.label,
      boneColor, 'transparent', '#FFFFFF', 14, 500, 4,
      b, { type: 'big', bigId: b.id }, dir,
    )

    addEdge([sx, sy], [ex, ey], boneColor, 3)

    // 新增中骨按钮
    const bid = b.id
    const btnDist = Math.min(40 + dynamicDiag * 0.06, 80)
    const btnT = btnDist / dynamicDiag
    const mbx = sx + (ex - sx) * btnT
    const mby = sy + (ey - sy) * btnT
    addBtn(`btn_mid_${b.id}`, mbx - BTN_SIZE / 2, mby - BTN_SIZE / 2, boneColor, '新增中骨', () => addMidBone(bid), BTN_SIZE)

    // 遍历中骨
    let accumOffset = calcHeadMargin(b)
    for (let i = 0; i < b.midBones.length; i++) {
      const m = b.midBones[i]
      const span = midBoneSpan(m)
      const centerOffset = accumOffset + span / 2
      accumOffset += span

      // 中骨锚点
      const t = centerOffset / dynamicDiag
      const ax = sx + (ex - sx) * t
      const ay = sy + (ey - sy) * t

      // 中骨水平线
      const dynamicMidLen = calcDynamicMidLen(m)
      const mex = ax - dynamicMidLen

      addEdge([ax, ay], [mex, ay], boneColor, 2)

      // 中骨标签
      const mlw = midBoxW(m), mlh = midBoxH(m)
      const midBoxX = mex - mlw + 2
      const midBoxY = ay - mlh / 2
      addLabelNode(
        `mid_label_${m.id}`, midBoxX, midBoxY, mlw, mlh, m.label,
        boneColor, boneColor, '#FFFFFF', 14, 500, 30,
        m, { type: 'mid', bigId: b.id, midId: m.id },
      )

      // 新增小骨按钮
      const capMid = m.id
      const smBtnCX = (ax + mex) / 2
      addBtn(
        `btn_sm_${++btnSeq}`,
        smBtnCX - BTN_SIZE / 2, ay - BTN_SIZE / 2,
        boneColor, '新增小骨',
        () => addSmallBone(bid, capMid),
        BTN_SIZE,
      )

      // 绘制小骨
      if (m.smallBones.length > 0) {
        const smCount = m.smallBones.length
        const tSmH = totalSmallBonesH(m)
        const smStartY = ay - tSmH / 2
        const lineOriginX = midBoxX
        const smBoxRightX = lineOriginX - SM_LINK_LEN

        if (smCount === 1) {
          // 单个小骨直线连接
          const sm = m.smallBones[0]
          const sw = smBoxW(sm), sh = smBoxH(sm)
          const smBoxCenterY = smStartY + sh / 2
          addEdge([lineOriginX, ay], [smBoxRightX, smBoxCenterY], boneColor, 1)
          addLabelNode(
            `sm_label_${sm.id}`, smBoxRightX - sw, smStartY, sw, sh, sm.label,
            'transparent', boneColor, '#1D2129', 12, 400, 30,
            sm, { type: 'small', bigId: b.id, midId: m.id, smId: sm.id },
          )
        } else {
          // 多个小骨弧线连接
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
              'transparent', boneColor, '#1D2129', 12, 400, 30,
              sm, { type: 'small', bigId: b.id, midId: m.id, smId: sm.id },
            )
            curY += sh + SM_GAP_Y
          }
        }
      }
    }
  }

  // 首次渲染自动居中
  if (needsCenter) {
    scale.value = 1
    const doCenter = () => {
      if (!viewportRef.value) return
      const vw = viewportRef.value.clientWidth
      const vh = viewportRef.value.clientHeight

      const padding = 60
      const scaleX = (vw - padding * 2) / canvasW
      const scaleY = (vh - padding * 2) / canvasH

      let fitScale = Math.min(scaleX, scaleY, 1)
      fitScale = Math.max(fitScale, SCALE_MIN)

      if (scaleX < 1 || scaleY < 1) {
        scale.value = fitScale
      } else {
        scale.value = 1
      }

      const isEmpty = fishData.bigBones.length === 0
      const offsetX = isEmpty ? EMPTY_OFFSET_X : 0

      const scaledW = canvasW * scale.value
      const scaledH = canvasH * scale.value
      panX.value = Math.round((vw - scaledW) / 2 + offsetX)
      panY.value = Math.round((vh - scaledH) / 2)

      if (isFirstRender.value) {
        baseScale.value = scale.value
        isFirstRender.value = false
      }

      needsCenter = false
    }
    nextTick(doCenter)
  }
}

// 缩放操作
function zoomIn()    { scale.value = Math.min(SCALE_MAX * baseScale.value, scale.value + 0.1 * baseScale.value) }
function zoomOut()   { scale.value = Math.max(SCALE_MIN * baseScale.value, scale.value - 0.1 * baseScale.value) }
function resetZoom() {
  if (isFirstRender.value) return
  needsCenter = true; scale.value = baseScale.value; renderGraph()
}
function onConfirm() { emit('confirm') }
function onCancel()  { emit('cancel') }

// 生命周期
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
    <!-- 视口 -->
    <div
      class="fishbone-viewport"
      ref="viewportRef"
      @pointerdown="onPointerDown"
      @wheel.prevent="onWheel"
    >
      <!-- 世界容器 -->
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
          <!-- 鱼头标签 -->
          <div
            class="fish-head-label"
            :title="mode === 'view' ? '' : headLabel"
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
            >{{ displayHeadLabel }}</span>
          </div>
        </div>

        <!-- 骨骼编辑覆盖层 -->
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
            v-if="hoveringOverlayId === ov.id && mode === 'edit'"
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
            :title="mode === 'view' ? '' : ov.boneRef.label"
          >{{ getDisplayLabel(ov.boneRef.label) }}</div>
          <span
            v-if="ov.delInfo && mode === 'edit'"
            class="inline-edit-del"
            @mousedown.prevent.stop="deleteBone(ov.delInfo)"
          >&times;</span>
        </div>
      </div>
    </div>

    <!-- 缩放百分比 -->
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
.fishbone-page {
  width: 100%;
  height: 100%;
  display: flex;
  flex-direction: column;
  background: #fff;
  position: relative;
}

.fishbone-loading {
  position: absolute;
  inset: 0;
  z-index: 50;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(255, 255, 255, 0.7);
}

.scale-text {
  position: absolute;
  top: 12px;
  right: 16px;
  z-index: 20;
  font-size: 13px;
  color: #1d2129;
  user-select: none;
}

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
  display: block;
  word-break: break-all;
  white-space: pre-wrap;
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

.inline-edit-wrap {
  position: absolute;
  z-index: 10;
  border-radius: 4px;
  display: flex;
  align-items: center;
  justify-content: center;
}
.inline-edit-input {
  width: 100%;
  height: 100%;
  border: 1.2px solid;
  padding: 2px 6px;
  text-align: center;
  outline: none;
  box-sizing: border-box;
  cursor: text;
  user-select: text;
  font-family: inherit;
  word-break: break-all;
  border-radius: inherit;
  background-color: transparent;
  line-height: inherit;
}
.inline-edit-input:focus {
  box-shadow: 0 0 0 2px rgba(22, 93, 255, 0.2);
}
.inline-edit-label {
  width: 100%;
  height: 100%;
  border: 1.2px solid;
  padding: 2px 6px;
  text-align: center;
  box-sizing: border-box;
  overflow: visible;
  word-break: break-all;
  white-space: pre-wrap;
  cursor: default;
  border-radius: inherit;
  display: flex;
  align-items: center;
  justify-content: center;
  line-height: 1.4;
}

.inline-edit-big .inline-edit-input,
.inline-edit-big .inline-edit-label {
  border: none;
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
  font-size: 14px;
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
