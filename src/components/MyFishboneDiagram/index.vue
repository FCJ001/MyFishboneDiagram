<!-- 鱼骨图组件 -->
<script setup>
import { ref, reactive, onMounted, nextTick, computed } from 'vue'
import { Graph } from '@antv/x6'
import { IconZoomIn, IconZoomOut, IconOriginalSize } from '@arco-design/web-vue/es/icon'
import { calculateLayout, LINE_CHARS, PAD_L, TAIL, EMPTY_OFFSET_X, BTN_HIT_SIZE, CENTER_OFFSET_Y, FISH_SCALE_BASE, CENTER_PADDING, INIT_RENDER_MAX_RETRIES } from './layout'
import { createDrawer, getBoneColor } from './drawer'
import { usePanZoom } from './usePanZoom'
import { useOverlayEdit } from './useOverlayEdit'
import { useViewportResize } from './useViewportResize'

// 事件
const emit = defineEmits(['confirm', 'cancel'])

// 加载状态
const loading = ref(false)

// DOM 引用
const containerRef = ref(null)
const viewportRef = ref(null)
const worldRef = ref(null)
let graph = null
let needsCenter = true
const callbackMap = {}

// 模式：编辑/详情
const mode = defineModel({ default: 'edit' })
const editOverlays = ref([])

// 基础缩放比
const baseScale = ref(1)
const isFirstRender = ref(true)

// --- composables ---
const {
  panX, panY, scale, displayScale,
  SCALE_MIN,
  onPointerDown, onWheel,
  zoomIn, zoomOut, getDidDrag,
} = usePanZoom({ viewportRef, isFirstRender, baseScale })

const {
  MAX_CHARS,
  hoveringOverlayId,
  visibleDelId,
  showDelConfirm,
  hideDelConfirm,
  onOverlayBlur,
  onOverlayInput,
  onOverlayMouseEnter,
  onOverlayMouseLeave,
  getDisplayLabel,
  deleteBone: _deleteBone,
} = useOverlayEdit({ mode, editOverlays, renderGraph })

function deleteBone(delInfo) {
  hideDelConfirm()
  _deleteBone(delInfo, fishData)
}

function setNeedsCenter() { needsCenter = true }

useViewportResize({ viewportRef, isFirstRender, renderGraph, setNeedsCenter })

// ID 生成器
let idSeq = 0
const genId = () => `n_${++idSeq}`
let colorSeq = 0
let bigBoneSeq = 0
const fishData = reactive({ bigBones: [] })

// 鱼头标签
const headLabel = ref('问题详情')
const headHovering = ref(false)
const headInputRef = ref(null)
const headFontSize = ref(14)
const headTextWidth = ref(72)

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

function onHeadMouseEnter() {
  if (mode.value !== 'edit') return
  originalHeadLabel.value = headLabel.value
  headHovering.value = true
  nextTick(() => { headInputRef.value?.focus() })
}

