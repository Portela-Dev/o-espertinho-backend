-- A date in Brazil identifies the latest confirmed observation of each link that day.
CREATE TABLE offer_price_history (
 offer_id UUID NOT NULL REFERENCES offers(id) ON DELETE CASCADE,
 day DATE NOT NULL,
 product_id UUID NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
 price_cents INTEGER CHECK(price_cents BETWEEN 1 AND 100000000),
 observed_at TIMESTAMPTZ NOT NULL,
 PRIMARY KEY(offer_id,day),
 CHECK(day=(observed_at AT TIME ZONE 'America/Sao_Paulo')::date)
);
CREATE INDEX offer_price_history_product_day_idx ON offer_price_history(product_id,day);
CREATE INDEX offer_price_history_day_idx ON offer_price_history(day);
-- Only the last confirmed observation is known; do not manufacture past days.
INSERT INTO offer_price_history(offer_id,day,product_id,price_cents,observed_at)
 SELECT id,(data_updated_at AT TIME ZONE 'America/Sao_Paulo')::date,product_id,
 CASE WHEN availability_status='available' THEN price_cents ELSE NULL END,data_updated_at
 FROM offers WHERE status='published' AND affiliate_url IS NOT NULL
 AND (data_updated_at AT TIME ZONE 'America/Sao_Paulo')::date >= (clock_timestamp() AT TIME ZONE 'America/Sao_Paulo')::date-364;
