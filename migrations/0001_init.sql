-- PurePaste initial schema.
--
-- One row per paste. Bodies live here only when they are small and unencrypted;
-- everything else lives in R2 and is referenced by object_key.
CREATE TABLE pastes (
	id TEXT PRIMARY KEY NOT NULL,
	kind TEXT NOT NULL CHECK (kind IN ('text', 'file', 'redirect')),

	-- Display metadata. NULL for encrypted pastes, where the title and filename
	-- travel inside the encrypted payload instead of the database.
	title TEXT,
	language TEXT,
	filename TEXT,
	content_type TEXT,
	size_bytes INTEGER NOT NULL DEFAULT 0,

	-- Body storage. Exactly one of content / object_key is set for text and file pastes.
	content TEXT,
	object_key TEXT,

	-- Password protection. The verifier is derived from a browser-side PBKDF2 key,
	-- so the server never sees the password and never runs a slow KDF.
	password_salt TEXT,
	password_verifier TEXT,
	password_iterations INTEGER,
	password_algo TEXT,

	-- Owner control. Only a peppered hash of the management token is stored.
	manage_hash TEXT NOT NULL,

	burn_after_read INTEGER NOT NULL DEFAULT 0 CHECK (burn_after_read IN (0, 1)),
	encrypted INTEGER NOT NULL DEFAULT 0 CHECK (encrypted IN (0, 1)),
	markdown INTEGER NOT NULL DEFAULT 0 CHECK (markdown IN (0, 1)),

	-- URL mode only.
	redirect_url TEXT,

	created_at INTEGER NOT NULL,
	expires_at INTEGER NOT NULL,
	-- Set when a burn-after-reading paste has been claimed. Rows are removed by the
	-- cleanup sweep after their R2 object is deleted.
	consumed_at INTEGER,
	views INTEGER NOT NULL DEFAULT 0
);

-- Cleanup sweep: expired rows.
CREATE INDEX idx_pastes_expires_at ON pastes (expires_at);

-- Cleanup sweep: claimed burn-after-reading rows awaiting object deletion.
CREATE INDEX idx_pastes_consumed_at ON pastes (consumed_at) WHERE consumed_at IS NOT NULL;
