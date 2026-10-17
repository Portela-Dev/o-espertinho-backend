-- Use the official image CDN: the storefront favicon can return an anti-bot page to browsers.
UPDATE marketplaces SET logo_url='https://m.media-amazon.com/images/G/01/aui/favicon_v2.ico' WHERE id='amazon' AND logo_url='https://www.amazon.com.br/favicon.ico';
