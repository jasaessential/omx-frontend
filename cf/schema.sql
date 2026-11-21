-- OMX — D1 schema (Firestore replacement). See cf/store.js for the model.
CREATE TABLE IF NOT EXISTS docs (
    path       TEXT PRIMARY KEY,
    coll       TEXT NOT NULL,
    id         TEXT NOT NULL,
    data       TEXT NOT NULL,
    ver        INTEGER NOT NULL DEFAULT 1,
    created_at INTEGER,
    updated_at INTEGER
);

CREATE INDEX IF NOT EXISTS docs_coll_id      ON docs (coll, id);
-- Fields the site and server filter / sort on
CREATE INDEX IF NOT EXISTS docs_userId       ON docs (coll, json_extract(data, '$."userId"'));
CREATE INDEX IF NOT EXISTS docs_shopId       ON docs (coll, json_extract(data, '$."shopId"'));
CREATE INDEX IF NOT EXISTS docs_status       ON docs (coll, json_extract(data, '$."status"'));
CREATE INDEX IF NOT EXISTS docs_createdAt    ON docs (coll, json_extract(data, '$."createdAt"'));
CREATE INDEX IF NOT EXISTS docs_groupOrderId ON docs (coll, json_extract(data, '$."groupOrderId"'));
CREATE INDEX IF NOT EXISTS docs_referrerUid  ON docs (coll, json_extract(data, '$."referrerUid"'));
CREATE INDEX IF NOT EXISTS docs_category     ON docs (coll, json_extract(data, '$."category"'));

CREATE TABLE IF NOT EXISTS coll_versions (
    coll TEXT PRIMARY KEY,
    v    INTEGER NOT NULL
);
