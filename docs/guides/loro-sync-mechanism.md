---
tableOfContents: true
---

# Loro 同步机制详解

## 概述

Loro 是一个基于 CRDT（Conflict-free Replicated Data Types，无冲突复制数据类型）的实时协作框架。它提供了强大的同步机制，允许多个客户端在没有中心化协调的情况下进行并发编辑，同时保证最终一致性。

## CRDT 同步原理

### 核心优势

- **无需中心协调**：客户端可以直接交换更新，无需等待服务器响应
- **最终一致性**：无论操作到达的顺序如何，所有参与者最终都会达到相同状态
- **离线优先**：支持离线编辑，重新连接后自动同步
- **高效同步**：只需最少的网络交换即可完成同步

### 基本同步模式

两个具有并发编辑的文档只需要两次消息交换就能同步成功：

```javascript
// 文档 A 进行一些操作
const docA = new LoroDoc();
const listA = docA.getList("list");
listA.insert(0, "A");
listA.insert(1, "B");
listA.insert(2, "C");

// 导出 A 的更新
const data = docA.export({ mode: "update" });

// 文档 B 导入 A 的更新
const docB = new LoroDoc();
docB.import(data);

console.log(docB.toJSON()); // { list: ["A", "B", "C"] }
```

## 同步策略详解

### 1. 基础同步 (Basic Sync)

用于将一个文档的完整状态同步到另一个文档：

```javascript
// 从文档 A 导出所有更新
const updates = docA.export({ mode: "update" });

// 导入到文档 B
docB.import(updates);
```

**使用场景**：
- 新用户首次获取文档内容
- 完全重新同步文档状态

### 2. 增量同步 (Incremental Sync)

通过版本向量 (Version Vector) 只同步缺失的更新：

```javascript
// 获取文档 B 的当前版本
const versionB = docB.oplogVersion();

// 从版本 B 导出缺失的更新
const missingUpdates = docA.export({
    mode: "update",
    from: versionB
});

// 导入缺失的更新到 B
docB.import(missingUpdates);
```

**使用场景**：
- 断线重连后的同步
- 定期同步检查
- 新用户加入协作时的初始同步

### 3. 实时协作同步 (Real-time Sync)

建立持续的实时更新通道：

```javascript
// 步骤 1: 交换版本信息
const peer2Version = doc2.oplogVersion();
const peer1Version = doc1.oplogVersion();

// 步骤 2: 双向同步缺失更新
const missingOpsFor2 = doc1.export({
    mode: "update",
    from: peer2Version
});
doc2.import(missingOpsFor2);

const missingOpsFor1 = doc2.export({
    mode: "update",
    from: peer1Version
});
doc1.import(missingOpsFor1);

// 步骤 3: 建立实时更新订阅
doc2.subscribeLocalUpdates((update) => {
    // 通过 WebSocket 发送更新到对端
    websocket.send(update);
});

doc1.subscribeLocalUpdates((update) => {
    // 通过 WebSocket 发送更新到对端
    websocket.send(update);
});
```

## 导入状态监控

Loro 的 `import()` 方法返回详细的状态信息，帮助了解同步情况：

```typescript
interface ImportStatusJS {
    success: PeerVersionRange;        // 成功导入的操作范围
    pending?: PeerVersionRange;       // 因依赖缺失而暂挂的操作
}

interface PeerVersionRange {
    [peerId: string]: {
        start: number;  // 起始计数器（包含）
        end: number;    // 结束计数器（不包含）
    };
}
```

### 成功状态示例

```javascript
const importResult = docB.import(updates);
console.log(importResult.success);
// 输出示例:
// {
//   "clientA_peerId": { "start": 0, "end": 50 },
//   "server_peerId": { "start": 120, "end": 150 }
// }
// 表示成功导入了 clientA 的 0-49 操作和 server 的 120-149 操作
```

### 暂挂状态示例

```javascript
const importResult = docB.import(updates);
if (importResult.pending) {
    console.log(importResult.pending);
    // 输出示例:
    // {
    //   "clientA_peerId": { "start": 50, "end": 60 },
    //   "clientB_peerId": { "start": 10, "end": 25 }
    // }
    // 表示这些操作因缺少依赖而暂挂，需要先获取依赖的操作
}
```

