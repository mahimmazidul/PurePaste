export type PasteKind = "text" | "file" | "redirect";

/** A row of the `pastes` table. */
export interface PasteRecord {
	id: string;
	kind: PasteKind;
	title: string | null;
	language: string | null;
	filename: string | null;
	contentType: string | null;
	sizeBytes: number;
	content: string | null;
	objectKey: string | null;
	passwordSalt: string | null;
	passwordVerifier: string | null;
	passwordIterations: number | null;
	passwordAlgo: string | null;
	manageHash: string;
	burnAfterRead: boolean;
	encrypted: boolean;
	markdown: boolean;
	redirectUrl: string | null;
	createdAt: number;
	expiresAt: number;
	consumedAt: number | null;
	views: number;
}

/** Password material derived in the browser; the server only ever sees the verifier. */
export interface PasswordMaterial {
	salt: string;
	verifier: string;
	iterations: number;
	algo: string;
}

export type PasteBody =
	| { type: "text"; text: string }
	| { type: "bytes"; bytes: Uint8Array }
	| { type: "none" };

/** A validated creation request, independent of how it arrived (HTML form, JSON, raw body). */
export interface CreatePasteInput {
	kind: PasteKind;
	title: string | null;
	language: string | null;
	markdown: boolean;
	burnAfterRead: boolean;
	encrypted: boolean;
	ttlSeconds: number;
	slug: string | null;
	password: PasswordMaterial | null;
	redirectUrl: string | null;
	body: PasteBody;
	filename: string | null;
	contentType: string | null;
}

export interface CreatedPaste {
	record: PasteRecord;
	/** Returned to the creator once and never stored in plaintext. */
	manageToken: string;
}

/** Result of asking for a paste for reading. */
export type ReadResult =
	| { status: "ok"; record: PasteRecord }
	| { status: "missing" }
	| { status: "expired" }
	| { status: "consumed" }
	| { status: "needs-reveal"; record: PasteRecord };
