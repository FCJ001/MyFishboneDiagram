# 鱼骨图组件实现详解

## 概述

鱼骨图（因果图/石川图）是一种用于问题分析的图形化工具，本组件实现了基于 Web 的交互式鱼骨图编辑器。

![鱼骨图结构示意图](https://via.placeholder.com/800x400/00A68D/FFFFFF?text=鱼骨图结构示意图)

### 整体架构

```
┌─────────────────────────────────────────────────────────────┐
│                         index.vue                           │
│  - 组件入口，负责整体渲染流程                                 │
│  - 处理用户交互（拖拽、缩放、编辑）                           │
│  - 管理数据状态（编辑/详情模式）                              │
└────────────────────────┬────────────────────────────────────┘
                         │
        ┌────────────────┼────────────────┐
        ▼                ▼                ▼
┌──────────────┐  ┌──────────────┐  ┌──────────────┐
│  layout.js   │  │  drawer.js   │  │    X6        │
│              │  │              │  │   图形库     │
│ 布局计算模块  │  │ 绘图辅助模块  │  │              │
│              │  │              │  │  渲染线条    │
└──────────────┘  └──────────────┘  └──────────────┘
```

---

## 数据结构

在了解函数之前，先理解鱼骨图的数据结构：

```javascript
{
  headLabel: "问题详情",           // 鱼头标题
  bigBones: [                       // 大骨数组
    {
      id: "n_1",
      label: "人员",
      position: "top",              // "top" = 上方, "bottom" = 下方
      midBones: [                   // 中骨数组
        {
          id: "n_2",
          label: "技能",
          smallBones: [              // 小骨数组
            { id: "n_3", label: "经验不足" }
          ]
        }
      ]
    }
  ]
}
```

---

## layout.js - 布局计算模块

### 导出常量

```javascript
LINE_CHARS = 10     // 每行最多显示字符数，超过则换行
BIG_GAP = 100       // 大骨之间的最小宽度
DIAG = 150          // 大骨斜线默认长度（像素）
MID_LEN = 90        // 中骨水平线默认长度
PAIR_GAP = 60       // 上下两根大骨的间距
PAD_L = 70          // 画布左侧留白
TAIL = 50           // 鱼尾到主骨线的距离
CY = 350            // 主骨线的 Y 坐标（画布垂直中心）
EMPTY_OFFSET_X = -250  // 空图时的整体偏移量
BTN_SIZE = 20       // 加号按钮的尺寸
```

### calculateLayout(fishData) - 布局入口函数

**作用**：根据鱼骨图数据计算所有元素的坐标和画布尺寸

**参数**：
- `fishData` - 鱼骨图数据对象

**返回值**：包含所有布局信息的对象，用于后续渲染

```javascript
export function calculateLayout(fishData) {
  // 1. 判断是否为空图
  const isEmpty = !fishData.bigBones || fishData.bigBones.length === 0

  // 2. 定义内部常量
  const SM_BOX_H = 24, SM_GAP_Y = 8   // 小骨方框高度、间距
  const MID_BOX_H = 24                 // 中骨方框高度
  const BIG_BOX_H = 32                 // 大骨方框高度
  const SM_LINK_LEN = 40               // 小骨连线长度
  const GROUP_GAP = 30                 // 大骨组间距
  
  // ... 计算各种尺寸和位置信息
}
```

### smBoxH(sm) - 小骨方框高度

```javascript
function smBoxH(sm) {
  // 如果文字超过10个字符，需要换行显示，高度增加
  return sm.label.length > LINE_CHARS ? SM_BOX_H * 1.8 : SM_BOX_H
}
```

**图示**：
```
文字 ≤ 10 字              文字 > 10 字
┌─────────────┐          ┌─────────────┐
│   小骨标签   │          │   小骨标签   │
│             │          │   第二行     │
└─────────────┘          └─────────────┘
    24 像素                  43 像素
```

### midBoxH(m) - 中骨方框高度

```javascript
function midBoxH(m) {
  return m.label.length > LINE_CHARS ? MID_BOX_H * 1.8 : MID_BOX_H
}
```

### bigBoxH(b) - 大骨方框高度

```javascript
function bigBoxH(b) {
  return b.label.length > LINE_CHARS ? BIG_BOX_H * 1.8 : BIG_BOX_H
}
```

### totalSmallBonesH(m) - 计算中骨下所有小骨的总高度

```javascript
function totalSmallBonesH(m) {
  if (m.smallBones.length === 0) return 0
  let h = 0
  for (let j = 0; j < m.smallBones.length; j++) {
    if (j > 0) h += SM_GAP_Y  // 累加间距
    h += smBoxH(m.smallBones[j])  // 累加每个小骨高度
  }
  return h
}
```

**图示**：
```
┌────┐
│小骨1│ 24px
└────┘
   ↓ 8px 间距
┌────┐
│小骨2│ 24px
└────┘
   ↓ 8px 间距
┌────┐
│小骨3│ 24px
└────┘

总高度 = 24 + 8 + 24 + 8 + 24 = 88px
```

### midBoneSpan(m) - 中骨沿斜线方向占用的间距

```javascript
function midBoneSpan(m) {
  const midH = midBoxH(m)      // 中骨方框高度
  const smH = totalSmallBonesH(m)  // 小骨总高度
  // 需要容纳：中骨高度+间隙，或 中骨+小骨总高度
  const needed = Math.max(midH + 20, smH + midH)
  // 乘以 √2 是因为沿斜线方向的距离是垂直距离的 √2 倍
  return Math.ceil(needed * Math.SQRT2)
}
```

**图示**：
```
斜线方向
    │
   ╱│╲  span = needed × √2
  ╱ │ ╲
 ▼  ▼  ▼
中骨 小骨
```

### calcHeadMargin(b) - 大骨斜线顶端留白

```javascript
function calcHeadMargin(b) {
  const bigH = bigBoxH(b)
  // 留白 = 大骨高度 + 40，最小80
  return Math.max(80, bigH + 40)
}
```

### calcDiag(b) - 大骨斜线总长度

```javascript
function calcDiag(b) {
  // 如果没有中骨，使用默认长度
  if (b.midBones.length === 0) return DIAG
  
  const headMargin = calcHeadMargin(b)
  const tailMargin = 50
  
  let total = headMargin
  for (const m of b.midBones) {
    total += midBoneSpan(m)  // 累加每个中骨的跨度
  }
  total += tailMargin
  
  // 至少使用默认长度
  return Math.max(DIAG, total)
}
```

### calcBoxW(text, fs) - 根据文字计算方框宽度

```javascript
function calcBoxW(text, fs = 11) {
  const len = text.length
  // 每字符约 1.0 倍字体大小，加上左右内边距 20
  const lineW = Math.min(len, LINE_CHARS) * (fs * 1.0) + 20
  // 最小宽度 80
  return Math.max(lineW, 80)
}
```

**图示**：
```
文字: "技能培训不足" (7字)
fs = 14
lineW = 7 × 14 × 1.0 + 20 = 118
宽度 = max(118, 80) = 118px
```

### smBoxW(sm) / midBoxW(m) / bigBoxW(b) - 便捷函数

```javascript
function smBoxW(sm) { return calcBoxW(sm.label, 12) }   // 小骨用12号字体
function midBoxW(m) { return calcBoxW(m.label, 14) }     // 中骨用14号字体
function bigBoxW(b) { return calcBoxW(b.label, 14) }     // 大骨用14号字体
```

### calcDynamicMidLen(m) - 动态计算中骨横向长度

```javascript
function calcDynamicMidLen(m) {
  const smH = totalSmallBonesH(m)     // 小骨总高度
  const boxW = calcBoxW(m.label, 14)   // 中骨方框宽度
  // 基础长度 = 默认长度 或 方框宽度，取较大者 + 5像素缓冲
  const baseLen = Math.max(MID_LEN, boxW) + 5
  
  if (smH === 0) return baseLen
  // 有小骨时，长度增加小骨高度的一半
  return baseLen + smH / 2
}
```

### boneLeftExtent(b) - 大骨从主骨交点向左延伸的最大距离

```javascript
function boneLeftExtent(b) {
  const dynamicDiag = calcDiag(b)
  const dd = dynamicDiag / Math.SQRT2  // 斜线投影长度
  
  let maxLeft = dd + 80  // 基础长度
  let accumOff = calcHeadMargin(b)
  
  for (const m of b.midBones) {
    const span = midBoneSpan(m)
    const centerOff = accumOff + span / 2
    accumOff += span
    
    const t = centerOff / dynamicDiag
    const axOff = dd * t  // 中骨锚点的X偏移
    
    const ml = calcDynamicMidLen(m)  // 中骨线长度
    const mw = midBoxW(m)             // 中骨方框宽度
    
    // 计算最左端：锚点 + 中骨线 + 方框 + 小骨链接 + 小骨方框
    let leftFromBx = axOff + ml + mw + 10
    if (m.smallBones.length > 0) {
      leftFromBx += SM_LINK_LEN + maxSmBoxW(m) + 10
    }
    maxLeft = Math.max(maxLeft, leftFromBx)
  }
  return maxLeft
}
```

### 大骨分组逻辑

```javascript
// 每2根大骨为一组（上下各一根）
const groups = []
for (let i = 0; i < fishData.bigBones.length; i += 2) {
  const top = fishData.bigBones[i]
  const bot = fishData.bigBones[i + 1] || null
  groups.push({ top, bot })
}
```

**图示**：
```
大骨数组: [大骨1, 大骨2, 大骨3, 大骨4, 大骨5]
           ↓ 分组
组1: { top: 大骨1, bot: 大骨2 }
组2: { top: 大骨3, bot: 大骨4 }
组3: { top: 大骨5, bot: null }
```

### 画布尺寸计算

```javascript
// 计算画布边界
let xMin = PAD_L - 20, xMax = mainEnd + 20
let yMin = CY, yMax = CY

// 遍历所有骨骼更新边界...

// 整体偏移（确保画布不小于视口）
let shiftX = xMin < tailSafeRight ? tailSafeRight - xMin : 0
const shiftY = yMin < 0 ? -yMin + 40 : 0

// 鱼头鱼尾缩放（根据中骨数量动态调整大小）
const FISH_SCALE = Math.min(FISH_SCALE_MAX, FISH_SCALE_BASE + totalMidCount * 0.12)

// 最终画布尺寸
const canvasW = Math.max(shiftedMainEnd + HEAD_SVG_W + 40, 900)
const canvasH = Math.max(yMax + shiftY + PAD, Math.max(TAIL_SVG_H, HEAD_SVG_H) + 100, 700)
```

---

## drawer.js - 绘图辅助模块

### createDrawer(options) - 创建绘图器

**作用**：返回绘图辅助函数集合

**参数**：
- `graph` - X6 图形实例
- `mode` - 模式（'edit' 或 'view'）
- `editOverlays` - 编辑覆盖层数组
- `callbackMap` - 回调函数映射
- `LINE_CHARS` - 每行字符数

### addEdge(s, t, color, w) - 添加直线边

```javascript
function addEdge(s, t, color, w) {
  graph.addEdge({
    shape: 'edge',
    source: { x: s[0], y: s[1] },  // 起点坐标
    target: { x: t[0], y: t[1] },  // 终点坐标
    attrs: {
      line: {
        stroke: color,           // 线条颜色
        strokeWidth: w,          // 线条粗细
        strokeLinecap: 'round',   // 线条端点圆角
        targetMarker: none,      // 无箭头
        sourceMarker: none,
      },
    },
  })
}
```

**图示**：
```
起点(s) ──────────────── 终点(t)
     strokeWidth: w
     stroke: color
```

### addCurvedEdge(s, t, color, w) - 添加贝塞尔弧线

```javascript
function addCurvedEdge(s, t, color, w) {
  // 计算贝塞尔曲线控制点
  const cpX = Math.abs(t[0] - s[0]) * 0.65
  const d = `M ${sx} ${sy} C ${sx - cpX} ${sy}, ${tx + cpX} ${ty}, ${tx} ${ty}`
  // ...
}
```

**图示**：
```
连接点(分叉点)                    小骨方框
      ●─────────────────────────●
       ╲                         ╲
        ╲ 贝塞尔曲线               ╲
         ╲                       ╱
          ╲                     ╱
           ●───────────────────●
```

### addLabelNode(...) - 添加标签节点

```javascript
function addLabelNode(
  id, x, y, w, h, text, bg, border, fg,
  fs = 12, fw = 500, rx = 4, boneRef = null, delInfo = null, growDir = 0,
) {
  // 处理两行文字的情况
  const needTwoLines = text.length > LINE_CHARS
  const displayH = needTwoLines ? lineH * 2 + 6 : h
  
  // 根据 growDir 调整Y坐标
  if (needTwoLines) {
    const extra = displayH - h
    if (growDir === -1) displayY = y - extra       // 向上增长
    else if (growDir === 1) displayY = y           // 向下增长
    else displayY = y - extra / 2                  // 居中
  }
  
  // 有 boneRef 时使用 HTML overlay 渲染（支持编辑）
  if (boneRef) {
    editOverlays.value.push({ id, x, y: displayY, w, h: displayH, ... })
    return
  }
  
  // 无 boneRef 时使用 X6 节点
  graph.addNode({ ... })
}
```

**growDir 参数说明**：
```
growDir = -1 (向上增长)     growDir = 0 (居中)      growDir = 1 (向下增长)
┌─────────────┐           ┌─────────────┐         ┌─────────────┐
│   标签文字   │           │             │         │             │
│   标签文字   │           │   标签文字   │         │   标签文字   │
│             │           │   标签文字   │         │   标签文字   │
└─────────────┘           └─────────────┘         └─────────────┘
```

### addBtn(id, x, y, color, tip, fn, size) - 添加加号按钮

```javascript
function addBtn(id, x, y, color, tip, fn, size) {
  if (mode.value !== 'edit') return  // 只在编辑模式显示
  
  const s = size || BTN_SIZE
  callbackMap[id] = fn  // 存储点击回调
  
  graph.addNode({
    id, shape: 'rect', x, y, width: s, height: s,
    attrs: {
      body: { fill: color, stroke: '#fff', rx: 4, ry: 4 },
      label: { text: '+', fill: '#fff', fontSize: 16 },
    },
  })
}
```

### BONE_COLORS - 大骨颜色数组

```javascript
export const BONE_COLORS = [
  '#B37DD8', '#6C9E42', '#D77D1E', '#8793B9', '#CE75B8',
  '#668FF5', '#00A0C8', '#BB8C00', '#00A68D', '#E96F56',
]
```

### getBoneColor(bigIndex) - 获取大骨颜色

```javascript
export function getBoneColor(bigIndex) {
  // 根据大骨索引循环取颜色
  return BONE_COLORS[bigIndex % BONE_COLORS.length]
}
```

---

## index.vue - 主组件

### 核心数据结构

```javascript
// 鱼骨图数据
const fishData = reactive({ bigBones: [] })

// 画布实例
let graph = null

// 视图变换
const panX = ref(0)     // X轴平移
const panY = ref(0)     // Y轴平移
const scale = ref(1)    // 缩放比例

// 模式：编辑/详情
const mode = defineModel({ default: 'edit' })

// 编辑覆盖层（HTML元素）
const editOverlays = ref([])
```

### init(dataOrPromise) - 初始化入口

```javascript
async function init(dataOrPromise) {
  needsCenter = true
  isFirstRender.value = true
  
  // 支持 Promise 或直接数据
  if (dataOrPromise && (typeof dataOrPromise === 'function' || typeof dataOrPromise.then === 'function')) {
    loading.value = true
    const result = typeof dataOrPromise === 'function' ? await dataOrPromise() : await dataOrPromise
    if (result) setData(result)
    loading.value = false
  } else if (dataOrPromise) {
    setData(dataOrPromise)
  }
  
  // 等待 DOM 准备好后渲染
  nextTick(tryRender)
}
```

### setData(data) - 填充数据

```javascript
function setData(data) {
  idSeq = 0
  fishData.bigBones = []
  
  if (data.headLabel) headLabel.value = data.headLabel
  
  // 递归处理每层骨骼，自动生成 id
  if (Array.isArray(data.bigBones)) {
    data.bigBones.forEach((bigItem, i) => {
      const big = {
        id: genId(),
        label: bigItem.label || `大骨 ${i + 1}`,
        position: i % 2 === 0 ? 'top' : 'bottom',
        midBones: [],
      }
      // 处理中骨...
        // 处理小骨...
      fishData.bigBones.push(big)
    })
  }
}
```

### renderGraph() - 核心渲染函数

这是组件最重要的函数，流程如下：

```javascript
function renderGraph() {
  // 1. 清理旧画布
  if (graph) graph.dispose()
  containerRef.value.innerHTML = ''
  editOverlays.value = []
  
  // 2. 计算布局
  const layout = calculateLayout(fishData)
  
  // 3. 创建 X6 画布
  graph = new Graph({
    container: containerRef.value,
    width: layout.canvasW,
    height: layout.canvasH,
    background: { color: '#FFFFFF' },
    grid: { visible: true, type: 'dot', size: 20 },
    panning: false,
    mousewheel: false,
    interacting: { nodeMovable: false },
  })
  
  // 4. 创建绘图器
  const { addEdge, addCurvedEdge, addLabelNode, addBtn } = createDrawer({ ... })
  
  // 5. 绘制主骨线
  addEdge([mainLeft - TAIL_SVG_W * 0.3, cy], [mainRight + HEAD_SVG_W * 0.3, cy], '#00A68D', 4)
  
  // 6. 遍历每根大骨
  for (const slot of slots) {
    // 绘制大骨斜线
    addEdge([sx, sy], [ex, ey], boneColor, 3)
    
    // 绘制大骨标签
    addLabelNode(`big_label_${b.id}`, boxX, boxY, lw, lh, b.label, ...)
    
    // 遍历中骨
    for (const m of b.midBones) {
      // 绘制中骨水平线
      addEdge([ax, ay], [mex, ay], boneColor, 2)
      
      // 绘制中骨标签
      addLabelNode(`mid_label_${m.id}`, midBoxX, midBoxY, mlw, mlh, m.label, ...)
      
      // 绘制小骨
      if (m.smallBones.length > 0) {
        // 单个小骨直线，多个小骨弧线
      }
    }
  }
  
  // 7. 首次渲染自动居中
  if (needsCenter) {
    // 计算缩放和偏移，使图形居中显示
  }
}
```

### 交互处理函数

#### 拖拽平移

```javascript
// 指针按下
function onPointerDown(e) {
  isPanning = true
  panStartX = e.clientX
  panStartY = e.clientY
  panOriginX = panX.value
  panOriginY = panY.value
}

// 指针移动
function onPointerMove(e) {
  if (!isPanning) return
  const dx = e.clientX - panStartX
  const dy = e.clientY - panStartY
  panX.value = panOriginX + dx
  panY.value = panOriginY + dy
}

// 指针抬起
function onPointerUp() {
  isPanning = false
}
```

#### 滚轮缩放

```javascript
function onWheel(e) {
  e.preventDefault()
  const oldScale = scale.value
  const delta = e.deltaY > 0 ? -0.08 : 0.08  // 向下滚缩小，向上滚放大
  const newScale = Math.min(SCALE_MAX, Math.max(SCALE_MIN, oldScale + delta))
  
  // 以鼠标位置为中心进行缩放
  panX.value = mx - (mx - panX.value) * (newScale / oldScale)
  panY.value = my - (my - panY.value) * (newScale / oldScale)
  scale.value = newScale
}
```

### 骨骼编辑

```javascript
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

// 删除骨骼
function deleteBone(delInfo) {
  const { type, bigId, midId, smId } = delInfo
  if (type === 'big') {
    // 删除大骨...
  } else if (type === 'mid') {
    // 删除中骨...
  } else if (type === 'small') {
    // 删除小骨...
  }
  renderGraph()
}
```

### 模板结构

```vue
<template>
  <div class="fishbone-page">
    <!-- 加载遮罩 -->
    <div v-if="loading" class="fishbone-loading">
      <a-spin tip="加载中..." />
    </div>
    
    <!-- 视口（可拖拽） -->
    <div class="fishbone-viewport" @pointerdown="onPointerDown" @wheel.prevent="onWheel">
      <!-- 世界容器 -->
      <div class="fishbone-world" :style="{ transform: `translate(${panX}px, ${panY}px) scale(${scale})` }">
        <!-- X6 画布 -->
        <div class="fishbone-canvas" ref="containerRef" />
        
        <!-- 鱼尾 SVG -->
        <div class="fish-part" :style="{ left: tailPos.x + 'px', top: tailPos.y + 'px' }">
          <svg>...</svg>
        </div>
        
        <!-- 鱼头 SVG -->
        <div class="fish-part" :style="{ left: headPos.x + 'px', top: headPos.y + 'px' }">
          <svg>...</svg>
          <!-- 鱼头标签 -->
          <div class="fish-head-label">...</div>
        </div>
        
        <!-- 编辑覆盖层 -->
        <div v-for="ov in editOverlays" :key="ov.id" class="inline-edit-wrap">
          <input v-if="hoveringOverlayId === ov.id && mode === 'edit'" ... />
          <div v-else class="inline-edit-label">...</div>
          <span v-if="ov.delInfo && mode === 'edit'" class="inline-edit-del">&times;</span>
        </div>
      </div>
    </div>
    
    <!-- 缩放控件 -->
    <div class="zoom-control">...</div>
    
    <!-- 底部操作栏 -->
    <footer class="fishbone-footer">
      <a-radio-group v-model="mode">...</a-radio-group>
      <div class="footer-right">
        <a-button @click="onCancel">取消</a-button>
        <a-button type="primary" @click="onConfirm">确定</a-button>
      </div>
    </footer>
  </div>
</template>
```

---

## 渲染流程图

```
用户调用 init()
       │
       ▼
setData() 处理数据
       │
       ▼
calculateLayout() 计算布局
       │
       ├── 确定画布尺寸
       ├── 计算每个骨骼的位置
       └── 返回布局信息
       │
       ▼
renderGraph() 渲染图形
       │
       ├── 清理旧画布
       ├── 创建 X6 Graph
       │
       ├── 绘制主骨线
       │    │
       │    ▼
       │  遍历大骨
       │    │
       │    ├── 绘制大骨斜线
       │    ├── 绘制大骨标签
       │    │
       │    └── 遍历中骨
       │         │
       │         ├── 绘制中骨水平线
       │         ├── 绘制中骨标签
       │         ├── 绘制小骨按钮
       │         │
       │         └── 绘制小骨
       │              │
       │              ├── 单个小骨 → 直线连接
       │              └── 多个小骨 → 弧线连接
       │
       ├── 绘制鱼头鱼尾
       ├── 生成编辑覆盖层
       │
       └── 自动居中
```

---

## 使用示例

```vue
<template>
  <MyFishboneDiagram
    ref="fishboneRef"
    v-model="mode"
    @confirm="handleConfirm"
    @cancel="handleCancel"
  />
</template>

<script setup>
import { ref } from 'vue'
import MyFishboneDiagram from './components/MyFishboneDiagram/index.vue'

const fishboneRef = ref(null)
const mode = ref('edit')

// 初始化数据
onMounted(() => {
  fishboneRef.value.init({
    headLabel: '软件发布失败',
    bigBones: [
      {
        label: '人员',
        position: 'top',
        midBones: [
          {
            label: '技能',
            smallBones: [
              { label: '经验不足' },
              { label: '培训不够' }
            ]
          }
        ]
      },
      {
        label: '流程',
        position: 'bottom',
        midBones: [
          {
            label: '测试',
            smallBones: [
              { label: '测试不充分' }
            ]
          }
        ]
      }
    ]
  })
})

function handleConfirm() {
  const data = fishboneRef.value.getData()
  console.log('保存数据:', data)
}

function handleCancel() {
  console.log('取消编辑')
}
</script>
```

---

## 总结

本鱼骨图组件通过三个模块的协作实现了完整的编辑功能：

1. **layout.js** - 纯数学计算，根据数据计算出每个元素的理想位置
2. **drawer.js** - 封装 X6 的绘图 API，提供简洁的绘图接口
3. **index.vue** - 整合业务逻辑，处理用户交互和数据流转

核心设计思想：
- 布局计算与渲染分离，便于维护和测试
- 使用 HTML overlay 实现编辑功能，体验更接近原生输入框
- 动态计算尺寸，适配不同长度的文字
- 支持拖拽和缩放，提供良好的交互体验
