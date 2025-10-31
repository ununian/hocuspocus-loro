---
tableOfContents: true
---

# 使用 Hocuspocus 作为 Loro 协作中心

本文档演示如何在不破坏现有 Yjs 工作流的前提下，为 Loro 文档提供协作“中枢服务器”能力。该实现是增量式扩展，添加了 Loro 专用消息类型与 Provider，默认对现有 Yjs 客户端零影响。本文采用“服务端持有 LoroDoc”的模型：服务器端维护每个文档的 LoroDoc，并基于版本向量仅下发缺失增量。

## 同步策略

本节给出与 Yjs 同步理念一致、但面向 Loro 的精简同步策略，覆盖首次同步与持续实时同步。

- 首次同步（节点初次连线）
  - 新节点与已有节点交换版本向量（Version Vector），判断缺失的更新。
  - 使用 `doc.export({ mode: "update", from: versionVector })` 获取“对方已知版本之后的增量”；若客户端未提供版本向量，可回退为直接发送整个历史 `doc.export({ mode: "update" })`。
  - 服务端基于版本向量仅下发缺失更新；无版本向量时下发全量。
- 实时同步（持续更新）
  - 订阅本地更新（`subscribeLocalUpdates`），将二进制更新直接广播给其他节点。
  - 首次同步完成后无需再次比较版本；只要所有更新都能送达，最终将保持一致。

示例：一名带有离线修改的用户重新上线后，两节点如何补齐并进入实时同步。

```ts
const doc1 = new LoroDoc();
doc1.getText("text").insert(0, "Hello");

// Peer2 加入网络
const doc2 = new LoroDoc();
// ... doc2 可能先导入本地快照

// 1) 交换版本信息
const peer2Version = doc2.oplogVersion();
const peer1Version = doc1.oplogVersion();

// 2) 互相补齐缺失更新
const missingOpsForPeer2 = doc1.export({ mode: "update", from: peer2Version });
doc2.import(missingOpsForPeer2);

const missingOpsForPeer1 = doc2.export({ mode: "update", from: peer1Version });
doc1.import(missingOpsForPeer1);

// 3) 建立实时同步（只需转发后续本地增量）
doc2.subscribeLocalUpdates((update) => {
  // websocket.send(update)
});
doc1.subscribeLocalUpdates((update) => {
  // websocket.send(update)
});
// 现在两个节点已同步，可继续协作
```

## 能力概览

- Loro 文档二进制增量更新转发（`LoroUpdate`）
- 初始与保活同步批量下发（`LoroSyncRequest`/`LoroSyncBatch`）
- 临时状态（Ephemeral Store）广播（`LoroEphemeral`）
- 与现有认证流程复用（`Auth`）

注意：服务器端维护 `documentName → LoroDoc`，并按需持久化；首次同步根据版本向量仅下发缺失增量。

## 客户端使用（LoroProvider）

```ts
import { LoroProvider, HocuspocusProviderWebsocket } from '@hocuspocus/provider'
// 假设从 loro-crdt 引入 LoroDoc/EphemeralStore
// import { LoroDoc, EphemeralStore } from 'loro-crdt'

const doc = new (global as any).LoroDoc() // 这里仅示例，实际请使用 loro-crdt 提供的构造
const ephemeral = new (global as any).EphemeralStore?.() // 可选

const websocketProvider = new HocuspocusProviderWebsocket({ url: 'wss://your-hocuspocus.example/ws' })

const provider = new LoroProvider({
  name: 'example-doc',
  doc,
  websocketProvider,
  ephemeralStore: ephemeral, // 可选；用于光标/选中等临时状态
  token: async () => 'your-jwt-or-token', // 可选
  // 避免长时间无消息导致断线，定期请求一次批量同步（默认 15s，可关闭或调整）
  forceSyncInterval: 15000,
})

provider.attach() // 若未传 url，可由 Provider 管理 websocket 并自动连接
```

当本地文档产生更新时，`LoroProvider` 会通过 `subscribeLocalUpdates` 获取 `Uint8Array` 并发送到服务器；服务器将该增量 `import` 到服务端 LoroDoc，并广播给其他连接。初始连入时，客户端发送 `LoroSyncRequest`（可携带版本向量），服务器根据版本向量仅下发缺失的 `LoroSyncBatch`，客户端收到后逐条 `doc.import(update)` 即可。

若配置了 `ephemeralStore`，本地 `subscribeLocalUpdates` 的临时更新将通过 `LoroEphemeral` 广播给其他客户端，远端通过 `.apply()` 应用，适合游标/在线状态/选区等不入主文档的实时信息。

## 首次同步与版本向量（强烈建议）

首次同步（节点初次连线）建议携带版本向量（Version Vector），让服务器仅返回缺失的更新，减少带宽与延迟。

- 交换版本向量：客户端可通过 `doc.oplogVersion()` 获取本地版本向量；`LoroProvider` 会在 `LoroSyncRequest` 中附带该信息。
- 增量导出：服务器根据版本向量下发“对方已知版本之后的增量”，等价于客户端侧的 `doc.export({ mode: 'update', from: versionVector })`。
- 回退：若客户端未提供版本向量，服务器可下发全量更新 `doc.export({ mode: 'update' })`。

示例（客户端发起带版本向量的请求）：

```ts
// 在 LoroProvider 内部已默认尝试：
const versionJSON = JSON.stringify(doc.oplogVersion())
send(LoroSyncRequestMessage, { documentName: name, versionJSON })
```

实现要点（服务端持有 LoroDoc）：

