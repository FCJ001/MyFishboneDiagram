import { onMounted, onBeforeUnmount } from 'vue'

const RESIZE_DEBOUNCE = 200

export function useViewportResize({ viewportRef, isFirstRender, renderGraph, setNeedsCenter }) {
  let resizeObserver = null
  let resizeTimer = null

  function onViewportResize() {
    clearTimeout(resizeTimer)
    resizeTimer = setTimeout(() => {
      if (!viewportRef.value || isFirstRender.value) return
      setNeedsCenter()
      renderGraph()
    }, RESIZE_DEBOUNCE)
  }

  onMounted(() => {
    if (viewportRef.value) {
      resizeObserver = new ResizeObserver(onViewportResize)
      resizeObserver.observe(viewportRef.value)
    }
  })

  onBeforeUnmount(() => {
    clearTimeout(resizeTimer)
    if (resizeObserver) {
      resizeObserver.disconnect()
      resizeObserver = null
    }
  })
}
