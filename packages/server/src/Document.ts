import { Mutex } from "async-mutex";
import type WebSocket from "ws";
import {
	Awareness,
	applyAwarenessUpdate,
	removeAwarenessStates,
} from "y-protocols/awareness";
import { Doc, applyUpdate, encodeStateAsUpdate } from "yjs";
import type Connection from "./Connection.ts";
import { OutgoingMessage } from "./OutgoingMessage.ts";
import type { AwarenessUpdate } from "./types.ts";

export class Document extends Doc {
	awareness: Awareness;

	// In-memory storage for Loro updates (append-only). This is intentionally
	// simple and can be persisted via existing hooks if desired.
	loroUpdates: Uint8Array[] = [];

	// Loro document instance for server-side CRDT operations
	// This allows for proper version vector handling and incremental exports
	// The LoroDoc is optional - if not provided, we fall back to simple update storage
	loroDoc: any | null = null;

	callbacks = {
		// eslint-disable-next-line @typescript-eslint/no-empty-function
		onUpdate: (
			document: Document,
			connection: Connection,
			update: Uint8Array,
		) => {},
		// eslint-disable-next-line @typescript-eslint/no-empty-function
		onLoroUpdate: (
			document: Document,
			connection: Connection | undefined,
			update: Uint8Array,
		) => {},
		beforeBroadcastStateless: (document: Document, stateless: string) => {},
	};

	connections: Map<
		WebSocket,
		{
			clients: Set<any>;
			connection: Connection;
		}
	> = new Map();

	// The number of direct (non-websocket) connections to this document
	directConnectionsCount = 0;

	name: string;

	isLoading: boolean;

	isDestroyed = false;

	saveMutex = new Mutex();

	lastChangeTime = 0;

	/**
	 * Constructor.
	 */
	constructor(name: string, yDocOptions?: object) {
		super(yDocOptions);

		this.name = name;

		this.awareness = new Awareness(this);
		this.awareness.setLocalState(null);

		this.awareness.on("update", this.handleAwarenessUpdate.bind(this));
		this.on("update", this.handleUpdate.bind(this));

		this.isLoading = true;
	}

	/**
	 * Check if the Document (XMLFragment or Map) is empty
	 */
	isEmpty(fieldName: string): boolean {
		// eslint-disable-next-line no-underscore-dangle
		return !this.get(fieldName)._start && !this.get(fieldName)._map.size;
	}

	/**
	 * Merge the given document(s) into this one
	 */
	merge(documents: Doc | Array<Doc>): Document {
		(Array.isArray(documents) ? documents : [documents]).forEach((document) => {
			applyUpdate(this, encodeStateAsUpdate(document));
		});

		return this;
	}

	/**
	 * Set a callback that will be triggered when the document is updated
	 */
	onUpdate(
		callback: (
			document: Document,
			connection: Connection,
			update: Uint8Array,
		) => void,
	): Document {
		this.callbacks.onUpdate = callback;

		return this;
	}

	/**
	 * Set the LoroDoc instance for this document. This enables proper version
	 * vector handling and incremental exports.
	 */
	setLoroDoc(loroDoc: any): Document {
		this.loroDoc = loroDoc;
		// If we have existing updates, import them into the LoroDoc
		if (loroDoc && this.loroUpdates.length > 0) {
			this.loroUpdates.forEach(update => {
				try {
					// @ts-ignore - LoroDoc interface may not be available at compile time
					loroDoc.import(update);
				} catch (e) {
					// Ignore import errors for existing updates
				}
			});
		}
		return this;
	}

	/**
	 * Set a callback that will be triggered when a Loro update is received
	 */
	onLoroUpdate(
		callback: (
			document: Document,
			connection: Connection | undefined,
			update: Uint8Array,
		) => void,
	): Document {
		this.callbacks.onLoroUpdate = callback;

		return this;
	}

	/**
	 * Set a callback that will be triggered before a stateless message is broadcasted
	 */
	beforeBroadcastStateless(
		callback: (document: Document, stateless: string) => void,
	): Document {
		this.callbacks.beforeBroadcastStateless = callback;

		return this;
	}

	/**
	 * Register a connection and a set of clients on this document keyed by the
	 * underlying websocket connection
	 */
	addConnection(connection: Connection): Document {
		this.connections.set(connection.webSocket, {
			clients: new Set(),
			connection,
		});

		return this;
	}

	/**
	 * Is the given connection registered on this document
	 */
	hasConnection(connection: Connection): boolean {
		return this.connections.has(connection.webSocket);
	}

	/**
	 * Remove the given connection from this document
	 */
	removeConnection(connection: Connection): Document {
		removeAwarenessStates(
			this.awareness,
			Array.from(this.getClients(connection.webSocket)),
			null,
		);

		this.connections.delete(connection.webSocket);

		return this;
	}

	addDirectConnection(): Document {
		this.directConnectionsCount += 1;

		return this;
	}

	removeDirectConnection(): Document {
		if (this.directConnectionsCount > 0) {
			this.directConnectionsCount -= 1;
		}

		return this;
	}

