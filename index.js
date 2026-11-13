const express = require("express");
const sqlite3 = require("sqlite3").verbose();
const os = require("os");

const app = express();
const port = 3000;

// connect db
let db = new sqlite3.Database("polarsnow.db", (err) => {
  if (err) return console.error("DB connect error:", err.message);
  console.log("Connected to SQLite database");
});

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static("public"));
app.set("view engine", "ejs");

//  root: ถ้าไม่ระบุ จะเด้งไปที่โต๊ะ 1
app.get("/", (req, res) => {
  res.redirect("/menu/1");
});

// ตรวจสอบเลขโต๊ะ
function isValidTableId(id) {
  const num = parseInt(id, 10);
  return num >= 1 && num <= 15;
}

// ===================== MENU =====================
app.get("/menu/:table_id", (req, res) => {
  const { table_id } = req.params;

  if (!isValidTableId(table_id)) {
    return res.status(404).send("ไม่พบโต๊ะนี้ (รองรับเฉพาะโต๊ะ 1-15)");
  }

  const sqlFood = "SELECT food_id, food_name, food_price, food_pic, category FROM food";
  const sqlTopping = `
    SELECT ft.food_id, t.topping_id, t.topping_name, t.topping_price
    FROM food_toppings ft
    JOIN toppings t ON ft.topping_id = t.topping_id
  `;
  const sqlCart = `
    SELECT c.cart_id, f.food_id, f.food_name, f.food_price, c.note, c.size_id,
           t.topping_name, ct.price AS topping_price, ct.quantity AS topping_qty,
           s.size_name, s.extra_price AS size_extra
    FROM cart c
    JOIN food f ON c.food_id = f.food_id
    LEFT JOIN sizes s ON c.size_id = s.size_id
    LEFT JOIN cart_toppings ct ON c.cart_id = ct.cart_id
    LEFT JOIN toppings t ON ct.topping_id = t.topping_id
    WHERE c.table_id = ?
    ORDER BY c.cart_id;
  `;

  db.all(sqlFood, [], (err, foodRows) => {
    if (err) {
      console.error("sqlFood error:", err.message);
      return res.status(500).send("DB Error");
    }

    db.all(sqlTopping, [], (err2, toppingRows) => {
      if (err2) {
        console.error("sqlTopping error:", err2.message);
        return res.status(500).send("DB Error");
      }

      const foodWithToppings = foodRows.map((f) => ({
        ...f,
        toppings: toppingRows.filter((t) => t.food_id === f.food_id),
      }));

      const categories = {};
      foodWithToppings.forEach((f) => {
        if (!categories[f.category]) categories[f.category] = [];
        categories[f.category].push(f);
      });

      db.all(sqlCart, [table_id], (err3, cartRows) => {
        if (err3) {
          console.error("sqlCart error:", err3.message);
          return res.status(500).send("DB Error");
        }

        const cart = [];
        const map = {};
        cartRows.forEach((r) => {
          if (!map[r.cart_id]) {
            map[r.cart_id] = {
              cart_id: r.cart_id,
              food_id: r.food_id,
              food_name: r.food_name,
              food_price: r.food_price,
              note: r.note,
              size_id: r.size_id,
              size_name: r.size_name,
              size_extra: r.size_extra,
              toppings: [],
            };
            cart.push(map[r.cart_id]);
          }
          if (r.topping_name) {
            map[r.cart_id].toppings.push({
              name: r.topping_name,
              price: r.topping_price,
              qty: r.topping_qty || 1 
            });
        }

        });

        res.render("menu", { categories, cart, table_id });
      });
    });
  });
});

