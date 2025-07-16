<script setup lang="ts">
import { RouterView } from 'vue-router'
import ReloadPrompt from './components/ReloadPrompt.vue'
</script>

<template>
  <header>
    <!--
      <nav>
        <RouterLink to="/">Home</RouterLink>
        <RouterLink to="/about">About</RouterLink>
      </nav>
    -->
  </header>

  <RouterView />
  <ReloadPrompt />
</template>
