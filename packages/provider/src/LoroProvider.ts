import { readAuthMessage } from "@hocuspocus/common";
import type { Event, MessageEvent } from "ws";
import EventEmitter from "./EventEmitter.ts";
import type { CompleteHocuspocusProviderWebsocketConfiguration } from "./HocuspocusProviderWebsocket.ts";
import { HocuspocusProviderWebsocket } from "./HocuspocusProviderWebsocket.ts";
import { IncomingMessage } from "./IncomingMessage.ts";
import { MessageSender } from "./MessageSender.ts";
import { AuthenticationMessage } from "./OutgoingMessages/AuthenticationMessage.ts";
import { LoroEphemeralMessage } from "./OutgoingMessages/LoroEphemeralMessage.ts";
import { LoroSyncRequestMessage } from "./OutgoingMessages/LoroSyncRequestMessage.ts";
import { LoroUpdateMessage } from "./OutgoingMessages/LoroUpdateMessage.ts";
import type {
  ConstructableOutgoingMessage,
  onCloseParameters,
  onDisconnectParameters,
  onMessageParameters,
  onOpenParameters,
  onOutgoingMessageParameters,
  onStatusParameters,
} from "./types.ts";
import { MessageType } from "./types.ts";
import type { EphemeralStore, LoroDoc } from "loro-crdt";

export interface LoroProviderConfiguration extends Partial<CompleteLoroProviderConfiguration> {
  name: string;
}

export interface CompleteLoroProviderConfiguration {
  /** 文档标识 */
  name: string;
  /** Loro 文档对象，需具备 import() 与 subscribeLocalUpdates() */
  doc: LoroDoc;
  /** 可选的 Ephemeral Store，需具备 apply() 与 subscribeLocalUpdates() */
  ephemeralStore?: EphemeralStore | null;
  /** Token，可为字符串或函数（可返回 Promise） */
  token: string | (() => string) | (() => Promise<string>) | null;
  /** WebSocket 提供者 */
  websocketProvider: HocuspocusProviderWebsocket;
  /** 定期触发增量同步请求，避免长时间无消息断开 */
  forceSyncInterval: false | number;

  onOpen: (data: onOpenParameters) => void;
  onConnect: () => void;
  onStatus: (data: onStatusParameters) => void;
  onMessage: (data: onMessageParameters) => void;
  onOutgoingMessage: (data: onOutgoingMessageParameters) => void;
  onDisconnect: (data: onDisconnectParameters) => void;
  onClose: (data: onCloseParameters) => void;
  onDestroy: () => void;
}

export class LoroProvider extends EventEmitter {
  public configuration: CompleteLoroProviderConfiguration = {
    name: "",
    // @ts-ignore
    doc: undefined,
    ephemeralStore: null,
    token: null,
    // @ts-ignore
    websocketProvider: undefined,
    forceSyncInterval: 15000,
    onOpen: () => null,
    onConnect: () => null,
    onMessage: () => null,
    onOutgoingMessage: () => null,
    onStatus: () => null,
    onDisconnect: () => null,
    onClose: () => null,
    onDestroy: () => null,
  };

  // 复用同一 WebSocket 管理模型
  manageSocket = false;

  private _isAttached = false;

  private unsubDoc?: () => void;
  private unsubEphemeral?: () => void;

  intervals: any = {
    forceSync: null,
  };

  boundOnOpen = this.onOpen.bind(this);

  constructor(configuration: LoroProviderConfiguration) {
    super();
    this.setConfiguration(configuration);

    // 建立 doc 更新订阅
    if (this.configuration.doc?.subscribeLocalUpdates) {
      const unsub = this.configuration.doc.subscribeLocalUpdates((update: Uint8Array) => {
        this.send(LoroUpdateMessage, {
          documentName: this.configuration.name,
          update,
        });
      });
      // 某些实现返回 unsubscribe 函数
      if (typeof unsub === "function") this.unsubDoc = unsub;
    }

    // 建立 Ephemeral 更新订阅
    if (this.configuration.ephemeralStore?.subscribeLocalUpdates) {
      const unsub = this.configuration.ephemeralStore.subscribeLocalUpdates(
        (update: Uint8Array) => {
          this.send(LoroEphemeralMessage, {
            documentName: this.configuration.name,
            update,
          });
        }
      );
      if (typeof unsub === "function") this.unsubEphemeral = unsub;
    }

    this.registerWebsocketEvents();

    if (
      this.configuration.forceSyncInterval &&
      typeof this.configuration.forceSyncInterval === "number"
    ) {
      this.intervals.forceSync = setInterval(
        this.forceSync.bind(this),
        this.configuration.forceSyncInterval
      );
    }

    if (this.manageSocket) {
      this.attach();
    }
  }

  private forwardConnect = () => this.emit("connect");
  private forwardStatus = (e: onStatusParameters) => this.emit("status", e);
  private forwardClose = (e: onCloseParameters) => this.emit("close", e);
  private forwardDisconnect = (e: onDisconnectParameters) => this.emit("disconnect", e);
  private forwardDestroy = () => this.emit("destroy");

