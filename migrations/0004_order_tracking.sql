-- 0004: order fulfillment — carrier + tracking number, set on the pending/paid → shipped transition so the
-- admin can record a shipment and the buyer gets an order-status email. D1 ALTER TABLE ADD COLUMN; nullable, so
-- existing rows stay valid. "order" is a reserved word → quoted.
ALTER TABLE "order" ADD COLUMN carrier TEXT;
ALTER TABLE "order" ADD COLUMN tracking_number TEXT;
