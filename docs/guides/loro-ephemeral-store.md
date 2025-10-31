---
tableOfContents: true
---

# Loro 临时存储 (Ephemeral Store) 详解

## 概述

在实时协作场景中，除了通过 CRDT 保持文档一致性外，用户状态（Presence）同样重要。例如协作者姓名、指针位置或当��选中的对象等信息需要实时共享。Loro 的 Ephemeral Store 提供了一种不会写入 CRDT 文档、但能瞬时共享的机制，让协作者彼此感知，从而协调操作、避免冲突。

## 核心设计理念

### 为什么需要临时存储？

1. **用户感知**：让协作者看到其他用户的光标位置、选中状态等
2. **避免冲突**：通过共享操作意图，减少编辑冲突
3. **实时性**：状态变化需要立即同步，不需要持久化
4. **轻量级**：避免增加主文档的负担

### 设计原则

- **瞬时性**：数据主要用于实时同步，不长期保存
- **高效性**：基于时间戳的 Last-Write-Wins（最后写入生效）策略
- **增量更新**：只发送变化的条目，无需广播整个状态
- **自动清理**：超时自动移除过期数据

## 核心机制

### Last-Write-Wins 策略

Ephemeral Store ��用基于时间戳的最终写入生效策略：

```javascript
// 每个条目都维护自己的更新时间戳
store.set("user-cursor", {
    user: "Alice",
    position: { line: 5, column: 10 },
    timestamp: Date.now() // 自动时间戳
});
```

**优势**：
- 简单高效，无需复杂的冲突解决
- 保证最终一致性
- 支持离线场景的自动冲突解决

## API 详解

### 基础操作

#### 1. 创建实例

```javascript
import { EphemeralStore } from "loro-crdt";

// 创建默认超时的临时存储（30秒）
const store = new EphemeralStore();

// 创建自定义超时的临时存储
const storeWithTimeout = new EphemeralStore(60000); // 60秒
```

#### 2. 基本读写操作

```javascript
// 写入数据
store.set("loro-prosemirror", {
    anchor: { pos: 0 },
    focus: { pos: 5 },
    user: "Alice",
});

store.set("online-users", ["Alice", "Bob"]);

// 读取数据
const cursorData = store.get("loro-prosemirror");
console.log(cursorData.user); // "Alice"

const onlineUsers = store.get("online-users");
console.log(onlineUsers); // ["Alice", "Bob"]

// 删除数据
store.delete("loro-prosemirror");

// 获取所有状态
const allStates = store.getAllStates();
console.log(allStates);
// {
//   "online-users": ["Alice", "Bob"],
//   "user-selection": { ... }
// }

// 获取所有键
const keys = store.keys();
console.log(keys); // ["online-users", "user-selection"]
```

#### 3. 数据编码与传输

```javascript
// 编码特定键的数据（用于增量传输）
const cursorData = store.encode("loro-prosemirror");
// 传输到其他节点...

// 编码所有数据（用于完整同步）
const allData = store.encodeAll();

// 应用接收到的数据
store.apply(receivedData);
```

### 事件系统

#### 1. 通用事件监听

```javascript
store.subscribe((event) => {
    console.log('事件来源:', event.by); // "local" | "import" | "timeout"
    console.log('新增键:', event.added);
    console.log('更新键:', event.updated);
    console.log('移除键:', event.removed);

    // 处理不同类型的事件
    if (event.by === "local") {
        console.log('本地更新');
    } else if (event.by === "import") {
        console.log('远程更新');
    } else if (event.by === "timeout") {
        console.log('超时移除');
    }
});
```

#### 2. 本地更新监听

```javascript
// 仅监听本地更新，便于直接转发给��他节点
const subscription = store.subscribeLocalUpdates((update) => {
    // update 是 Uint8Array，包含变更数据
    websocket.send(update);
});

// 重要：需要保留订阅引用，避免被垃圾回收
```

### 事件类型定义

```typescript
interface EphemeralStoreEvent {
    // 事件来源
    by: "local" | "import" | "timeout";

    // 新增的键
    added: string[];

    // 更新的键
    updated: string[];

    // 被移除的键
    removed: string[];
}
```

## 实际应用场景

### 1. 协作光标同步

