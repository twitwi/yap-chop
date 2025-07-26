<script lang="ts" setup>
defineProps({
  mode: {
    type: String,
    default: 'raw',
  },
  summary: {
    type: String,
    default: 'Local storage (unfold to view/edit)',
  },
})

import { APP_LOCAL_STORAGE_KEY, EG_CONFIG } from '@/main-yjs'
import { computed } from 'vue'

const lsvalue = computed({
  get: () => localStorage.getItem(APP_LOCAL_STORAGE_KEY) ?? '',
  set: (value) => {
    localStorage.setItem(APP_LOCAL_STORAGE_KEY, value);
  },
})
</script>
<template>
  <input v-if="mode === 'raw'" type="text" v-model="lsvalue" :placeholder="EG_CONFIG" />
  <details v-else-if="mode === 'details'">
    <summary>{{ summary }}</summary>
    <EditLocalStorageConfig style="width: 100%" />
  </details>
  <div v-else>Unknown mode {{ mode }}</div>

</template>
