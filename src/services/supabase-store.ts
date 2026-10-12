import type { AppEnv } from "../env";
import type { PasteKind, PasteRecord } from "../types";

/**
 * Supabase as a second runtime store, not a backup.
 *
 * D1 is still the primary: it answers from the colo you are standing in, and the
 * burn claim is a single atomic statement there. Supabase is AWS-side, so it is
 * used the way a cross-region replica should be — every write is mirrored, and it
 * *serves* reads when D1 errors — which means a paste stays readable when D1 has a
 * bad minute, and the data is in two places with no export step.
 *
 * Transport is PostgREST over HTTPS with an API key, which is the only way a Worker
 * can talk to Postgres without a socket pool. That also shapes the security story,
 * and `supabase/schema.sql` is written around it: RLS on, `anon` and `public`
 * revoked, `service_role` granted. So the key that mirrors is the service key —
 * with only the publishable anon key the mirror stays off and this file does the
 * one thing the anon key can safely do: keep the project awake.
 *
 * Nothing here may break a request. Every call is `Promise.race`'d against a
 * timeout and swallowed into a status, because a slow AWS region is not the
 * visitor's problem. Failures show up in `/api/config` and in Workers Logs.
 */

export interface SupabaseSettings {
	url: string;
	/** The key used for data operations: service_role when configured. */
	key: string;
	/** Which key that is, so status reporting can be blunt about the difference. */
	credential: "service" | "anon";
	table: string;
	timeoutMs: number;
}

export type MirrorState = "off" | "keepalive-only" | "on";

export interface SupabaseStatus {
	enabled: boolean;
	mirror: MirrorState;
	credential: "service" | "anon" | "none";
	table: string;
	/** Rolling counters, reset per isolate: what the mirror has done lately. */
	writes: number;
	writeFailures: number;
	fallbackReads: number;
	lastError: string | null;
	lastOkAt: number | null;
}

const DEFAULT_TIMEOUT_MS = 2500;

function trimSlash(value: string): string {
	return value.replace(/\/+$/, "");
}

export function supabaseSettingsFromEnv(env: AppEnv): {
	settings: SupabaseSettings | null;
	mirror: boolean;
	keepAlive: boolean;
} {
	const url = env.SUPABASE_URL?.trim();
	const anon = env.SUPABASE_ANON_KEY?.trim();
	const secret = env.SUPABASE_SECRET_KEY?.trim();
	const wanted = (env.SUPABASE_MIRROR ?? "auto").trim().toLowerCase();
	const keepAlive = (env.SUPABASE_KEEPALIVE ?? "on").trim().toLowerCase() !== "off";
	if (!url || (!anon && !secret)) return { settings: null, mirror: false, keepAlive: false };

	// `auto` mirrors only with a credential the shipped schema actually grants.
	const key = secret || anon || "";
	const credential: SupabaseSettings["credential"] = secret ? "service" : "anon";
	const mirror = wanted === "off" ? false : wanted === "on" ? true : credential === "service";
	if (wanted === "on" && !secret) {
		// Explicitly asked for, and impossible to do safely: say so rather than
		// silently writing with a key that PostgREST will reject.
		throw new Error(
			"SUPABASE_MIRROR=on needs SUPABASE_SECRET_KEY (the service_role key) as a secret; the anon key cannot write to a locked-down schema.",
		);
	}

	return {
		settings: {
			url: trimSlash(url),
			key,
			credential,
			table: env.SUPABASE_TABLE?.trim() || "pastes",
			timeoutMs: DEFAULT_TIMEOUT_MS,
		},
		mirror,
		keepAlive,
	};
}

const toBool = (value: unknown): boolean => value === true || value === 1 || value === "1";

interface SupabaseRow {
	id: string;
	kind: string;
	title: string | null;
	language: string | null;
	filename: string | null;
	content_type: string | null;
	size_bytes: number | null;
	content: string | null;
	object_key: string | null;
	password_salt: string | null;
	password_verifier: string | null;
	password_iterations: number | null;
	password_algo: string | null;
	manage_hash: string;
	burn_after_read: boolean | number;
	encrypted: boolean | number;
	markdown: boolean | number;
	redirect_url: string | null;
	created_at: number;
	expires_at: number;
	consumed_at: number | null;
	views: number | null;
}

