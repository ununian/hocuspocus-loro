<script setup lang="ts">
import { LoroDoc } from "loro-crdt";
import Editor from "./components/Editor.vue";
import { type LoroDocType } from "loro-prosemirror";
import { createLoroProvider } from "./provider";
import { CursorEphemeralStore } from "./ephemeralStore";

const loroDocA: LoroDocType = new LoroDoc();
const idA = loroDocA.peerIdStr;
const storeA = new CursorEphemeralStore(idA);
const containerIdA = loroDocA.getMap("doc").id;

const loroDocB: LoroDocType = new LoroDoc();
const idB = loroDocB.peerIdStr;
const storeB = new CursorEphemeralStore(idB);

const {} = createLoroProvider("a", loroDocA, "my-access-token", storeA);
const {} = createLoroProvider("a", loroDocB, "my-access-token", storeB);
</script>

<template>
  <div>
    <Editor :loro="loroDocA" :store="storeA" :container-id="containerIdA" style="height: 300px" />
    <Editor
      :loro="loroDocB"
      :store="storeB"
      :container-id="containerIdA"
      style="height: 300px; margin-top: 16px"
    />
  </div>
</template>

<style scoped></style>