  private registerWebsocketEvents() {
    // 让使用者也能监听到 Provider 级别事件
    this.on("open", this.configuration.onOpen);
    this.on("message", this.configuration.onMessage);
    this.on("outgoingMessage", this.configuration.onOutgoingMessage);
    this.on("status", this.configuration.onStatus);
    this.on("disconnect", this.configuration.onDisconnect);
    this.on("close", this.configuration.onClose);
    this.on("destroy", this.configuration.onDestroy);
  }

  public setConfiguration(configuration: Partial<LoroProviderConfiguration> = {}) {
    if (!configuration.websocketProvider) {
      const websocketProviderConfig =
        configuration as CompleteHocuspocusProviderWebsocketConfiguration;
      this.manageSocket = true;
      this.configuration.websocketProvider = new HocuspocusProviderWebsocket({
        url: websocketProviderConfig.url,
      });
    }

    this.configuration = { ...this.configuration, ...configuration } as any;
  }

  public get isAttached() {
    return this._isAttached;
  }

  send(message: ConstructableOutgoingMessage, args: any) {
    if (!this._isAttached) return;
    const messageSender = new MessageSender(message as any, args);
    this.emit("outgoingMessage", { message: messageSender.message });
    messageSender.send(this.configuration.websocketProvider);
  }

  async onOpen(event: Event) {
    this.emit("open", { event });
    await this.sendToken();
    this.startSync();
  }

  async sendToken() {
    let token: string | null;
    try {
      token = await this.getToken();
    } catch (error) {
      // 直接忽略，无 token 继续
      return;
    }
    this.send(AuthenticationMessage, {
      token: token ?? "",
      documentName: this.configuration.name,
    });
  }

  async getToken() {
    if (typeof this.configuration.token === "function") {
      const token = await this.configuration.token();
      return token;
    }
    return this.configuration.token;
  }

  startSync() {
    // 发送同步请求，尽可能携带版本向量（如果可用）
    let versionJSON: string | undefined;
    try {
      if (this.configuration.doc?.oplogVersion) {
        versionJSON = JSON.stringify(this.configuration.doc.oplogVersion());
      }
    } catch (_) {
      // ignore
    }
    this.send(LoroSyncRequestMessage, {
      documentName: this.configuration.name,
      versionJSON,
    });
  }

  forceSync() {
    this.startSync();
  }

  onMessage(event: MessageEvent) {
    const message = new IncomingMessage(event.data);

    const documentName = message.readVarString();
    message.writeVarString(documentName);

    this.emit("message", { event, message: new IncomingMessage(event.data) });

    const type = message.readVarUint();

    switch (type) {
      case MessageType.Auth: {
        readAuthMessage(
          message.decoder,
          this.sendToken.bind(this),
          // permission denied
          () => {},
          // authenticated
          () => {}
        );
        break;
      }
      case MessageType.LoroUpdate: {
        const update = message.readVarUint8Array();
        this.configuration.doc?.import?.(update);
        break;
      }
      case MessageType.LoroSyncBatch: {
        // number of updates
        const count = message.readVarUint() as number;
        for (let i = 0; i < count; i += 1) {
          const update = message.readVarUint8Array();
          this.configuration.doc?.import?.(update);
        }
        break;
      }
      case MessageType.LoroEphemeral: {
        const update = message.readVarUint8Array();
        this.configuration.ephemeralStore?.apply?.(update);
        break;
      }
      default: {
        // 忽略其它类型
        break;
      }
    }
  }

  onClose() {
    // no-op for now
  }

  attach() {
    if (this._isAttached) return;

    this.configuration.websocketProvider.on("connect", this.forwardConnect);
    this.configuration.websocketProvider.on("status", this.forwardStatus);
    this.configuration.websocketProvider.on("open", this.boundOnOpen);
    this.configuration.websocketProvider.on("close", this.forwardClose);
    this.configuration.websocketProvider.on("disconnect", this.forwardDisconnect);
    this.configuration.websocketProvider.on("destroy", this.forwardDestroy);
    this.configuration.websocketProvider.attach(this as any);
    this._isAttached = true;
  }

  detach() {
    this.configuration.websocketProvider.off("connect", this.forwardConnect);
    this.configuration.websocketProvider.off("status", this.forwardStatus);
    this.configuration.websocketProvider.off("open", this.boundOnOpen);
    this.configuration.websocketProvider.off("close", this.forwardClose);
    this.configuration.websocketProvider.off("disconnect", this.forwardDisconnect);
    this.configuration.websocketProvider.off("destroy", this.forwardDestroy);
    this.configuration.websocketProvider.detach(this as any);
    this._isAttached = false;
  }

  destroy() {
    this.emit("destroy");
    if (this.intervals.forceSync) {
      clearInterval(this.intervals.forceSync);
    }
    if (this.unsubDoc) {
      try {
        this.unsubDoc();
      } catch (_) {}
      this.unsubDoc = undefined;
    }
    if (this.unsubEphemeral) {
      try {
        this.unsubEphemeral();
      } catch (_) {}
      this.unsubEphemeral = undefined;
    }
    this.detach();
  }
}

export default LoroProvider;