/** PostgREST usually sends int8 as a number; some clients stringify it. */
function toNum(value: unknown, fallback = 0): number {
	if (typeof value === "number") return value;
	if (typeof value === "string") {
		const parsed = Number(value);
		return Number.isFinite(parsed) ? parsed : fallback;
	}
	return fallback;
}

function fromRow(row: SupabaseRow): PasteRecord {
	return {
		id: row.id,
		kind: row.kind as PasteKind,
		title: row.title,
		language: row.language,
		filename: row.filename,
		contentType: row.content_type,
		sizeBytes: toNum(row.size_bytes),
		content: row.content,
		objectKey: row.object_key,
		passwordSalt: row.password_salt,
		passwordVerifier: row.password_verifier,
		passwordIterations: row.password_iterations === null ? null : toNum(row.password_iterations),
		passwordAlgo: row.password_algo,
		manageHash: row.manage_hash,
		burnAfterRead: toBool(row.burn_after_read),
		encrypted: toBool(row.encrypted),
		markdown: toBool(row.markdown),
		redirectUrl: row.redirect_url,
		createdAt: toNum(row.created_at),
		expiresAt: toNum(row.expires_at),
		consumedAt: row.consumed_at === null ? null : toNum(row.consumed_at),
		views: toNum(row.views),
	};
}

function toRow(record: PasteRecord): Record<string, unknown> {
	return {
		id: record.id,
		kind: record.kind,
		title: record.title,
		language: record.language,
		filename: record.filename,
		content_type: record.contentType,
		size_bytes: record.sizeBytes,
		content: record.content,
		object_key: record.objectKey,
		password_salt: record.passwordSalt,
		password_verifier: record.passwordVerifier,
		password_iterations: record.passwordIterations,
		password_algo: record.passwordAlgo,
		manage_hash: record.manageHash,
		burn_after_read: record.burnAfterRead,
		encrypted: record.encrypted,
		markdown: record.markdown,
		redirect_url: record.redirectUrl,
		created_at: record.createdAt,
		expires_at: record.expiresAt,
		consumed_at: record.consumedAt,
		views: record.views,
	};
}

export class SupabaseStore {
	readonly status: SupabaseStatus;

	constructor(
		private readonly settings: SupabaseSettings,
		mirrorEnabled: boolean,
		/** The transport, injectable so the wire format is testable without a network. */
		private readonly fetchImpl: typeof fetch = (request, init) => fetch(request, init),
	) {
		this.status = {
			enabled: true,
			mirror: mirrorEnabled ? "on" : "keepalive-only",
			credential: settings.credential,
			table: settings.table,
			writes: 0,
			writeFailures: 0,
			fallbackReads: 0,
			lastError: null,
			lastOkAt: null,
		};
	}

	private get mirrorOn(): boolean {
		return this.status.mirror === "on";
	}

