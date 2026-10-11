export type ObjectKind = "text" | "file" | "blob";

export interface PutOptions {
	size?: number;
	contentType?: string;
	filename?: string;
}

/**
 * Thin wrapper around R2.
 *
 * Object keys are derived only from the validated paste id and a storage kind —
 * never from a visitor-supplied filename or media type. The original display name
 * is kept as object metadata and in D1 instead.
 */
export class ObjectStore {
	constructor(
		private readonly bucket: R2Bucket,
		private readonly prefix = "pp/v1",
	) {}

	keyFor(id: string, kind: ObjectKind): string {
		return `${this.prefix}/${kind}/${id}`;
	}

	async put(
		key: string,
		value: ReadableStream | ArrayBuffer | Uint8Array | string,
		options: PutOptions = {},
	): Promise<void> {
		const httpMetadata: R2HTTPMetadata = {};
		if (options.contentType) httpMetadata.contentType = options.contentType;
		if (options.filename)
			httpMetadata.contentDisposition = `attachment; filename="${encodeURIComponent(options.filename)}"`;

		await this.bucket.put(key, value, {
			httpMetadata,
			customMetadata: options.filename ? { filename: options.filename } : undefined,
		});
	}

	/** Streams a request body straight into R2 without buffering it in the isolate. */
	async putFromRequest(key: string, request: Request, options: PutOptions = {}): Promise<void> {
		if (!request.body) throw new Error("Request body is unavailable");
		if (!options.size || options.size < 0) throw new Error("A known size is required to stream an upload");

		const { readable, writable } = new FixedLengthStream(options.size);
		// Start the upload and the pipe together so neither side blocks the other.
		const upload = this.bucket.put(key, readable, {
			httpMetadata: options.contentType ? { contentType: options.contentType } : undefined,
			customMetadata: options.filename ? { filename: options.filename } : undefined,
		});
		await request.body.pipeTo(writable);
		await upload;
	}

	async putBytes(key: string, bytes: Uint8Array, options: PutOptions = {}): Promise<void> {
		await this.put(key, bytes, options);
	}

	async get(key: string): Promise<R2ObjectBody | null> {
		const object = await this.bucket.get(key);
		if (!object || !("body" in object) || !object.body) return null;
		return object;
	}

	async head(key: string): Promise<R2Object | null> {
		return this.bucket.head(key);
	}

	/** Idempotent: deleting a key that is already gone is not an error. */
	async delete(keys: string[]): Promise<{ deleted: number; failed: string[] }> {
		const failed: string[] = [];
		let deleted = 0;
		// R2 accepts up to 1000 keys per call.
		for (let index = 0; index < keys.length; index += 1000) {
			const slice = keys.slice(index, index + 1000);
			if (slice.length === 0) continue;
			try {
				await this.bucket.delete(slice);
				deleted += slice.length;
			} catch {
				for (const key of slice) {
					try {
						await this.bucket.delete(key);
						deleted += 1;
					} catch {
						failed.push(key);
					}
				}
			}
		}
		return { deleted, failed };
	}
}
