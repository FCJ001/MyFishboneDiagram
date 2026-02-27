<script setup>
import { ref, nextTick } from 'vue'
import FishboneDiagram from './components/MyFishboneDiagram/index.vue'

const showFishbone = ref(false)
const fishboneRef = ref(null)

function openFishbone() {
  showFishbone.value = true
  nextTick(() => fishboneRef.value?.init())
}
function onConfirm() { showFishbone.value = false }
function onCancel() { showFishbone.value = false }
</script>

<template>
  <div style="padding: 40px">
    <a-button type="primary" @click="openFishbone">打开鱼骨图</a-button>
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
