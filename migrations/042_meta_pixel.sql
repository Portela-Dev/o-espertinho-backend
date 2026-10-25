CREATE TABLE meta_pixel_settings (
  id boolean PRIMARY KEY DEFAULT true CHECK (id),
  enabled boolean NOT NULL DEFAULT false,
  pixel_id text NOT NULL CHECK (pixel_id ~ '^[0-9]{5,30}$'),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO meta_pixel_settings(id, enabled, pixel_id)
VALUES(true, true, '1918844482826551');