## 版本向量 (Version Vector)

版本向量是 CRDT 系统的核心概念，用于跟踪每个参与者的操作历史：

```javascript
// 获取当前文档的版本向量
const currentVersion = doc.oplogVersion();
console.log(currentVersion);
// 输出: { "peer_123": 45, "peer_456": 23, "peer_789": 67 }
```

**版本向量的作用**：
- 确定哪些操作需要同步
- 检测操作间的因果关系
- 避免重复导入相同的操作

## 实际应用模式

### 1. WebSocket 集成

```javascript
class LoroSyncManager {
    constructor(doc, websocket) {
        this.doc = doc;
        this.ws = websocket;
        this.setupSync();
    }

    setupSync() {
        // 订阅本地更新并发送
        this.doc.subscribeLocalUpdates((update) => {
            this.ws.send(JSON.stringify({
                type: 'update',
                data: Array.from(update)
            }));
        });

        // 处理接收到的更新
        this.ws.onmessage = (event) => {
            const message = JSON.parse(event.data);
            if (message.type === 'update') {
                const update = new Uint8Array(message.data);
                this.doc.import(update);
            }
        };
    }

    // 初始同步
    async performInitialSync() {
        // 发送当前版本
        this.ws.send(JSON.stringify({
            type: 'version',
            data: this.doc.oplogVersion()
        }));
    }
}
```

### 2. 离线支持

```javascript
class OfflineLoroSync {
    constructor(doc, storageKey) {
        this.doc = doc;
        this.storageKey = storageKey;
        this.loadFromStorage();
        this.setupPersistence();
    }

    // 从本地存储加载
    loadFromStorage() {
        const stored = localStorage.getItem(this.storageKey);
        if (stored) {
            const updates = JSON.parse(stored);
            updates.forEach(update => {
                this.doc.import(new Uint8Array(update));
            });
        }
    }

    // 持久化到本地存储
    setupPersistence() {
        this.doc.subscribeLocalUpdates((update) => {
            const stored = localStorage.getItem(this.storageKey) || '[]';
            const updates = JSON.parse(stored);
            updates.push(Array.from(update));
            localStorage.setItem(this.storageKey, JSON.stringify(updates));
        });
    }
}
```

### 3. 多客户端协调

```javascript
class MultiPeerSync {
    constructor(doc) {
        this.doc = doc;
        this.peers = new Map();
    }

    // 添加新节点
    addPeer(peerId, transport) {
        this.peers.set(peerId, transport);
        this.syncWithPeer(peerId);
    }

    // 与特定节点同步
    syncWithPeer(peerId) {
        const transport = this.peers.get(peerId);
        const myVersion = this.doc.oplogVersion();

        // 请求对方缺失的更新
        transport.requestUpdates(myVersion, (updates) => {
            updates.forEach(update => {
                this.doc.import(update);
            });

            // 发送我方更新
            const myUpdates = this.doc.export({
                mode: 'update',
                from: transport.getVersion()
            });
            transport.sendUpdates(myUpdates);
        });
    }
}
```

## 性能优化策略

### 1. 批量更新

```javascript
// 收集一段时间内的所有更新
class BatchSyncManager {
    constructor(doc, websocket, batchTime = 100) {
        this.doc = doc;
        this.ws = websocket;
        this.batchTime = batchTime;
        this.pendingUpdates = [];
        this.setupBatching();
    }

    setupBatching() {
        this.doc.subscribeLocalUpdates((update) => {
            this.pendingUpdates.push(update);
            this.scheduleBatch();
        });
    }

    scheduleBatch() {
        if (this.batchTimeout) return;

        this.batchTimeout = setTimeout(() => {
            this.flushBatch();
            this.batchTimeout = null;
        }, this.batchTime);
    }

    flushBatch() {
        if (this.pendingUpdates.length === 0) return;

        // 合并所有更新
        const combinedUpdate = this.mergeUpdates(this.pendingUpdates);
        this.ws.send(combinedUpdate);
        this.pendingUpdates = [];
    }

    mergeUpdates(updates) {
        // 实现更新合并逻辑
        // 这里可以优化减少传输数据量
    }
}
```

