<script setup lang="ts">
import { useLocalStore, useMainStore } from '@/stores/simple'
import type { Item, State } from '@/typing'
import { computed, ref } from 'vue'
const local = useLocalStore()
const main = useMainStore()

type Mode = 'main' | 'edit'
const mode = ref('main' as Mode)
function cycleMode() {
  if (mode.value === 'main') {
    mode.value = 'edit'
  } else {
    mode.value = 'main'
  }
}

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

function promptDescription(ind: number) {
    const l = main.data?.lists?.[local.currentList]
    if (l !== undefined) {
      const description = prompt("New description", l[ind].description)
      if (description !== null) {
        l[ind].description = description
      }
    }

}

function setState(ind: number, state: State) {
    const l = main.data?.lists?.[local.currentList]
    if (l !== undefined) {
      l[ind].state = state
    }
}

function deleteItem(ind: number) {
    const l = main.data?.lists?.[local.currentList]
    if (l !== undefined) {
      l.splice(ind, 1)
    }
}
</script>

<template>
  <div class="menu-bar">
    <button @click="promptSwitchList()">
      list is <code>{{ local.currentList }}</code>
      <span title="Add List" @click.stop="promptAddList()">(+) </span>
      <details style="display: inline-block;" @click.stop><summary></summary>
        <select v-if="mode === 'edit'" type="select" @click.stop v-model="local.currentList">
          <option v-for="l in Object.keys(main.data.lists)" :key="l" :value="l">{{ l }}</option>
        </select>
      </details>
    </button>
    <button @click="promptAddItem()">(+) new item</button>
    <button @click="cycleMode()">mode is <code>{{ mode }}</code></button>
  </div>
  <ul v-if="mode === 'edit'" class="mode-edit">
    <li @click="promptAddItem()">(+)</li>
    <li v-for="it in [...currentUnchecked, ...currentChecked, ...currentArchived]" :key="it.ind">
      <span
        v-for="k in (['unchecked', 'checked', 'archived'] as State[])" :key="k"
        :class="{ [k]: true, currentState: it.state === k }"
        @click="setState(it.ind, k)"
      ></span>
      <strong @click="promptDescription(it.ind)">{{ it.description }}</strong>
        
      <button @click="deleteItem(it.ind)">del.</button>
    </li>
  </ul>
  <ul v-else class="mode-main">
    <li @click="promptAddItem()">(+) new item</li>
    <li class="unchecked" v-for="it in currentUnchecked" :key="it.ind" @click="setState(it.ind, 'checked')">{{ it.description }}</li>
    <li class="sep"><hr/></li>
    <li class="checked" v-for="it in currentChecked" :key="it.ind" @click="setState(it.ind, 'unchecked')">{{ it.description }}</li>
    <li class="sep"><hr/></li>
    <li class="archived" v-for="it in currentArchived" :key="it.ind">{{ it.description }}</li>
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

.mode-edit {
  span.unchecked::before {
    content: " [_] "
  }
  span.checked::before {
    content: " [x] "
  }
  span.archived::before {
    content: " (A) "
  }
  li>span:not(.currentState) {
    opacity: 0.25;
  }
}


.menu-bar {
  display: flex;
  width: 100%;
  background-color: #333;
  padding: 10px;
  align-items: center;
  box-shadow: 0px 2px 4px rgba(0,0,0,0.1);
}

.menu-bar button {
  flex: 1;
  background-color: #333;
  color: #fff;
  border: none;
  padding: 10px;
  font-size: 16px;
  cursor: pointer;

  code {
    padding: 0 1em;
  }
}

.menu-bar button:hover {
  background-color: #444;
}
</style>