// ===================== เลือกวิธีชำระเงิน (สำหรับ menu) =====================
app.get("/chose-pay/:table_id", (req, res) => {
  const tableId = req.params.table_id;

  const sql = `
    SELECT 
      oi.order_item_id, oi.note,
      f.food_name, f.food_price,
      s.size_name, s.extra_price,
      t.topping_name, oit.quantity AS topping_qty, t.topping_price,
      o.order_id
    FROM orders o
    JOIN order_items oi ON o.order_id = oi.order_id
    JOIN food f ON oi.food_id = f.food_id
    LEFT JOIN sizes s ON oi.size_id = s.size_id
    LEFT JOIN order_item_toppings oit ON oi.order_item_id = oit.order_item_id
    LEFT JOIN toppings t ON oit.topping_id = t.topping_id
    WHERE o.table_id = ? AND o.status IN ('pending','done')
    ORDER BY oi.order_item_id
  `;

  db.all(sql, [tableId], (err, rows) => {
    if (err) {
      console.error("Chose-pay query error:", err.message);
      return res.status(500).send("DB Error");
    }

    // จัด group ตาม order_item_id
    const items = {};
    rows.forEach(r => {
      if (!items[r.order_item_id]) {
        const basePrice = r.food_price + (r.extra_price || 0);
        items[r.order_item_id] = {
          food_name: r.food_name,
          size_name: r.size_name,
          note: r.note,
          price: basePrice,
          toppings: []
        };
      }
      if (r.topping_name) {
        items[r.order_item_id].toppings.push(`${r.topping_name} x${r.topping_qty}`);
        items[r.order_item_id].price += (r.topping_price * (r.topping_qty || 1));
      }
    });

    const allItems = Object.values(items);
    const total = allItems.reduce((sum, it) => sum + it.price, 0);

    res.render("chose-pay", { table_id: tableId, items: allItems, total });
  });
});

// แสดง QR Code 
app.get("/qr/:table_id", (req, res) => {
  const tableId = req.params.table_id;
  res.render("qr-payment", { table_id: tableId });
});

app.get("/qr-complete/:table_id", (req, res) => {
  const tableId = req.params.table_id;

  //  update orders -> completed
  db.run(`UPDATE orders SET status='completed' WHERE table_id=? AND status IN ('pending','done')`, [tableId], function(err) {
    if (err) {
      console.error("Update orders error:", err.message);
      return res.status(500).send("DB Error");
    }

    //  insert payment record (method = 'qrcode')
    db.run(
      `INSERT INTO payments (order_id, method, amount) 
       SELECT order_id, 'qrcode', (
         SELECT SUM(f.food_price + IFNULL(s.extra_price,0) + IFNULL(t.topping_price * oit.quantity,0))
         FROM order_items oi
         JOIN food f ON oi.food_id = f.food_id
         LEFT JOIN sizes s ON oi.size_id = s.size_id
         LEFT JOIN order_item_toppings oit ON oi.order_item_id = oit.order_item_id
         LEFT JOIN toppings t ON oit.topping_id = t.topping_id
         WHERE oi.order_id = orders.order_id
       )
       FROM orders WHERE table_id=? AND status='completed'`,
      [tableId],
      (err2) => {
        if (err2) {
          console.error("Insert payment error:", err2.message);
        }
        res.render("customer-payment-complete", { table_id: tableId });
      }
    );
  });
});

// ===================== CUSTOMER CASHIER PAYMENT =====================
app.get("/customer-cashier-payment/:table_id", (req, res) => {
  const tableId = req.params.table_id;
  res.render("customer-cashier-payment", { table_id: tableId });
});


// ===================== ADD TO CART =====================
app.post("/cart/add", (req, res) => {
  const { table_id, food_id, note } = req.body;
  let { size_id } = req.body;
  let toppings = req.body.toppings;

  // ถ้าไม่ได้เลือก size → default = 1
  if (!size_id) size_id = 1;
  if (!Array.isArray(toppings) && toppings) toppings = [toppings];

  const insertCartSql = `INSERT INTO cart (table_id, food_id, size_id, note) VALUES (?, ?, ?, ?)`;

  db.run(
    insertCartSql,
    [table_id, food_id, size_id, note || ""],
    function (err) {
      if (err) {
        console.error("INSERT cart error:", err.message);
        return res.status(500).send("DB Error");
      }

      const cartId = this.lastID;
      if (toppings && toppings.length > 0) {
        const sqlT = `INSERT INTO cart_toppings (cart_id, topping_id, price, quantity) VALUES (?, ?, ?, ?)`;
        toppings.forEach((tp) => {
          const qty = parseInt(req.body[`topping_qty_${tp}`]) || 1;
          db.get("SELECT topping_price FROM toppings WHERE topping_id = ?", [tp], (err2, row) => {
            if (!err2 && row) {
              db.run(sqlT, [cartId, tp, row.topping_price, qty]);
            }
          });
        });
      }

      res.redirect(`/menu/${table_id}`);
    }
  );
});