	/**
	 * Get the number of active connections for this document
	 */
	getConnectionsCount(): number {
		return this.connections.size + this.directConnectionsCount;
	}

	/**
	 * Get an array of registered connections
	 */
	getConnections(): Array<Connection> {
		return Array.from(this.connections.values()).map((data) => data.connection);
	}

	/**
	 * Get the client ids for the given connection instance
	 */
	getClients(connectionInstance: WebSocket): Set<any> {
		const connection = this.connections.get(connectionInstance);

		return connection?.clients === undefined ? new Set() : connection.clients;
	}

	/**
	 * Has the document awareness states
	 */
	hasAwarenessStates(): boolean {
		return this.awareness.getStates().size > 0;
	}

	/**
	 * Apply the given awareness update
	 */
	applyAwarenessUpdate(connection: Connection, update: Uint8Array): Document {
		applyAwarenessUpdate(this.awareness, update, connection.webSocket);

		return this;
	}

	/**
	 * Handle an awareness update and sync changes to clients
	 * @private
	 */
	private handleAwarenessUpdate(
		{ added, updated, removed }: AwarenessUpdate,
		connectionInstance: WebSocket,
	): Document {
		const changedClients = added.concat(updated, removed);

		if (connectionInstance !== null) {
			const connection = this.connections.get(connectionInstance);

			if (connection) {
				added.forEach((clientId: any) => connection.clients.add(clientId));
				removed.forEach((clientId: any) => connection.clients.delete(clientId));
			}
		}

		this.getConnections().forEach((connection) => {
			const awarenessMessage = new OutgoingMessage(
				this.name,
			).createAwarenessUpdateMessage(this.awareness, changedClients);

			connection.send(awarenessMessage.toUint8Array());
		});

		return this;
	}

	/**
	 * Handle an updated document and sync changes to clients
	 */
	private handleUpdate(update: Uint8Array, connection: Connection): Document {
		this.callbacks.onUpdate(this, connection, update);

		const message = new OutgoingMessage(this.name)
			.createSyncMessage()
			.writeUpdate(update);

		this.getConnections().forEach((connection) => {
			connection.send(message.toUint8Array());
		});

		return this;
	}

	/**
	 * Append a Loro update, broadcast to all connections.
	 */
	public handleLoroUpdate(update: Uint8Array, origin?: Connection): Document {
		this.loroUpdates.push(update);

		// Import into LoroDoc if available
		if (this.loroDoc) {
			try {
				// @ts-ignore - LoroDoc interface may not be available at compile time
				this.loroDoc.import(update);
			} catch (e) {
				// Ignore import errors but log them
				console.error('Failed to import Loro update:', e);
			}
		}

		const message = new OutgoingMessage(this.name).writeLoroUpdate(update);
		this.getConnections().forEach((conn) => {
			if (origin && conn === origin) return;
			conn.send(message.toUint8Array());
		});

		// Trigger the callback
		this.callbacks.onLoroUpdate(this, origin, update);

		return this;
	}

	/**
	 * Export Loro updates based on version vector for efficient synchronization.
	 * If versionVector is provided, only exports missing updates.
	 * If no LoroDoc is available, falls back to all stored updates.
	 */
	public exportLoroUpdates(versionVector?: any): Uint8Array[] {
		if (this.loroDoc && versionVector) {
			try {
				// @ts-ignore - LoroDoc interface may not be available at compile time
				const update = this.loroDoc.export({ mode: "update", from: versionVector });
				// If export returns a single update, wrap it in array
				return update instanceof Uint8Array ? [update] : update;
			} catch (e) {
				console.error('Failed to export Loro updates with version vector:', e);
				// Fall back to all updates
			}
		}

		if (this.loroDoc) {
			try {
				// @ts-ignore - LoroDoc interface may not be available at compile time
				const update = this.loroDoc.export({ mode: "update" });
				return update instanceof Uint8Array ? [update] : update;
			} catch (e) {
				console.error('Failed to export Loro updates:', e);
			}
		}

		// Fallback to stored updates
		return this.loroUpdates;
	}

	/**
	 * Broadcast an ephemeral Loro update to all connections (not stored).
	 */
	public broadcastLoroEphemeral(update: Uint8Array, origin?: Connection): Document {
		const message = new OutgoingMessage(this.name).writeLoroEphemeral(update);
		this.getConnections().forEach((conn) => {
			if (origin && conn === origin) return;
			conn.send(message.toUint8Array());
		});
		return this;
	}

	/**
	 * Broadcast stateless message to all connections
	 */
	public broadcastStateless(
		payload: string,
		filter?: (conn: Connection) => boolean,
	): void {
		this.callbacks.beforeBroadcastStateless(this, payload);

		const connections = filter
			? this.getConnections().filter(filter)
			: this.getConnections();

		connections.forEach((connection) => {
			connection.sendStateless(payload);
		});
	}

	destroy() {
		super.destroy();
		this.isDestroyed = true;
	}
}

export default Document;
