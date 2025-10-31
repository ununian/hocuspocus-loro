import { Cursor, EphemeralStore, type PeerID } from "loro-crdt";

export type CursorState = {
  anchor?: Cursor;
  focus?: Cursor;
  user?: { name: string; color: string };
};

export class CursorEphemeralStore extends EphemeralStore<
  Record<
    PeerID,
    {
      anchor: Uint8Array | null;
      focus: Uint8Array | null;
      user: { name: string; color: string } | null;
    }
  >
> {
  private readonly localPeerId: PeerID;

  constructor(peerId: PeerID, timeout: number = 30_000) {
    super(timeout);
    this.localPeerId = peerId;
  }

  getAll(): { [peer in PeerID]: CursorState } {
    const ans: {
      [peer in PeerID]: CursorState;
    } = {};
    for (const [peer, state] of Object.entries(this.getAllStates())) {
      const typedState = state as unknown as {
        anchor: Uint8Array | null;
        focus: Uint8Array | null;
        user: { name: string; color: string } | null;
      };
      ans[peer as PeerID] = {
        anchor: typedState.anchor ? Cursor.decode(typedState.anchor as Uint8Array) : undefined,
        focus: typedState.focus ? Cursor.decode(typedState.focus as Uint8Array) : undefined,
        user: typedState.user ? typedState.user : undefined,
      };
    }
    return ans;
  }

  setLocal(state: { anchor?: Cursor; focus?: Cursor; user?: { name: string; color: string } }) {
    this.set(this.localPeerId, {
      anchor: state.anchor?.encode() || null,
      focus: state.focus?.encode() || null,
      user: state.user || null,
    });
  }

  getLocal() {
    const state = this.get(this.localPeerId);
    if (!state) {
      return null;
    }
    return {
      anchor: state.anchor && Cursor.decode(state.anchor),
      focus: state.focus && Cursor.decode(state.focus),
      user: state.user,
    };
  }
}

export function cursorEq(a?: Cursor | null, b?: Cursor | null) {
  if (!a && !b) {
    return true;
  }
  if (!a || !b) {
    return false;
  }

  const aPos = a.pos();
  const bPos = b.pos();
  return (
    aPos?.peer === bPos?.peer &&
    aPos?.counter === bPos?.counter &&
    a.containerId() === b.containerId()
  );
}