function onHeadMouseLeave() {
  if (headLabel.value !== originalHeadLabel.value) {
    renderGraph()
  }
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

// 新增大骨
function addBigBone() {
  const n = fishData.bigBones.length
  fishData.bigBones.push({
    id: genId(),
    colorIndex: colorSeq++,
    label: `大骨 ${++bigBoneSeq}`,
    position: n % 2 === 0 ? 'top' : 'bottom',
    midBoneSeq: 0,
    midBones: [],
  })
  renderGraph()
}

// 新增中骨
function addMidBone(bigId) {
  const b = fishData.bigBones.find((x) => x.id === bigId)
  if (!b) return
  b.midBones.unshift({
    id: genId(),
    label: `中骨 ${++b.midBoneSeq}`,
    smallBoneSeq: 0,
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
  m.smallBones.push({
    id: genId(),
    label: `小骨 ${++m.smallBoneSeq}`,
  })
  renderGraph()
}

// --- renderGraph 节流：用 rAF 合并同一帧内的多次调用 ---
let renderRafId = null

function renderGraph() {
  if (renderRafId !== null) return
  renderRafId = requestAnimationFrame(() => {
    renderRafId = null
    _renderGraph()
  })
}

// 核心渲染函数
function _renderGraph() {
  if (!viewportRef.value) return

  // 清理旧画布
  if (graph) {
    try { graph.dispose() } catch (_) { /* 已 dispose 时忽略 */ }
  }
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
  headFontSize.value = Math.round(14 * (FISH_SCALE / FISH_SCALE_BASE))
  headTextWidth.value = Math.round(72 * (FISH_SCALE / FISH_SCALE_BASE))

  // 节点点击事件
  graph.on('node:click', ({ node }) => {
    if (getDidDrag()) return
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
  addBtn('btn_add_big', mainLeft + 15, cy - BTN_HIT_SIZE / 2, '#00A68D', '新增大骨', addBigBone)

  let btnSeq = 0

  // 遍历每根大骨
  for (const slot of slots) {
    const { b, x: bx } = slot
    const boneColor = getBoneColor(b.colorIndex)
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
    addBtn(`btn_mid_${b.id}`, mbx - BTN_HIT_SIZE / 2, mby - BTN_HIT_SIZE / 2, boneColor, '新增中骨', () => addMidBone(bid))

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
        smBtnCX - BTN_HIT_SIZE / 2, ay - BTN_HIT_SIZE / 2,
        boneColor, '新增小骨',
        () => addSmallBone(bid, capMid),
      )

      // 绘制小骨
      if (m.smallBones.length > 0) {
        const smCount = m.smallBones.length
        const tSmH = totalSmallBonesH(m)
        const smStartY = ay - tSmH / 2
        const lineOriginX = midBoxX
        const smBoxRightX = lineOriginX - SM_LINK_LEN

        if (smCount === 1) {
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

      const scaleX = (vw - CENTER_PADDING * 2) / canvasW
      const scaleY = (vh - CENTER_PADDING * 2) / canvasH

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
      panY.value = Math.round((vh - scaledH) / 2 + CENTER_OFFSET_Y)

      if (isFirstRender.value) {
        baseScale.value = scale.value
        isFirstRender.value = false
      }

      needsCenter = false
    }
    nextTick(doCenter)
  }
}

// 缩放还原
function resetZoom() {
  if (isFirstRender.value) return
  needsCenter = true
  scale.value = baseScale.value
  renderGraph()
}

function onConfirm() { emit('confirm') }
function onCancel()  { emit('cancel') }

// 初始化入口
async function init(dataOrPromise) {
  needsCenter = true
  isFirstRender.value = true
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
  let retries = 0
  const tryRender = () => {
    const c = containerRef.value
    const vp = viewportRef.value
    if (c && vp && vp.clientHeight > 0) {
      renderGraph()
    } else if (retries < INIT_RENDER_MAX_RETRIES) {
      retries++
      setTimeout(tryRender, 60)
    }
  }
  nextTick(tryRender)
}

// 填充数据
function setData(data) {
  idSeq = 0
  colorSeq = 0
  bigBoneSeq = 0
  fishData.bigBones = []
  if (data.headLabel) headLabel.value = data.headLabel
  if (Array.isArray(data.bigBones)) {
    data.bigBones.forEach((bigItem, i) => {
      bigBoneSeq++
      const big = {
        id: genId(),
        colorIndex: colorSeq++,
        label: bigItem.label || `大骨 ${bigBoneSeq}`,
        position: i % 2 === 0 ? 'top' : 'bottom',
        midBoneSeq: 0,
        midBones: [],
      }
      if (Array.isArray(bigItem.midBones)) {
        bigItem.midBones.forEach((midItem) => {
          big.midBoneSeq++
          const mid = {
            id: genId(),
            label: midItem.label || `中骨 ${big.midBoneSeq}`,
            smallBoneSeq: 0,
            smallBones: [],
          }
          if (Array.isArray(midItem.smallBones)) {
            midItem.smallBones.forEach((smItem) => {
              mid.smallBoneSeq++
              mid.smallBones.push({
                id: genId(),
                label: smItem.label || `小骨 ${mid.smallBoneSeq}`,
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

// 纯净导出：仅包含业务字段，用于持久化/提交。不导出 id、colorIndex、position、midBoneSeq、smallBoneSeq 等内部字段。
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
          <a-popconfirm
            v-if="ov.delInfo && mode === 'edit'"
            content="确定删除吗？"
            type="warning"
            position="tr"
            popup-container="body"
            :popup-visible="visibleDelId === ov.id"
            @ok="deleteBone(ov.delInfo)"
            @cancel="hideDelConfirm"
          >
            <span
              class="inline-edit-del"
              @mousedown.prevent.stop
              @click.stop="showDelConfirm(ov.id)"
            >&times;</span>
          </a-popconfirm>
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
  pointer-events: none;
}

.zoom-control {
  position: absolute;
  bottom: 10px;
  left: 50%;
  transform: translateX(-50%);
  z-index: 20;
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