// ===================== DELETE CART ITEM =====================
app.post("/cart/delete/:id/:table_id", (req, res) => {
  const { id, table_id } = req.params;
  db.run(`DELETE FROM cart WHERE cart_id = ?`, [id], function (err) {
    if (err) {
      console.error("DELETE cart error:", err.message);
      return res.status(500).send("DB Error");
    }
    res.redirect(`/cart/${table_id}`);
  });
});

// ===================== ORDER HISTORY =====================
app.get("/history/:table_id", (req, res) => {
  const tableId = req.params.table_id;

  const sqlOrders = `
    SELECT 
      o.order_id, o.table_id, o.status
    FROM orders o
    WHERE o.table_id = ? AND o.status IN ('pending','done')
    ORDER BY o.order_id DESC
    `;

  db.all(sqlOrders, [tableId], (err, orders) => {
    if (err) {
      console.error("HISTORY orders SQL error:", err.message);
      return res.status(500).send("DB Error");
    }

    if (orders.length === 0) {
      return res.render("history", { table_id: tableId, orders: [] });
    }

    const orderIds = orders.map(o => o.order_id);
    const placeholders = orderIds.map(() => "?").join(",");

    // 2) รายการแต่ละออเดอร์ 
    const sqlItems = `
  SELECT 
    oi.order_id, oi.order_item_id,
    f.food_name, s.size_name,
    oi.note,
    GROUP_CONCAT(DISTINCT t.topping_name) AS toppings
  FROM order_items oi
  JOIN food f ON oi.food_id = f.food_id
  LEFT JOIN sizes s ON oi.size_id = s.size_id
  LEFT JOIN order_item_toppings oit ON oi.order_item_id = oit.order_item_id
  LEFT JOIN toppings t ON oit.topping_id = t.topping_id
  WHERE oi.order_id IN (${placeholders})
  GROUP BY oi.order_item_id
  ORDER BY oi.order_id DESC, oi.order_item_id
`;

    db.all(sqlItems, orderIds, (err2, items) => {
      if (err2) {
        console.error("HISTORY items SQL error:", err2.message);
        return res.status(500).send("DB Error");
      }

      const byOrder = {};
      items.forEach(r => {
        if (!byOrder[r.order_id]) byOrder[r.order_id] = [];
        byOrder[r.order_id].push({
          food_name: r.food_name,
          size_name: r.size_name,
          note: r.note,
          price: r.price,
          toppings: r.toppings ? r.toppings.split(",").map(s => s.trim()).filter(Boolean) : []
        });
      });

      const payload = orders.map(o => ({
        ...o,
        items: byOrder[o.order_id] || []
      }));

      res.render("history", { table_id: tableId, orders: payload });
    });
  });
});


// ===================== EDIT CART ITEM =====================
app.post("/cart/edit/:cart_id", (req, res) => {
  const { cart_id } = req.params;
  const { table_id, food_id, note } = req.body;
  let { size_id } = req.body;
  let toppings = req.body.toppings;

  // ถ้าไม่ได้เลือก size → default = 1
  if (!size_id) size_id = 1;
  if (!Array.isArray(toppings) && toppings) toppings = [toppings];

  db.run(
    `UPDATE cart SET food_id=?, size_id=?, note=? WHERE cart_id=?`,
    [food_id, size_id, note || "", cart_id],
    function (err) {
      if (err) {
        console.error("UPDATE cart error:", err.message);
        return res.status(500).send("DB Error");
      }

      db.run(`DELETE FROM cart_toppings WHERE cart_id=?`, [cart_id], (err2) => {
        if (err2) {
          console.error("DELETE cart_toppings error:", err2.message);
          return res.status(500).send("DB Error");
        }

        if (toppings && toppings.length > 0) {
          const sqlT = `INSERT INTO cart_toppings (cart_id, topping_id, price, quantity) VALUES (?, ?, ?, ?)`;
          toppings.forEach((tp) => {
            const qty = parseInt(req.body[`topping_qty_${tp}`]) || 1;
            db.get("SELECT topping_price FROM toppings WHERE topping_id = ?", [tp], (err3, row) => {
              if (!err3 && row) {
                db.run(sqlT, [cart_id, tp, row.topping_price, qty]);
            }
          });
        });
      }


        res.redirect(`/cart/${table_id}`);
      });
    }
  );
});

