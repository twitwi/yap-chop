<script setup lang="ts">
import { useLocalStore, useMainStore } from '@/stores/simple'
import type { Data, Item, State } from '@/typing'
import { computed } from 'vue'
const local = useLocalStore()
const main = useMainStore()

const current = computed(() => (main.data?.lists?.[local.currentList] ?? []).map((it, i) => ({...it, ind: i})))
const currentUnchecked = computed(() => sorted(current.value.filter(it => it.state == 'unchecked')))
const currentChecked = computed(() => sorted(current.value.filter(it => it.state == 'checked')))
const currentArchived = computed(() => sorted(current.value.filter(it => it.state == 'archived')))

function sorted(l: (Item&{ind: number})[]) {
  return [...l].sort((a, b) => a.description.localeCompare(b.description))
}

function promptSwitchList() {
  const name = prompt("Switch to list", Object.keys(main.data.lists).find(n => n != local.currentList))
  if (name !== null) {
    local.currentList = name
  }
}

function promptAddList() {
  const name = prompt("New list name", local.currentList)
  if (name !== null) {
    if (main.data.lists === undefined) {
      main.data.lists = {}
    }
    if (name in main.data.lists) {
      alert("Already there... aborting")
      return
    }
    main.data.lists[name] = []
  }
}

function promptAddItem() {
  const description = prompt("New item", "")
  if (description !== null && description !== "") {
    const l = main.data?.lists?.[local.currentList]
    if (l !== undefined) {
      l.push({ description, state: 'unchecked'})
    }
  }
}

function setState(ind: number, state: State) {
    const l = main.data?.lists?.[local.currentList]
    if (l !== undefined) {
      l[ind].state = state
    }
}
</script>

<template>
  <h3><button @click="promptSwitchList()">{{ local.currentList }}</button> <button title="Add List" @click="promptAddList()">(+)</button></h3>
  <ul>
    <li @click="promptAddItem()">(+)</li>
    <li class="unchecked" v-for="it in currentUnchecked" :key="it.ind" @click="setState(it.ind, 'checked')">{{  it.description }}</li>
    <li class="sep"><hr/></li>
    <li class="checked" v-for="it in currentChecked" :key="it.ind" @click="setState(it.ind, 'unchecked')">{{  it.description }}</li>
    <li class="sep"><hr/></li>
    <li class="archived" v-for="it in currentArchived" :key="it.ind">{{  it.description }}</li>
  </ul>
  <!--pre>{{ JSON.stringify(current, null, 2) }}</pre-->
</template>

<style>
body {
  font-size: 25px;
}
li.sep {
  list-style: none;
}
li.unchecked::before {
  content: "[_] ";
}
li.checked::before {
  content: "[x] ";
}
li.archived::before {
  content: "... ";
}
</style>