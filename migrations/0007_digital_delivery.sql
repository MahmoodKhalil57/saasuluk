-- 0007: digital delivery. product.download_url is the access/download link a buyer receives for a digital good
-- (repo, license portal, file). It's snapshotted onto the order's items at purchase and surfaced on the PAID order
-- (orders card + success page) so an all-digital catalog actually delivers what was bought. Nullable (physical goods ship).
ALTER TABLE product ADD COLUMN download_url TEXT;
