import type { PasteKind, PasteRecord } from "../types";

export interface PasteRow {
	id: string;
	kind: string;
	title: string | null;
	language: string | null;
	filename: string | null;
	content_type: string | null;
	size_bytes: number;
	content: string | null;
	object_key: string | null;
	password_salt: string | null;
	password_verifier: string | null;
	password_iterations: number | null;
	password_algo: string | null;
	manage_hash: string;
	burn_after_read: number;
	encrypted: number;
	markdown: number;
	redirect_url: string | null;
	created_at: number;
	expires_at: number;
	consumed_at: number | null;
	views: number;
}

export function toRecord(row: PasteRow): PasteRecord {
	return {
		id: row.id,
		kind: row.kind as PasteKind,
		title: row.title,
		language: row.language,
		filename: row.filename,
		contentType: row.content_type,
		sizeBytes: row.size_bytes,
		content: row.content,
		objectKey: row.object_key,
		passwordSalt: row.password_salt,
		passwordVerifier: row.password_verifier,
		passwordIterations: row.password_iterations,
		passwordAlgo: row.password_algo,
		manageHash: row.manage_hash,
		burnAfterRead: row.burn_after_read === 1,
		encrypted: row.encrypted === 1,
		markdown: row.markdown === 1,
		redirectUrl: row.redirect_url,
		createdAt: row.created_at,
		expiresAt: row.expires_at,
		consumedAt: row.consumed_at,
		views: row.views,
	};
}

const COLUMNS = `id, kind, title, language, filename, content_type, size_bytes, content, object_key,
	password_salt, password_verifier, password_iterations, password_algo, manage_hash,
	burn_after_read, encrypted, markdown, redirect_url, created_at, expires_at, consumed_at, views`;

export type InsertOutcome = "created" | "collision";

function isUniqueViolation(error: unknown): boolean {
	const message = error instanceof Error ? error.message : String(error);
	return message.includes("UNIQUE constraint failed");
}

/**
 * Every statement is prepared and bound: no visitor input is ever interpolated
 * into SQL.
 */
export class MetadataStore {
	constructor(private readonly db: D1Database) {}

	async insert(record: PasteRecord): Promise<InsertOutcome> {
		try {
			await this.db
				.prepare(
					`INSERT INTO pastes (${COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
				)
				.bind(
					record.id,
					record.kind,
					record.title,
					record.language,
					record.filename,
					record.contentType,
					record.sizeBytes,
					record.content,
					record.objectKey,
					record.passwordSalt,
					record.passwordVerifier,
					record.passwordIterations,
					record.passwordAlgo,
					record.manageHash,
					record.burnAfterRead ? 1 : 0,
					record.encrypted ? 1 : 0,
					record.markdown ? 1 : 0,
					record.redirectUrl,
					record.createdAt,
					record.expiresAt,
					record.consumedAt,
					record.views,
				)
				.run();
			return "created";
		} catch (error) {
			if (isUniqueViolation(error)) return "collision";
			throw error;
		}
	}

	async findById(id: string): Promise<PasteRecord | null> {
		const row = await this.db.prepare(`SELECT ${COLUMNS} FROM pastes WHERE id = ?`).bind(id).first<PasteRow>();
		return row ? toRecord(row) : null;
	}

	async deleteById(id: string): Promise<boolean> {
		const result = await this.db.prepare(`DELETE FROM pastes WHERE id = ?`).bind(id).run();
		return (result.meta?.changes ?? 0) > 0;
	}

	/**
	 * Single-statement claim for burn-after-reading. SQLite applies this atomically,
	 * so concurrent reveals cannot both win: only the statement that finds
	 * `consumed_at IS NULL` updates a row and returns it.
	 */
	async claimBurn(id: string, now: number): Promise<PasteRecord | null> {
		const result = await this.db
			.prepare(
				`UPDATE pastes SET consumed_at = ?
				 WHERE id = ? AND consumed_at IS NULL AND expires_at > ?
				 RETURNING ${COLUMNS}`,
			)
			.bind(now, id, now)
			.all<PasteRow>();
		const row = result.results?.[0];
		return row ? toRecord(row) : null;
	}

	/** Expired rows, oldest expiry first. Used by the cleanup sweep. */
	async listExpired(now: number, limit: number): Promise<Array<{ id: string; objectKey: string | null }>> {
		const result = await this.db
			.prepare(`SELECT id, object_key FROM pastes WHERE expires_at <= ? ORDER BY expires_at ASC LIMIT ?`)
			.bind(now, limit)
			.all<{ id: string; object_key: string | null }>();
		return (result.results ?? []).map((row) => ({ id: row.id, objectKey: row.object_key }));
	}

	/**
	 * Claimed rows waiting for their object to be removed. `olderThan` keeps the
	 * sweep away from a paste that is still streaming to a reader.
	 */
	async listConsumed(olderThan: number, limit: number): Promise<Array<{ id: string; objectKey: string | null }>> {
		const result = await this.db
			.prepare(
				`SELECT id, object_key FROM pastes
				 WHERE consumed_at IS NOT NULL AND consumed_at <= ?
				 ORDER BY consumed_at ASC LIMIT ?`,
			)
			.bind(olderThan, limit)
			.all<{ id: string; object_key: string | null }>();
		return (result.results ?? []).map((row) => ({ id: row.id, objectKey: row.object_key }));
	}

	/** Deletes a batch of rows. Used by the cleanup sweep and by nothing else. */
	async deleteMany(ids: string[]): Promise<number> {
		if (ids.length === 0) return 0;
		const placeholders = ids.map(() => "?").join(", ");
		const result = await this.db
			.prepare(`DELETE FROM pastes WHERE id IN (${placeholders})`)
			.bind(...ids)
			.run();
		return result.meta?.changes ?? 0;
	}

	/** Batched view counting: one D1 write for many reads, never one per read. */
	async addViews(entries: Array<{ id: string; count: number }>): Promise<void> {
		if (entries.length === 0) return;
		const statements = entries.map((entry) =>
			this.db.prepare(`UPDATE pastes SET views = views + ? WHERE id = ?`).bind(entry.count, entry.id),
		);
		await this.db.batch(statements);
	}

	async countRows(): Promise<number> {
		const row = await this.db.prepare(`SELECT COUNT(*) AS total FROM pastes`).first<{ total: number }>();
		return row?.total ?? 0;
	}

	/** Live totals per kind, for the quiet stat bar on the front page. */
	async stats(now: number): Promise<Array<{ kind: string; count: number; bytes: number }>> {
		const rows = await this.db
			.prepare(
				`SELECT kind, COUNT(*) AS count, COALESCE(SUM(size_bytes), 0) AS bytes
				 FROM pastes WHERE expires_at > ? AND consumed_at IS NULL GROUP BY kind`,
			)
			.bind(now)
			.all<{ kind: string; count: number; bytes: number }>();
		return rows.results ?? [];
	}
}