### 2. 压缩传输

```javascript
// 使用压缩算法减少传输数据
import { compress, decompress } from 'lz4js';

class CompressedSync {
    async sendCompressedUpdates(doc, transport) {
        const updates = doc.export({ mode: 'update' });
        const compressed = await compress(updates);
        transport.send(compressed);
    }

    async receiveCompressedUpdates(compressedData, doc) {
        const decompressed = await decompress(compressedData);
        doc.import(decompressed);
    }
}
```

## 错误处理和恢复

### 1. 同步失败处理

```javascript
class RobustSync {
    constructor(doc, maxRetries = 3) {
        this.doc = doc;
        this.maxRetries = maxRetries;
    }

    async syncWithRetry(peerEndpoint, updates) {
        let retryCount = 0;

        while (retryCount < this.maxRetries) {
            try {
                const result = await this.sendUpdates(peerEndpoint, updates);

                // 检查是否有暂挂操作
                if (result.pending) {
                    // 处理暂挂操作
                    await this.resolvePendingOperations(result.pending);
                }

                return result;
            } catch (error) {
                retryCount++;
                console.warn(`同步失败，重试 ${retryCount}/${this.maxRetries}:`, error);

                if (retryCount >= this.maxRetries) {
                    throw new Error(`同步失败，已达到最大重试次数: ${error.message}`);
                }

                // 指数退避
                await this.delay(Math.pow(2, retryCount) * 1000);
            }
        }
    }

    async resolvePendingOperations(pending) {
        // 获取暂挂操作的依赖
        for (const [peerId, range] of Object.entries(pending)) {
            const dependencyUpdates = await this.fetchDependencies(peerId, range);
            dependencyUpdates.forEach(update => {
                this.doc.import(update);
            });
        }
    }

    delay(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }
}
```

### 2. 数据完整性验证

```javascript
class IntegrityCheckedSync {
    async syncWithVerification(peerEndpoint) {
        // 获取本地文档的校验和
        const localChecksum = this.calculateChecksum(this.doc);

        // 发送同步请求
        const response = await peerEndpoint.sync({
            version: this.doc.oplogVersion(),
            checksum: localChecksum
        });

        // 接收更新
        await this.importUpdatesWithVerification(response.updates);

        // 验证最终状态
        const finalChecksum = this.calculateChecksum(this.doc);
        if (finalChecksum !== response.expectedChecksum) {
            throw new Error('同步后数据校验失败');
        }
    }

    calculateChecksum(doc) {
        // 实现文档内容的校验和计算
        const content = JSON.stringify(doc.toJSON());
        return this.hash(content);
    }

    hash(content) {
        // 简单的哈希函数实现
        let hash = 0;
        for (let i = 0; i < content.length; i++) {
            const char = content.charCodeAt(i);
            hash = ((hash << 5) - hash) + char;
            hash = hash & hash;
        }
        return hash.toString(16);
    }
}
```

## 最佳实践总结

### 1. 架构设计
- **分层同步**：将同步逻辑分为传输层、协议层和应用层
- **状态管理**：清晰管理连接状态、同步状态和错误状态
- **事件驱动**：基于事件的异步处理模式

### 2. 性能优化
- **批量处理**：合并短时间内的多个更新
- **压缩传输**：使用压缩算法减少网络传输
- **智能同步**：基于版本向量的增量同步

### 3. 可靠性保障
- **重试机制**：网络失败时的自动重试
- **数据验证**：同步前后的数据完整性检查
- **降级策略**：网络不可用时的离线模式

### 4. 监控和调试
- **同步指标**：监控同步延迟、成功率等关键指标
- **日志记录**：详细的同步过程日志
- **调试工具**：版本向量可视化、冲突检测等

通过以上机制和最佳实践，Loro 提供了一个强大而灵活的实时协作同步解决方案，能够在各种网络环境下保证数据的一致性和可靠性。