```javascript
class CollaborativeCursors {
    constructor(doc, websocket) {
        this.store = new EphemeralStore(30000); // 30秒超时
        this.ws = websocket;
        this.userId = this.generateUserId();
        this.setupSync();
    }

    // 更新光标位置
    updateCursor(position) {
        this.store.set("cursor-" + this.userId, {
            userId: this.userId,
            position: position,
            userName: this.getUserName(),
            color: this.getUserColor(),
            timestamp: Date.now()
        });
    }

    setupSync() {
        // 监听本地更新并发送
        this.store.subscribeLocalUpdates((update) => {
            this.ws.send({
                type: 'ephemeral-update',
                data: Array.from(update)
            });
        });

        // 处理接收到的更新
        this.ws.onmessage = (event) => {
            const message = JSON.parse(event.data);
            if (message.type === 'ephemeral-update') {
                const update = new Uint8Array(message.data);
                this.store.apply(update);
            }
        };

        // 监听远程更新，更新UI
        this.store.subscribe((event) => {
            if (event.by === "import") {
                event.updated.forEach(key => {
                    if (key.startsWith('cursor-')) {
                        const cursorData = this.store.get(key);
                        this.updateCursorUI(cursorData);
                    }
                });

                event.removed.forEach(key => {
                    if (key.startsWith('cursor-')) {
                        this.removeCursorUI(key);
                    }
                });
            }
        });
    }

    // 获取所有活跃光标
    getActiveCursors() {
        const cursors = {};
        for (const key of this.store.keys()) {
            if (key.startsWith('cursor-')) {
                cursors[key] = this.store.get(key);
            }
        }
        return cursors;
    }
}
```

### 2. 在线用户管理

```javascript
class OnlineUserManager {
    constructor(websocket) {
        this.store = new EphemeralStore(60000); // 1分钟超时
        this.ws = websocket;
        this.userId = this.getUserId();
        this.setupPresence();
    }

    setupPresence() {
        // 设置用户在线状态
        this.updateUserPresence();

        // 定期更新心跳
        setInterval(() => {
            this.updateUserPresence();
        }, 30000);

        // 监听本地更新
        this.store.subscribeLocalUpdates((update) => {
            this.ws.send({
                type: 'presence-update',
                data: Array.from(update)
            });
        });

        // 处理远程更新
        this.ws.onmessage = (event) => {
            const message = JSON.parse(event.message);
            if (message.type === 'presence-update') {
                const update = new Uint8Array(message.data);
                this.store.apply(update);
            }
        };

        // 监听用户状态变化
        this.store.subscribe((event) => {
            this.updateOnlineUserList();
        });
    }

    updateUserPresence() {
        this.store.set("user-" + this.userId, {
            userId: this.userId,
            userName: this.getUserName(),
            status: 'online',
            lastSeen: Date.now()
        });
    }

    getOnlineUsers() {
        const users = [];
        for (const key of this.store.keys()) {
            if (key.startsWith('user-')) {
                const userData = this.store.get(key);
                if (userData.status === 'online') {
                    users.push(userData);
                }
            }
        }
        return users;
    }

    updateOnlineUserList() {
        const onlineUsers = this.getOnlineUsers();
        this.renderUserList(onlineUsers);
    }
}
```

### 3. 选中状态同步

```javascript
class SelectionSync {
    constructor(editor, websocket) {
        this.store = new EphemeralStore(15000); // 15秒超时
        this.editor = editor;
        this.ws = websocket;
        this.userId = this.getUserId();
        this.setupSelectionSync();
    }

    setupSelectionSync() {
        // 监编辑器的选中变化
        this.editor.on('selectionChange', (selection) => {
            if (!selection.empty) {
                this.store.set("selection-" + this.userId, {
                    userId: this.userId,
                    userName: this.getUserName(),
                    range: selection.toRange(),
                    color: this.getUserColor(),
                    timestamp: Date.now()
                });
            } else {
                // 清空选中时��除
                this.store.delete("selection-" + this.userId);
            }
        });

        // 同步机制
        this.setupRealtimeSync();

        // 渲染选中区域
        this.store.subscribe((event) => {
            this.renderSelections();
        });
    }

    setupRealtimeSync() {
        // 发送本地更新
        this.store.subscribeLocalUpdates((update) => {
            this.ws.send({
                type: 'selection-update',
                data: Array.from(update)
            });
        });

        // 接收远程更新
        this.ws.onmessage = (event) => {
            const message = JSON.parse(event.data);
            if (message.type === 'selection-update') {
                const update = new Uint8Array(message.data);
                this.store.apply(update);
            }
        };
    }

    renderSelections() {
        // 清除所有选中渲染
        this.clearSelectionHighlights();

        // 渲染所有用户的选中区域
        for (const key of this.store.keys()) {
            if (key.startsWith('selection-') && key !== "selection-" + this.userId) {
                const selection = this.store.get(key);
                this.highlightSelection(selection);
            }
        }
    }

    highlightSelection(selection) {
        this.editor.highlightRange(selection.range, {
            color: selection.color,
            label: selection.userName,
            opacity: 0.3
        });
    }
}
```

## 高级应用模式

### 1. 多类型数据管理

