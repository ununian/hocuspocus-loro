import * as encoding from "lib0/encoding";
import { OutgoingMessage } from "../OutgoingMessage.ts";
import { MessageType } from "../types.ts";

export class LoroUpdateMessage extends OutgoingMessage {
  type = MessageType.LoroUpdate as const;
  description = "Loro binary update";

  get(args: { documentName: string; update: Uint8Array }) {
    super.get(args);
    encoding.writeVarString(this.encoder, args.documentName);
    encoding.writeVarUint(this.encoder, this.type);
    encoding.writeVarUint8Array(this.encoder, args.update);
    return this.encoder;
  }
}

export default LoroUpdateMessage;