// ===================== VIEW CART =====================
app.get("/cart/:table_id", (req, res) => {
  const { table_id } = req.params;
  const sql = `
    SELECT c.cart_id, f.food_id, f.food_name, f.food_price, c.note, c.size_id,
           s.size_name, s.extra_price AS size_extra,
           t.topping_name, ct.price AS topping_price, 
           ct.quantity AS topping_qty

    FROM cart c
    JOIN food f ON c.food_id = f.food_id
    LEFT JOIN sizes s ON c.size_id = s.size_id
    LEFT JOIN cart_toppings ct ON c.cart_id = ct.cart_id
    LEFT JOIN toppings t ON ct.topping_id = t.topping_id
    WHERE c.table_id = ?
    ORDER BY c.cart_id;
  `;

  db.all(sql, [table_id], (err, rows) => {
    if (err) {
      console.error("cart view sql error:", err.message);
      return res.status(500).send("DB Error");
    }

    const cart = [];
    const map = {};
    rows.forEach((r) => {
      if (!map[r.cart_id]) {
        map[r.cart_id] = {
          cart_id: r.cart_id,
          food_id: r.food_id,
          food_name: r.food_name,
          food_price: r.food_price,
          note: r.note,
          size_id: r.size_id,
          size_name: r.size_name,
          size_extra: r.size_extra,
          toppings: [],
        };
        cart.push(map[r.cart_id]);
      }
      if (r.topping_name) {
        map[r.cart_id].toppings.push({
          name: r.topping_name,
          price: r.topping_price,
          qty: r.topping_qty || 1
        });

      }
    });

    res.render("cart", { cart, table_id });
  });
});

// ===================== CUSTOMIZE =====================
app.get("/customize/:food_id/:table_id", (req, res) => {
  const { food_id, table_id } = req.params;
  const { cart_id } = req.query;

  const sqlFood = "SELECT * FROM food WHERE food_id = ?";

  db.get(sqlFood, [food_id], (err, foodRow) => {
    if (err || !foodRow) return res.status(500).send("DB Error");

    // ดึง topping ทั้งหมด + topping ที่เลือกได้สำหรับ food นี้
    const sqlAllToppings = "SELECT * FROM toppings ORDER BY topping_name";
    const sqlAllowedToppings = `
      SELECT topping_id FROM food_toppings WHERE food_id = ?
    `;
    const sqlSizes = `
      SELECT s.size_id, s.size_name, s.extra_price
      FROM food_sizes fs
      JOIN sizes s ON fs.size_id = s.size_id
      WHERE fs.food_id = ?
    `;

    const allPromise = new Promise((resolve, reject) =>
      db.all(sqlAllToppings, [], (e, r) => (e ? reject(e) : resolve(r)))
    );
    const allowedPromise = new Promise((resolve, reject) =>
      db.all(sqlAllowedToppings, [food_id], (e, r) => (e ? reject(e) : resolve(r.map(x => x.topping_id))))
    );
    const sizePromise = new Promise((resolve, reject) =>
      db.all(sqlSizes, [food_id], (e, r) => (e ? reject(e) : resolve(r)))
    );

    // ถ้ามี cart_id ดึงข้อมูลเดิม
    const cartPromise = new Promise((resolve) => {
      if (!cart_id) return resolve(null);
      const sql = `
        SELECT c.note, c.size_id,
               ct.topping_id, ct.quantity
        FROM cart c
        LEFT JOIN cart_toppings ct ON c.cart_id = ct.cart_id
        WHERE c.cart_id = ?
      `;
      db.all(sql, [cart_id], (err, rows) => {
        if (err || !rows.length) return resolve(null);
        const note = rows[0].note;
        const size_id = rows[0].size_id;
        const toppings = rows
          .filter(r => r.topping_id)
          .map(r => ({ id: r.topping_id, qty: r.quantity || 1 }));
        resolve({ note, size_id, toppings });
      });
    });

    Promise.all([allPromise, allowedPromise, sizePromise, cartPromise])
      .then(([allToppings, allowedToppings, sizeRows, cartData]) => {
        res.render("customize", {
          food: foodRow,
          toppings: allToppings,
          allowedToppings,
          sizes: sizeRows,
          table_id,
          cart_id: cart_id || null,
          selectedSize: cartData ? cartData.size_id : null,
          selectedToppings: cartData ? cartData.toppings : [],
          note: cartData ? cartData.note : ""
        });
      })
      .catch((e) => {
        console.error("Customize route error:", e.message);
        res.status(500).send("DB Error");
      });
  });
});