```javascript
class MultiTypeEphemeralManager {
    constructor(websocket) {
        this.store = new EphemeralStore();
        this.ws = websocket;
        this.namespaces = new Map();
        this.setupNamespaces();
    }

    setupNamespaces() {
        // 为不同类型的数据设置命名空间
        this.namespaces.set('cursor', (data) => this.handleCursorUpdate(data));
        this.namespaces.set('selection', (data) => this.handleSelectionUpdate(data));
        this.namespaces.set('presence', (data) => this.handlePresenceUpdate(data));

        // 监听所有更新
        this.store.subscribe((event) => {
            this.processEvent(event);
        });
    }

    processEvent(event) {
        // 处理新增
        event.added.forEach(key => {
            this.processKeyUpdate(key);
        });

        // 处理更新
        event.updated.forEach(key => {
            this.processKeyUpdate(key);
        });

        // 处理移除
        event.removed.forEach(key => {
            this.processKeyRemoval(key);
        });
    }

    processKeyUpdate(key) {
        const [namespace] = key.split('-');
        const handler = this.namespaces.get(namespace);
        if (handler) {
            const data = this.store.get(key);
            handler(data);
        }
    }

    // 设置光标数据
    setCursor(userId, cursorData) {
        this.store.set(`cursor-${userId}`, cursorData);
    }

    // 设置选中数据
    setSelection(userId, selectionData) {
        this.store.set(`selection-${userId}`, selectionData);
    }

    // 设置在线状态
    setPresence(userId, presenceData) {
        this.store.set(`presence-${userId}`, presenceData);
    }
}
```

### 2. 智能超时管理

```javascript
class SmartTimeoutManager {
    constructor() {
        this.store = new EphemeralStore(30000);
        this.customTimeouts = new Map();
        this.setupSmartTimeouts();
    }

    // 为不同类型的数据设置不同超时
    setupSmartTimeouts() {
        this.store.subscribe((event) => {
            // 为光标设置较短超时
            event.added.forEach(key => {
                if (key.startsWith('cursor-')) {
                    this.setCustomTimeout(key, 10000); // 10秒
                } else if (key.startsWith('presence-')) {
                    this.setCustomTimeout(key, 60000); // 1分钟
                } else if (key.startsWith('selection-')) {
                    this.setCustomTimeout(key, 15000); // 15秒
                }
            });

            // 更新时重置超时
            event.updated.forEach(key => {
                this.resetCustomTimeout(key);
            });

            // 清理移除项目的超时
            event.removed.forEach(key => {
                this.clearCustomTimeout(key);
            });
        });
    }

    setCustomTimeout(key, timeout) {
        this.clearCustomTimeout(key); // 清除现有超时

        const timeoutId = setTimeout(() => {
            this.store.delete(key);
            this.customTimeouts.delete(key);
        }, timeout);

        this.customTimeouts.set(key, timeoutId);
    }

    resetCustomTimeout(key) {
        const timeout = this.getTimeoutForType(key);
        if (timeout) {
            this.setCustomTimeout(key, timeout);
        }
    }

    getTimeoutForType(key) {
        if (key.startsWith('cursor-')) return 10000;
        if (key.startsWith('presence-')) return 60000;
        if (key.startsWith('selection-')) return 15000;
        return 30000; // 默认超时
    }

    clearCustomTimeout(key) {
        const timeoutId = this.customTimeouts.get(key);
        if (timeoutId) {
            clearTimeout(timeoutId);
            this.customTimeouts.delete(key);
        }
    }
}
```

### 3. 数据压缩和优化

```javascript
class OptimizedEphemeralSync {
    constructor(websocket) {
        this.store = new EphemeralStore();
        this.ws = websocket;
        this.compressionEnabled = true;
        this.batchBuffer = [];
        this.setupOptimizedSync();
    }

    setupOptimizedSync() {
        this.store.subscribeLocalUpdates((update) => {
            if (this.compressionEnabled) {
                this.batchUpdate(update);
            } else {
                this.sendUpdate(update);
            }
        });

        // 定期发送批量更新
        setInterval(() => {
            this.flushBatch();
        }, 100);
    }

    batchUpdate(update) {
        this.batchBuffer.push(update);

        // 如果缓冲区过大，立即发送
        if (this.batchBuffer.length >= 10) {
            this.flushBatch();
        }
    }

    flushBatch() {
        if (this.batchBuffer.length === 0) return;

        // 合并所有更新
        const combinedUpdate = this.combineUpdates(this.batchBuffer);
        this.sendUpdate(combinedUpdate);
        this.batchBuffer = [];
    }

    combineUpdates(updates) {
        // 合并多个更新为单个更新
        // 这里可以实现更智能的合并策略
        const combined = new Uint8Array(
            updates.reduce((total, update) => total + update.length, 0)
        );

        let offset = 0;
        updates.forEach(update => {
            combined.set(update, offset);
            offset += update.length;
        });

        return combined;
    }

    async sendUpdate(update) {
        if (this.compressionEnabled) {
            const compressed = await this.compressUpdate(update);
            this.ws.send({
                type: 'ephemeral-update-compressed',
                data: Array.from(compressed)
            });
        } else {
            this.ws.send({
                type: 'ephemeral-update',
                data: Array.from(update)
            });
        }
    }

    async compressUpdate(update) {
        // 实现压缩算法
        // 这里可以使用 gzip、lz4 等压缩算法
        return update; // 简化示例
    }
}
```

