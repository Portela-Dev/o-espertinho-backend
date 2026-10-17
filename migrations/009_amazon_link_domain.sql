-- HTTPS redirect chain verified using the Amazon link supplied by the administrator:
-- link.amazon -> amzlinks.in -> www.amazon.com.br. Keep exact-host validation.
UPDATE marketplaces
SET allowed_hosts=array_append(allowed_hosts,'link.amazon'),updated_at=now()
WHERE id='amazon' AND NOT ('link.amazon'=ANY(allowed_hosts));
UPDATE marketplaces
SET allowed_hosts=array_append(allowed_hosts,'amzlinks.in'),updated_at=now()
WHERE id='amazon' AND NOT ('amzlinks.in'=ANY(allowed_hosts));
