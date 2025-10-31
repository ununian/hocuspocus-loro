<template>
  <div class="editor-container">
    <div ref="editorRef"></div>
  </div>
</template>
<script setup lang="ts">
import { EditorState } from "prosemirror-state";
import { EditorView } from "prosemirror-view";
import { Schema, DOMParser } from "prosemirror-model";
import { schema } from "prosemirror-schema-basic";
import { addListNodes } from "prosemirror-schema-list";
import { exampleSetup } from "prosemirror-example-setup";
import { onMounted, ref } from "vue";
import { LoroDoc, type ContainerID } from "loro-crdt";
import { LoroSyncPlugin, LoroUndoPlugin, redo, undo, type LoroDocType } from "loro-prosemirror";
import { keymap } from "prosemirror-keymap";
import type { CursorEphemeralStore } from "../ephemeralStore";
import { LoroCursorPlugin } from "../cursor-plugin";

// Mix the nodes from prosemirror-schema-list into the basic schema to
// create a schema with list support.
const mySchema = new Schema({
  nodes: addListNodes(schema.spec.nodes, "paragraph block*", "block"),
  marks: schema.spec.marks,
});
const plugins = [...exampleSetup({ schema: mySchema, history: false })];

const editorRef = ref<HTMLElement | null>();

const props = defineProps<{
  loro: LoroDocType;
  store?: CursorEphemeralStore;
  containerId?: ContainerID;
}>();

onMounted(() => {
  if (editorRef.value) {
    const all = [
      ...plugins,
      LoroSyncPlugin({ doc: props.loro, containerId: props.containerId }),
      LoroUndoPlugin({ doc: props.loro }),
      keymap({
        "Mod-z": (state) => undo(state, () => {}),
        "Mod-y": (state) => redo(state, () => {}),
        "Mod-Shift-z": (state) => redo(state, () => {}),
      }),
    ];
    if (props.store) {
      all.push(LoroCursorPlugin(props.store, {}));
    }

    new EditorView(editorRef.value, {
      state: EditorState.create({
        doc: DOMParser.fromSchema(mySchema).parse(document.createElement("div")),
        plugins: all,
      }),
    });
  }
});
</script>
<style>
.editor-container {
  height: 300px;
  border: 1px solid #ccc;
}
</style>
