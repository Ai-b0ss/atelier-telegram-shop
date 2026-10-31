INSERT OR IGNORE INTO categories (id,name) VALUES (1,'Аксессуары'),(2,'Футболки'),(3,'Худи');
INSERT OR IGNORE INTO products (id,category_id,name,description,active) VALUES
(1,1,'Сумка-шоппер','Текстиль, ручная роспись (демонстрационный товар)',1),
(2,2,'Футболка с принтом','Хлопок, авторский принт (демонстрационный товар)',1),
(3,3,'Худи с вышивкой','Утеплённый хлопок, вышивка (демонстрационный товар)',1);
INSERT OR IGNORE INTO variants(id,product_id,sku,size,color,price_cents,cost_cents,stock,active) VALUES
(1,1,'TOTE-UNI','one size','молочный',250000,110000,5,1),
(2,2,'TSHIRT-S','S','белый',300000,125000,8,1),
(3,2,'TSHIRT-M','M','белый',300000,125000,8,1),
(4,3,'HOODIE-M','M','серый',650000,290000,4,1);