// ===================== CONFIRM ORDER =====================
app.post("/order/:table_id", (req, res) => {
  const { table_id } = req.params;

  // ดึงข้อมูลจาก cart ของโต๊ะนั้น
  const sqlCart = `
    SELECT c.cart_id, c.food_id, c.size_id, c.note,
           ct.topping_id, ct.price as topping_price,
           f.food_price
    FROM cart c
    JOIN food f ON c.food_id = f.food_id
    LEFT JOIN cart_toppings ct ON c.cart_id = ct.cart_id
    WHERE c.table_id = ?
  `;

  db.all(sqlCart, [table_id], (err, cartRows) => {
    if (err) {
      console.error("order sqlCart error:", err.message);
      return res.status(500).send("DB Error");
    }
    if (cartRows.length === 0) {
      return res.redirect(`/cart/${table_id}`);
    }

    // 1) insert ลง orders
    const sqlOrder = `INSERT INTO orders (table_id, status) VALUES (?, 'pending')`;
    db.run(sqlOrder, [table_id], function (err2) {
      if (err2) {
        console.error("INSERT orders error:", err2.message);
        return res.status(500).send("DB Error");
      }
      const orderId = this.lastID;

      // จัดกลุ่มตาม cart_id
      const grouped = {};
      cartRows.forEach(r => {
        if (!grouped[r.cart_id]) {
          grouped[r.cart_id] = {
            food_id: r.food_id,
            size_id: r.size_id,
            note: r.note,
            price: r.food_price,
            toppings: []
          };
        }
        if (r.topping_id) {
          grouped[r.cart_id].toppings.push({
            topping_id: r.topping_id,
            price: r.topping_price
          });
        }
      });

      // 2) insert ลง order_items และ toppings
      const sqlItem = `INSERT INTO order_items (order_id, food_id, size_id, note)
                 VALUES (?, ?, ?, ?)`;  
      const sqlItemTopping = `INSERT INTO order_item_toppings (order_item_id, topping_id, price)
                              VALUES (?, ?, ?)`;

      Object.values(grouped).forEach(item => {
        db.run(sqlItem, [orderId, item.food_id, item.size_id || 1, item.note || ""],
          function (err3) {
            if (err3) return console.error("INSERT order_items error:", err3.message);
            const orderItemId = this.lastID;

            item.toppings.forEach(tp => {
              db.run(
                `INSERT INTO order_item_toppings (order_item_id, topping_id, price)
                VALUES (?, ?, ?)`,
                [orderItemId, tp.topping_id, tp.price],
                (err4) => {
                  if (err4) console.error("INSERT order_item_toppings error:", err4.message);
                }
              );
            });
          });
      });

      // 3) ล้างตะกร้า
      db.run(`DELETE FROM cart WHERE table_id=?`, [table_id], (err5) => {
        if (err5) console.error("DELETE cart error:", err5.message);
        res.redirect(`/menu/${table_id}`);
      });
    });
  });
});

// ===================== KITCHEN VIEW =====================
app.get("/kitchen", (req, res) => {
  const sql = `
    SELECT 
      o.order_id, o.table_id, o.status,
      oi.order_item_id,
      oi.note,
      f.food_name, s.size_name,
      GROUP_CONCAT(DISTINCT t.topping_name) AS toppings
    FROM orders o
    JOIN order_items oi ON o.order_id = oi.order_id
    JOIN food f ON oi.food_id = f.food_id
    LEFT JOIN sizes s ON oi.size_id = s.size_id
    LEFT JOIN order_item_toppings oit ON oi.order_item_id = oit.order_item_id
    LEFT JOIN toppings t ON oit.topping_id = t.topping_id
    WHERE o.status = 'pending'
    GROUP BY oi.order_item_id
    ORDER BY o.order_id DESC, oi.order_item_id
  `;


  db.all(sql, [], (err, rows) => {
    if (err) {
      console.error("KITCHEN SQL error:", err.message);
      return res.status(500).send("DB Error");
    }

    const map = {};
    const orders = [];
    rows.forEach(r => {
      if (!map[r.order_item_id]) {
        const foodStr = `${r.food_name}${r.size_name ? " (" + r.size_name + ")" : ""}`;
        map[r.order_item_id] = {
          order_id: r.order_id,
          table_id: r.table_id,
          status: r.status,
          note: r.note,
          food: foodStr,
          toppings: r.toppings ? r.toppings.split(", ").filter(Boolean) : []
        };
        orders.push(map[r.order_item_id]);
      }
    });

    res.render("kitchen", { data: orders });
  });
});

