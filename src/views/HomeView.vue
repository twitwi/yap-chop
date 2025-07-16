<script setup lang="ts">
import { useLocalStore, useMainStore } from '@/stores/simple'
const local = useLocalStore()
const main = useMainStore()
</script>

<template>
  <h3>Hello {{ local.userName }}</h3>
  <pre>{{ JSON.stringify(main.data, null, 2) }}</pre>
  <button @click="main.data.count++">+</button>
  <button @click="main.data.count--">-</button>
</template>
