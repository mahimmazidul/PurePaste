-- Which store holds this paste's body: "r2", "s3", "kv", or NULL for a row written
-- before the blob pool existed (and for every paste whose body is inline text).
--
-- The blob pool writes to one store per body and reads from the row's store first,
-- then the others, so this column is an optimisation and a diagnostic rather than a
-- requirement: a NULL is answered by asking everywhere. Deletions always go to every
-- store, which is why an object cannot survive a migration or a re-shard.
ALTER TABLE pastes ADD COLUMN blob_store TEXT;