app.get("/update-status", (req, res) => {
  const { order_id } = req.query;
  if (!order_id) return res.status(400).send("Missing order_id");

  db.run(`UPDATE orders SET status = 'done' WHERE order_id = ?`, [order_id], function(err) {
    if (err) {
      console.error("UPDATE status error:", err.message);
      return res.status(500).send("DB Error");
    }
    res.redirect("/kitchen");  // กลับไปหน้า kitchen
  });
});

// ===================== DELETE ORDER =====================
app.get("/delete-order", (req, res) => {
  const { order_id } = req.query;

  // ลบ order_item_toppings ก่อน
  const deleteItemToppings = `
    DELETE FROM order_item_toppings 
    WHERE order_item_id IN (SELECT order_item_id FROM order_items WHERE order_id = ?)
  `;
  db.run(deleteItemToppings, [order_id], function (err) {
    if (err) {
      console.error("DELETE order_item_toppings error:", err.message);
      return res.status(500).send("DB Error");
    }

    // ลบ order_items
    const deleteItems = `DELETE FROM order_items WHERE order_id = ?`;
    db.run(deleteItems, [order_id], function (err2) {
      if (err2) {
        console.error("DELETE order_items error:", err2.message);
        return res.status(500).send("DB Error");
      }

      // ลบ orders
      const deleteOrder = `DELETE FROM orders WHERE order_id = ?`;
      db.run(deleteOrder, [order_id], function (err3) {
        if (err3) {
          console.error("DELETE orders error:", err3.message);
          return res.status(500).send("DB Error");
        }

        res.redirect("/kitchen");
      });
    });
  });
});

// ===================== CASHIER =====================
app.get('/cashier', (req, res) => {
    const query = 'SELECT table_id FROM table_store ';
    db.all(query, (err, rows) => {
        if (err) {
            console.log(err.message);
        }
        console.log(rows);
        res.render('cashier',{data : rows})    
    });
});

app.get('/cashier-table/:id', (req, res) => {
  const tableId = req.params.id; 
  console.log("Table:", tableId);

  const query = `
    SELECT 
      o.order_id, o.table_id, o.status
    FROM orders o
    WHERE o.table_id = ? AND o.status IN ('pending','done')
    ORDER BY o.order_id DESC
  `;

  db.all(query, [tableId], (err, rows) => {
    if (err) {
      console.error("Orders query error:", err.message);
      return res.status(500).send("DB Error");
    }

    if (rows.length === 0) {
      return res.render("cashier-table", { table_id: tableId, rows: [] });
    }

    const orderIds = rows.map(o => o.order_id);
    const placeholders = orderIds.map(() => "?").join(",");

    const sqlItems = `
      SELECT 
        oi.order_id, oi.order_item_id, oi.note,
        f.food_name, f.food_price,
        s.size_name, s.extra_price,
        t.topping_name, oit.quantity as topping_qty, t.topping_price
      FROM order_items oi
      JOIN food f ON oi.food_id = f.food_id
      LEFT JOIN sizes s ON oi.size_id = s.size_id
      LEFT JOIN order_item_toppings oit ON oi.order_item_id = oit.order_item_id
      LEFT JOIN toppings t ON oit.topping_id = t.topping_id
      WHERE oi.order_id IN (${placeholders})
      ORDER BY oi.order_id DESC, oi.order_item_id
    `;

    db.all(sqlItems, orderIds, (err2, items) => {
      if (err2) {
        console.error("Items query error:", err2.message);
        return res.status(500).send("DB Error");
      }

      const byOrder = {};
      items.forEach(r => {
        if (!byOrder[r.order_id]) byOrder[r.order_id] = [];

        // คำนวณราคา
        const basePrice = r.food_price + (r.extra_price || 0);
        const toppingPrice = r.topping_price ? (r.topping_price * (r.topping_qty || 1)) : 0;

        byOrder[r.order_id].push({
          food_name: r.food_name,
          size_name: r.size_name,
          note: r.note,
          price: basePrice + toppingPrice,
          toppings: r.topping_name ? [`${r.topping_name} x${r.topping_qty || 1}`] : []
        });
      });

      const payload = rows.map(o => ({
        ...o,
        items: byOrder[o.order_id] || [],
        total: (byOrder[o.order_id] || []).reduce((sum, i) => sum + i.price, 0)
      }));

      res.render("cashier-table", { table_id: tableId, rows: payload });
    });
  });
});

