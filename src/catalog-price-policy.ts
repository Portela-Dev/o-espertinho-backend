// Shared by the extension counter and queue creation; NULL means never checked.
export const publishedPriceOfferSql = "status='published' AND affiliate_url IS NOT NULL";
export const priceRefreshDueSql = "(data_updated_at IS NULL OR data_updated_at<=clock_timestamp()-interval '24 hours')";