	private async request(path: string, init: RequestInit = {}): Promise<Response> {
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), this.settings.timeoutMs);
		try {
			return await this.fetchImpl(`${this.settings.url}${path}`, {
				...init,
				signal: controller.signal,
				headers: {
					apikey: this.settings.key,
					authorization: `Bearer ${this.settings.key}`,
					...((init.headers as Record<string, string>) ?? {}),
				},
			});
		} finally {
			clearTimeout(timer);
		}
	}

	private fail(message: string): void {
		this.status.writeFailures += 1;
		this.status.lastError = message.slice(0, 300);
	}

	/**
	 * Fire-and-forget-ish mirror write. Awaited by callers inside `waitUntil`, so a
	 * slow Supabase costs a background task and never a visitor's response.
	 */
	private async mutate(body: unknown, method: string, prefer: string): Promise<boolean> {
		if (!this.mirrorOn) return false;
		try {
			const response = await this.request(`/rest/v1/${this.settings.table}`, {
				method,
				body: JSON.stringify(body),
				headers: { "Content-Type": "application/json", prefer },
			});
			// 404 here means the table is missing: run supabase/schema.sql.
			if (!response.ok && response.status !== 409) {
				this.fail(`${method} ${response.status} ${(await response.text()).slice(0, 160)}`);
				return false;
			}
			this.status.writes += 1;
			this.status.lastOkAt = Date.now();
			return true;
		} catch (error) {
			this.fail(`${method} ${error instanceof Error ? error.message : String(error)}`);
			return false;
		}
	}

	async upsert(record: PasteRecord): Promise<boolean> {
		return this.mutate(toRow(record), "POST", "resolution=merge-duplicates,return=minimal");
	}

	/** Conditional update, so a mirror never claims a burn D1 did not claim first. */
	async markConsumed(id: string, at: number): Promise<void> {
		if (!this.mirrorOn) return;
		try {
			await this.request(`/rest/v1/${this.settings.table}?id=eq.${encodeURIComponent(id)}&consumed_at=is.null`, {
				method: "PATCH",
				body: JSON.stringify({ consumed_at: at }),
				headers: { prefer: "return=minimal" },
			});
			this.status.lastOkAt = Date.now();
		} catch (error) {
			this.fail(`patch ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	async addViews(entries: Array<{ id: string; count: number }>): Promise<void> {
		if (!this.mirrorOn || entries.length === 0) return;
		try {
			await this.request(`/rest/v1/rpc/apply_views`, {
				method: "POST",
				body: JSON.stringify({ deltas: entries.map((entry) => ({ paste_id: entry.id, delta: entry.count })) }),
				headers: { "Content-Type": "application/json", prefer: "return=minimal" },
			});
			this.status.lastOkAt = Date.now();
		} catch (error) {
			this.fail(`views ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	async deleteMany(ids: string[]): Promise<void> {
		if (!this.mirrorOn || ids.length === 0) return;
		try {
			await this.request(`/rest/v1/${this.settings.table}?id=in.(${ids.map((id) => `"${id}"`).join(",")})`, {
				method: "DELETE",
				headers: { prefer: "return=minimal" },
			});
			this.status.lastOkAt = Date.now();
		} catch (error) {
			this.fail(`delete ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	async findById(id: string): Promise<PasteRecord | null> {
		if (!this.mirrorOn) return null;
		const response = await this.request(`/rest/v1/${this.settings.table}?select=*&id=eq.${encodeURIComponent(id)}`);
		if (!response.ok) throw new Error(`supabase_read_${response.status}`);
		const rows = (await response.json()) as SupabaseRow[];
		this.status.fallbackReads += 1;
		const row = rows[0];
		return row ? fromRow(row) : null;
	}

	async listExpired(now: number, limit: number): Promise<Array<{ id: string; objectKey: string | null }>> {
		if (!this.mirrorOn) return [];
		const response = await this.request(
			`/rest/v1/${this.settings.table}?select=id,object_key&expires_at=lte.${now}&order=expires_at.asc&limit=${limit}`,
		);
		if (!response.ok) throw new Error(`supabase_read_${response.status}`);
		const rows = (await response.json()) as Array<{ id: string; object_key: string | null }>;
		return rows.map((row) => ({ id: row.id, objectKey: row.object_key }));
	}

	async listConsumed(olderThan: number, limit: number): Promise<Array<{ id: string; objectKey: string | null }>> {
		if (!this.mirrorOn) return [];
		const response = await this.request(
			`/rest/v1/${this.settings.table}?select=id,object_key&consumed_at=lte.${olderThan}&order=consumed_at.asc&limit=${limit}`,
		);
		if (!response.ok) throw new Error(`supabase_read_${response.status}`);
		const rows = (await response.json()) as Array<{ id: string; object_key: string | null }>;
		return rows.map((row) => ({ id: row.id, objectKey: row.object_key }));
	}

	/** Front-page totals, straight from the view the schema ships. */
	async stats(): Promise<Array<{ kind: string; count: number; bytes: number }>> {
		if (!this.mirrorOn) throw new Error("supabase_mirror_off");
		// The view does its own filtering against `now()`, so this is one request
		// whatever the clock says — and it is a real query, which also keeps the
		// project awake when the mirror is what is being asked.
		const response = await this.request(
			`/rest/v1/${this.settings.table.replace("pastes", "live_pastes")}?select=kind,count,bytes`,
		);
		if (!response.ok) throw new Error(`supabase_read_${response.status}`);
		return (await response.json()) as Array<{ kind: string; count: number; bytes: number }>;
	}

	/**
	 * `graceMs` mirrors the primary's own grace period — maintenance passes
	 * `CONSUMED_GRACE_MS`, so a reader mid-download keeps their copy in both stores.
	 */
	async purgeExpired(now: number, limit: number, graceMs = 300_000): Promise<number> {
		if (!this.mirrorOn) return 0;
		const response = await this.request(
			`/rest/v1/${this.settings.table}?or=(expires_at.lte.${now},consumed_at.lte.${now - graceMs})&limit=${limit}`,
			{ method: "DELETE", headers: { prefer: "return=headers-only" } },
		);
		if (!response.ok) throw new Error(`supabase_purge_${response.status}`);
		const match = /\/(\d+)\s*$/.exec(response.headers.get("content-range") ?? "");
		return match ? Number.parseInt(match[1] ?? "0", 10) : 0;
	}

	/**
	 * The keep-alive, and a schema check in one request.
	 *
	 * A free Supabase project pauses after a week without traffic, and a paused
	 * project answers the next visitor with a cold start or a refusal — so this runs
	 * on every cron tick whether or not mirroring is switched on. What matters for
	 * that is that the API answered at all: PostgREST opens a database connection to
	 * refuse you, and refusing is activity.
	 *
	 * `keepaliveRan` is the stronger claim: the function executed, which means
	 * supabase/schema.sql has been applied *and* the key can call it. The function is
	 * a bare `SELECT 1`, so it is deliberately granted to the publishable key — the
	 * one credential that is safe to hold for this purpose alone.
	 */
	async ping(): Promise<{ reachable: boolean; keepaliveRan: boolean; detail: string }> {
		try {
			const response = await this.request(`/rest/v1/rpc/supabase_keepalive`, { method: "POST", body: "{}" });
			if (response.ok) {
				this.status.lastOkAt = Date.now();
				return { reachable: true, keepaliveRan: true, detail: "rpc" };
			}
			if (response.status === 404) {
				// No such function: the schema is not applied yet. The OpenAPI document
				// still proves the project is awake and reachable.
				const root = await this.request("/rest/v1/", { method: "GET" }).catch(() => null);
				return {
					reachable: root !== null && root.status < 500,
					keepaliveRan: false,
					detail: `schema-missing (root ${root?.status ?? "unreachable"})`,
				};
			}
			return { reachable: response.status < 500, keepaliveRan: false, detail: `rpc${response.status}` };
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			return { reachable: false, keepaliveRan: false, detail: message };
		}
	}
}

const instances = new WeakMap<object, { signature: string; store: SupabaseStore | null }>();

/**
 * One instance per isolate per configuration, unless a transport is handed in: an
 * injected transport means the caller is driving the wire themselves, so nothing is
 * cached. The rolling counters in `status` are only meaningful if they are shared.
 */
export function supabaseStore(env: AppEnv, transport?: typeof fetch): SupabaseStore | null {
	const signature = [
		env.SUPABASE_URL,
		env.SUPABASE_SECRET_KEY ? "service" : env.SUPABASE_ANON_KEY ? "anon" : "none",
		env.SUPABASE_MIRROR,
		env.SUPABASE_TABLE,
	].join("|");
	if (!transport) {
		const cached = instances.get(env);
		if (cached && cached.signature === signature) return cached.store;
	}
	const { settings, mirror } = supabaseSettingsFromEnv(env);
	const store = settings
		? new SupabaseStore(settings, mirror, transport ?? ((request, init) => fetch(request, init)))
		: null;
	if (!transport) instances.set(env, { signature, store });
	return store;
}

/** What `GET /api/config` reports. No keys, no rows, just the state. */
export function supabaseReport(env: AppEnv): {
	enabled: boolean;
	mirror: MirrorState;
	credential: string;
	writes: number;
	write_failures: number;
	fallback_reads: number;
	last_error: string | null;
} {
	const store = supabaseStore(env);
	if (!store)
		return {
			enabled: false,
			mirror: "off",
			credential: "none",
			writes: 0,
			write_failures: 0,
			fallback_reads: 0,
			last_error: null,
		};
	return {
		enabled: true,
		mirror: store.status.mirror,
		credential: store.status.credential,
		writes: store.status.writes,
		write_failures: store.status.writeFailures,
		fallback_reads: store.status.fallbackReads,
		last_error: store.status.lastError,
	};
}