app.post("/payment/:table_id", (req, res) => {
  const tableId = req.params.table_id;

  // 1) เลือก order ที่ยังไม่จ่าย (pending/done)
  const sqlOrders = `
    SELECT order_id FROM orders 
    WHERE table_id = ? AND status IN ('pending','done')
  `;
  db.all(sqlOrders, [tableId], (err, orders) => {
    if (err) {
      console.error("Select orders error:", err.message);
      return res.status(500).send("DB Error");
    }
    if (orders.length === 0) {
      return res.redirect("/cashier");
    }
    
    const orderIds = orders.map(o => o.order_id);
    const placeholders = orderIds.map(() => "?").join(",");

    // 2) คำนวณยอดรวม
    const sqlTotal = `
      SELECT SUM(f.food_price + IFNULL(s.extra_price,0) + IFNULL(t.topping_price * oit.quantity,0)) AS total
      FROM order_items oi
      JOIN food f ON oi.food_id = f.food_id
      LEFT JOIN sizes s ON oi.size_id = s.size_id
      LEFT JOIN order_item_toppings oit ON oi.order_item_id = oit.order_item_id
      LEFT JOIN toppings t ON oit.topping_id = t.topping_id
      WHERE oi.order_id IN (${placeholders})
    `;

    db.get(sqlTotal, orderIds, (err2, row) => {
      if (err2) {
        console.error("Total calc error:", err2.message);
        return res.status(500).send("DB Error");
      }

      const amount = row.total || 0;

      // 3) อัปเดต orders -> completed
      db.run(
        `UPDATE orders SET status='completed' WHERE order_id IN (${placeholders})`,
        orderIds,
        function (err3) {
          if (err3) {
            console.error("Update orders error:", err3.message);
            return res.status(500).send("DB Error");
          }

          // 4) Insert payment (เก็บ order แรกเป็น ref)
          const orderId = orderIds[0];
          db.run(
            `INSERT INTO payments (order_id, method, amount) VALUES (?, 'cash', ?)`,
            [orderId, amount],
            function (err4) {
              if (err4) {
                console.error("Insert payment error:", err4.message);
                return res.status(500).send("DB Error");
              }

              res.render("payment-complete", { table_id: tableId, amount });
            }
          );
        }
      );
    });
  });
});

// ===================== DELETE ORDER (สำหรับ Cashier) =====================
app.get("/cashier-delete-order", (req, res) => {
  const { order_id, table_id } = req.query;

  // ลบ order_item_toppings ก่อน
  const deleteItemToppings = `
    DELETE FROM order_item_toppings 
    WHERE order_item_id IN (SELECT order_item_id FROM order_items WHERE order_id = ?)
  `;
  db.run(deleteItemToppings, [order_id], function (err) {
    if (err) {
      console.error("DELETE order_item_toppings error:", err.message);
      return res.status(500).send("DB Error");
    }

    // ลบ order_items
    const deleteItems = `DELETE FROM order_items WHERE order_id = ?`;
    db.run(deleteItems, [order_id], function (err2) {
      if (err2) {
        console.error("DELETE order_items error:", err2.message);
        return res.status(500).send("DB Error");
      }

      // ลบ orders
      const deleteOrder = `DELETE FROM orders WHERE order_id = ?`;
      db.run(deleteOrder, [order_id], function (err3) {
        if (err3) {
          console.error("DELETE orders error:", err3.message);
          return res.status(500).send("DB Error");
        }

        // กลับไปหน้า cashier-table ของโต๊ะเดิม
        res.redirect(`/cashier-table/${table_id}`);
      });
    });
  });
});

function getLocalIP() {
  const interfaces = os.networkInterfaces();
  for (let iface in interfaces) {
    for (let alias of interfaces[iface]) {
      if (alias.family === "IPv4" && !alias.internal) {
        return alias.address;
      }
    }
  }
  return "0.0.0.0";
}

app.listen(port, "0.0.0.0", () => {
  console.log(` Server running on:`);
  console.log(` - Local:   http://localhost:${port}`);
  console.log(` - Network: http://${getLocalIP()}:${port}`);
});