- 服务器为每个文档维护一个 LoroDoc 实例；
- 收到 `LoroSyncRequest(versionVector?)` 时，若存在 `versionVector`，执行 `doc.export({ mode: 'update', from: versionVector })`；否则执行 `doc.export({ mode: 'update' })`；
- 将导出的增量封装为 `LoroSyncBatch` 返回；
- 收到 `LoroUpdate` 时执行 `doc.import(update)` 并广播给其他连接。

### 与 Yjs/y-protocols 的对应关系

Yjs 与 Loro 在“思想”上是一致的：先对齐已知状态（基于状态/版本向量），之后只推送增量；但在线协议帧不同、不可互通。对照关系如下：

- Yjs 同步握手：`Sync`/`SyncReply`（`y-protocols/sync` 的 Step1/Step2），基于状态向量/更新进行首次对齐。
- Loro 首次同步：`LoroSyncRequest`（可携带版本向量 JSON）→ 服务器 `LoroSyncBatch` 下发若干二进制更新。
- 实时增量：Yjs 使用 `Update` 帧；Loro 使用 `LoroUpdate` 帧。
- 临时状态：Yjs `Awareness`；Loro `LoroEphemeral`（不入主文档，仅广播）。

注意：服务器将解析 `LoroSyncRequest` 携带的版本向量并仅下发缺失增量；若未携带版本向量，则下发全量。

## 服务器端（持有 LoroDoc）

在 `@packages/server` 中增加/使用以下 Loro 消息处理：

- `MessageType.LoroUpdate`：接收增量，`doc.import(update)`，并广播给其他连接；
- `MessageType.LoroSyncRequest`：解析可选 `versionJSON`，若提供则按版本向量导出缺失增量，否则导出全量；将结果打包为 `LoroSyncBatch` 返回；
- `MessageType.LoroEphemeral`：仅广播，不持久化。

上述扩展对现有 Yjs 协议完全透明；Yjs 客户端无感知。

## 服务器端文档生命周期与持久化（与 Yjs 一致的模型）

如果你需要与 Yjs 一样的“服务端持有文档状态”的模式，建议在服务器中维护 `documentName → LoroDoc` 的映射，并通过 `onLoadDocument`/`onStoreDocument` 钩子完成持久化与重建。

- 文档注册表
  - 维护：`const loroDocs = new Map<string, LoroDoc>()`
  - 目标：首次访问时从持久化层重建 `LoroDoc`，后续复用内存实例，最后在无人连接时按策略卸载并持久化。

- 首次加载（onLoadDocument）
  - 若 `loroDocs` 中无 `documentName`：
    1) 新建 `const doc = new LoroDoc()`
    2) 通过 `onLoadDocument` 从数据库取回存量数据：
       - 若保存的是“更新流”：`updates.forEach(u => doc.import(u))`
       - 若保存的是“快照/完整更新块”：`doc.import(fullUpdate)`
    3) 放入 `loroDocs.set(documentName, doc)`

- 在线增量（onChange/onStoreDocument）
  - 收到 `LoroUpdate` 时：`doc.import(update)` 并广播给其他连接。
  - 根据现有 `debounce / maxDebounce / unloadImmediately` 策略，触发 `onStoreDocument`：
    - 仅存储“新增”的部分：可维护一个“已持久版本向量 lastVV”，在持久化前导出 `doc.export({ mode: 'update', from: lastVV })`。
    - 或简单回退为“全量”存储：`doc.export({ mode: 'update' })`。

- 卸载（beforeUnloadDocument/afterUnloadDocument）
  - 当该文档连接数为 0 且无待持久化任务：
    - 调用 `beforeUnloadDocument`；
    - 按需更新持久化；
    - 从 `loroDocs` 删除并释放内存；
    - 调用 `afterUnloadDocument`。

- Ephemeral（临时态）
  - 与 Yjs Awareness 类似，但不持久化；仅在内存中转广播，随连接/卸载自然消散（可选 TTL）。

### 首次同步：基于版本向量仅下发缺失

在“服务端持有 LoroDoc”的模型下，服务器可以根据客户端上报的版本向量只下发缺失的增量：

```ts
// 伪代码：处理 LoroSyncRequest(documentName, versionVector?)
const doc = loroDocs.get(documentName) || await loadViaHook(documentName)

let payload: Uint8Array | Uint8Array[]
if (versionVector) {
  // 推荐：严格按版本向量导出缺失增量
  payload = doc.export({ mode: 'update', from: versionVector })
} else {
  // 回退：全量导出
  payload = doc.export({ mode: 'update' })
}

sendAsLoroSyncBatch(payload)
```

服务端持有 LoroDoc 带来以下好处：

- 精确的“缺失下发”；
- 更高的初次同步效率；
- 更容易的多副本一致性与落地持久化。

## 与现有文档参考

- 同步流程详见：docs/guides/loro-sync-mechanism.md
- 临时存储详见：docs/guides/loro-ephemeral-store.md

## 后续可选增强

- 将 LoroDoc 快照/增量接入持久层（参考 `onStoreDocument`/`onLoadDocument` 钩子）；
- 支持压缩批量（如 LZ4）与限流/合并策略；
- 多副本部署下的文档实例收敛（基于存储层或跨副本总线）。

## 任务列表

- [x] 梳理并统一 Loro 同步策略，明确"服务端持有 LoroDoc"方案。
- [x] 更新客户端/服务器交互描述，使其与 Yjs/y-protocols 思想对齐。
- [x] 在 `packages/server` 中真正维护 `documentName → LoroDoc` 映射并管理生命周期。
- [x] 在 `MessageReceiver` 中解析 `LoroSyncRequest` 的 `versionJSON`，基于 LoroDoc 导出缺失增量。
- [x] 在 `LoroUpdate` 处理链路中将增量 `import` 到服务端 LoroDoc，并按需持久化。
