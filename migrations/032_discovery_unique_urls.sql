CREATE TABLE extension_catalog_discovery_seen (
 item_id UUID NOT NULL REFERENCES extension_catalog_items(id) ON DELETE CASCADE,
 url_key TEXT NOT NULL CHECK(length(url_key)=64),
 PRIMARY KEY(item_id,url_key)
);
COMMENT ON TABLE extension_catalog_discovery_seen IS 'Normalized URL hashes encountered per discovery item. Durable unique counts across pages, retries and resume; removed with execution history.';