## 性能优化策略

### 1. 内存管理

```javascript
class MemoryEfficientEphemeralStore {
    constructor() {
        this.store = new EphemeralStore();
        this.maxEntries = 1000;
        this.cleanupInterval = 30000;
        this.setupMemoryManagement();
    }

    setupMemoryManagement() {
        // 定期清理过期和过多的数据
        setInterval(() => {
            this.cleanupMemory();
        }, this.cleanupInterval);

        // 监听条目数量
        this.store.subscribe((event) => {
            if (this.store.keys().length > this.maxEntries) {
                this.trimOldestEntries();
            }
        });
    }

    cleanupMemory() {
        const keys = this.store.keys();
        const now = Date.now();

        // ���除过期的条目
        keys.forEach(key => {
            const data = this.store.get(key);
            if (data && data.timestamp && (now - data.timestamp) > this.cleanupInterval) {
                this.store.delete(key);
            }
        });
    }

    trimOldestEntries() {
        const keys = this.store.keys();
        const entriesWithTimestamp = keys.map(key => ({
            key,
            timestamp: this.store.get(key)?.timestamp || 0
        }));

        // 按时间戳排序，移除最旧的条目
        entriesWithTimestamp.sort((a, b) => a.timestamp - b.timestamp);
        const toRemove = entriesWithTimestamp.slice(0, keys.length - this.maxEntries);

        toRemove.forEach(({ key }) => {
            this.store.delete(key);
        });
    }
}
```

### 2. 网络优化

```javascript
class NetworkOptimizedEphemeralSync {
    constructor(websocket) {
        this.store = new EphemeralStore();
        this.ws = websocket;
        this.sendQueue = [];
        this.isSending = false;
        this.setupNetworkOptimization();
    }

    setupNetworkOptimization() {
        this.store.subscribeLocalUpdates((update) => {
            this.queueUpdate(update);
        });

        // 网络状态监听
        this.setupNetworkMonitoring();
    }

    queueUpdate(update) {
        this.sendQueue.push(update);
        this.processQueue();
    }

    async processQueue() {
        if (this.isSending || this.sendQueue.length === 0) return;

        this.isSending = true;

        try {
            while (this.sendQueue.length > 0) {
                const update = this.sendQueue.shift();
                await this.sendWithRetry(update);
            }
        } finally {
            this.isSending = false;
        }
    }

    async sendWithRetry(update, maxRetries = 3) {
        for (let i = 0; i < maxRetries; i++) {
            try {
                await this.sendUpdate(update);
                return;
            } catch (error) {
                console.warn(`发送失败，重试 ${i + 1}/${maxRetries}:`, error);
                if (i === maxRetries - 1) {
                    throw error;
                }
                await this.delay(Math.pow(2, i) * 1000);
            }
        }
    }

    setupNetworkMonitoring() {
        // 监听网络状态
        window.addEventListener('online', () => {
            console.log('网络连接恢复，重新发送队列');
            this.processQueue();
        });

        window.addEventListener('offline', () => {
            console.log('网络连接断开，暂停发送');
        });
    }

    delay(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }
}
```

## 最佳实践总结

### 1. 数据组织
- **命名空间**：使用前缀区分不同类型的数据
- **结构化**：保持数据结构的一致性和可预测性
- **版本化**：为数据结构添加版本字段，便于升级

### 2. 性能优化
- **批量处理**：合并短时间内的多个更新
- **压缩传输**：对大数据使用压缩算法
- **智能超时**：根据数据类型设置合适的超时时间

### 3. 用户体验
- **渐进式显示**：先显示基础信息，再加载详细信息
- **状态指示**：显示同步状态和网络连接状态
- **离线支持**：在网络断开时保持基本功能

### 4. 错误处理
- **重试机制**：网络失败时的自动重试
- **降级策略**：功能不可用时的备选方案
- **日志记录**：详细记录同步过程中的问题

通过 Ephemeral Store，开发者可以轻松实现实时的用户状态同步，为协作用户提供更加流畅和直观的协作体验。其简单而强大的 API 设计，使得复杂的实时状态管理变得简单高效。