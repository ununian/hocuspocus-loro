import * as encoding from "lib0/encoding";
import { OutgoingMessage } from "../OutgoingMessage.ts";
import { MessageType } from "../types.ts";

export class LoroSyncRequestMessage extends OutgoingMessage {
  type = MessageType.LoroSyncRequest as const;
  description = "Request Loro updates (optionally with version vector)";

  get(args: { documentName: string; versionJSON?: string }) {
    super.get(args);
    encoding.writeVarString(this.encoder, args.documentName);
    encoding.writeVarUint(this.encoder, this.type);
    // Always write version string (empty string if not provided)
    encoding.writeVarString(this.encoder, args.versionJSON || "");
    return this.encoder;
  }
}

export default LoroSyncRequestMessage;

