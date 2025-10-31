import type { Awareness, EphemeralStore, LoroDoc } from "loro-crdt";
import { LoroProvider, HocuspocusProviderWebsocket } from "../../../packages/provider/src/index.ts";
import type { LoroDocType } from "loro-prosemirror";

export const createLoroProvider = async (
  documentId: string,
  doc: LoroDoc,
  token?: string,
  ephemeralStore?: EphemeralStore
) => {
  const CollaborationUrl = `ws://localhost:8000`;

  const websocket = new HocuspocusProviderWebsocket({
    //自己实现多 Provider 共享 ws 即可，避免多篇文档时发起多个 ws 链接
    url: CollaborationUrl,
    autoConnect: true,
  });
  const provider = new LoroProvider({
    websocketProvider: websocket,
    name: documentId, // 服务端的 documentName
    doc: doc,
    token,
    ephemeralStore,
    // onAuthenticationFailed: (e) => {
    //   // 用户验证失败处理
    //   if (e.reason === "Server Error") {
    //     this.slots.serverError.emit();
    //   } else {
    //     this.slots.authenticateFailed.emit();
    //   }
    // },
    // onAuthenticated: () => {
    //   // 用户验证成功，权限处理
    //   this.slots.authenticated.emit(
    //     (this.provider.authorizedScope || "readonly") as "readonly" | "read-write"
    //   );
    // },
  });

  // 手动 attach，触发 WebSocket 事件监听和连接
  provider.attach();

  return {
    provider,
    websocket,
  };
};
