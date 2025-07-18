import { ref } from 'vue'
import { defineStore } from 'pinia'
import type { Data } from '@/typing'

export const useLocalStore = defineStore(
  'local',
  () => {
    // like setup() in a component
    const currentList = ref('shop')
    return { currentList }
  },
  {
    persist: true, // persisted in localStorage
  },
)

export const useMainStore = defineStore(
  'main',
  () => {
    // like setup() in a component
    const data = ref({} as Data)
    return { data }
  },
  {
    sharing: true, // shared through yjs (+ local IDB)
  },
)
