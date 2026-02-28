<script setup>
import { ref, nextTick } from 'vue'
import FishboneDiagram from './components/MyFishboneDiagram/index.vue'

const showFishbone = ref(false)
const fishboneRef = ref(null)

/** 模拟后端 API 返回的鱼骨图数据 */
function mockFetchFishboneData() {
  return new Promise((resolve) => {
    setTimeout(() => {
      resolve({
        headLabel: '系统响应慢',
        bigBones: [
          {
            label: '人员',
            midBones: [
              { label: '培训不足11111sssssssss', smallBones: [{ label: '新员工多' }, { label: '文档缺失' }] },
              { label: '人手不够', smallBones: [{ label: '预算限制' }] },
            ],
          },
          {
            label: '流程',
            midBones: [
              { label: '审批环节多', smallBones: [{ label: '跨部门协作' }] },
              { label: '缺少自动化', smallBones: [] },
            ],
          },
          {
            label: '技术',
            midBones: [
              { label: '数据库慢查询', smallBones: [{ label: '缺少索引' }, { label: '表设计不合理' }] },
              { label: '服务器配置低', smallBones: [{ label: '内存不足' }] },
              { label: '缓存未命中', smallBones: [] },
            ],
          },
          {
            label: '环境',
            midBones: [
              { label: '网络延迟高', smallBones: [{ label: '跨区域部署' }] },
              { label: '机房温度高', smallBones: [] },
            ],
          },
        ],
      })
    }, 1000)
  })
}

/** 打开鱼骨图并异步加载数据 —— 先开弹窗，组件内部显示 loading */
function openFishbone() {
  showFishbone.value = true
  nextTick(() => fishboneRef.value?.init(mockFetchFishboneData()))
}

/** 打开空白鱼骨图（不传数据） */
function openEmptyFishbone() {
  showFishbone.value = true
  nextTick(() => fishboneRef.value?.init())
}

function onConfirm() {
  const data = fishboneRef.value?.getData()
  console.log('鱼骨图数据：', JSON.stringify(data, null, 2))
  showFishbone.value = false
}
function onCancel() { showFishbone.value = false }
</script>

<template>
  <div style="padding: 40px; display: flex; gap: 16px">
    <a-button type="primary" @click="openFishbone">
      异步加载鱼骨图
    </a-button>
    <a-button @click="openEmptyFishbone">
      打开空白鱼骨图
    </a-button>
    <a-modal
      v-model:visible="showFishbone"
      :footer="false"
      :width="'90vw'"
      :modal-style="{ maxWidth: '1600px' }"
      :body-style="{ padding: 0, height: '80vh', overflow: 'hidden' }"
    >
      <FishboneDiagram
        ref="fishboneRef"
        @confirm="onConfirm"
        @cancel="onCancel"
      />
    </a-modal>
  </div>
</template>
