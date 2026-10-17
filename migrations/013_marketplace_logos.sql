ALTER TABLE marketplaces ADD COLUMN logo_url TEXT NOT NULL DEFAULT '';
UPDATE marketplaces SET logo_url='https://www.amazon.com.br/favicon.ico' WHERE id='amazon';
UPDATE marketplaces SET logo_url='https://http2.mlstatic.com/frontend-assets/ui-navigation/5.18.9/mercadolibre/favicon.svg' WHERE id='mercadolivre';
