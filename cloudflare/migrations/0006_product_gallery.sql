-- Static storefront photos: JSON array of /products/... paths, plus a size chart path.
ALTER TABLE products ADD COLUMN images TEXT;
ALTER TABLE products ADD COLUMN size_chart TEXT;
