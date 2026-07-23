const express = require('express');
const cors = require('cors');
const sqlite3 = require('sqlite3').verbose();
const app = express();
const PORT = 3000;

// Middleware
app.use(cors());
app.use(express.json({ limit: '50mb' }));

// Servir archivos estáticos (HTML, CSS, JS)
app.use(express.static(__dirname));

// Inicializar base de datos SQLite con sqlite3
const db = new sqlite3.Database('./supermercado.db', (err) => {
  if (err) {
    console.error('❌ Error abriendo base de datos:', err.message);
  } else {
    console.log('✅ Conectado a la base de datos SQLite');
  }
});

// ================================================================
//  CREAR TABLAS (migración automática)
// ================================================================
db.serialize(() => {
  db.run(`
    CREATE TABLE IF NOT EXISTS productos (
      id INTEGER PRIMARY KEY,
      codigo TEXT,
      codigo_barras TEXT,
      nombre TEXT,
      categoria TEXT,
      precio_final REAL,
      stock REAL,
      tipo_venta TEXT,
      costo_s_iva REAL,
      tipo_iva INTEGER,
      precio_s_iva REAL,
      stock_disponible REAL,
      stock_minimo REAL,
      marca TEXT,
      ubicacion TEXT,
      seccion TEXT,
      activo INTEGER DEFAULT 1,
      metodo_precio TEXT,
      porcentaje_ganancia REAL
    )
  `);
  db.run(`
    CREATE TABLE IF NOT EXISTS ventas (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      fecha TEXT,
      timestamp INTEGER,
      total REAL,
      medio_pago TEXT,
      cliente_id INTEGER,
      cliente_nombre TEXT,
      cajero TEXT,
      tarjeta_tipo TEXT,
      tarjeta_numero TEXT,
      tarjeta_cuotas INTEGER,
      items TEXT
    )
  `);
  db.run(`
    CREATE TABLE IF NOT EXISTS movimientos_stock (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      fecha TEXT,
      producto_id INTEGER,
      nombre TEXT,
      tipo TEXT,
      cantidad REAL,
      stock_anterior REAL,
      stock_nuevo REAL,
      usuario TEXT,
      venta_id INTEGER
    )
  `);
  db.run(`
    CREATE TABLE IF NOT EXISTS caja (
      id INTEGER PRIMARY KEY,
      estado TEXT,
      monto_inicial REAL,
      total_efectivo REAL,
      total_tarjeta REAL,
      total_mp REAL,
      total_ctacte REAL,
      fecha_apertura TEXT,
      hora_apertura TEXT,
      fecha_cierre TEXT,
      hora_cierre TEXT,
      total_cierre REAL
    )
  `);
  db.run(`
    CREATE TABLE IF NOT EXISTS compras (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      fecha TEXT,
      proveedor TEXT,
      total REAL,
      items TEXT
    )
  `);
  db.run(`
    CREATE TABLE IF NOT EXISTS proveedores (
      id INTEGER PRIMARY KEY,
      nombre TEXT,
      cuit TEXT,
      telefono TEXT
    )
  `);
  db.run(`
    CREATE TABLE IF NOT EXISTS clientes (
      id INTEGER PRIMARY KEY,
      nombre TEXT,
      cuit TEXT,
      saldo REAL
    )
  `);
  db.run(`
    CREATE TABLE IF NOT EXISTS logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      fecha TEXT,
      usuario TEXT,
      accion TEXT,
      detalle TEXT
    )
  `);
  db.run(`
    CREATE TABLE IF NOT EXISTS sync_queue (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      device_id TEXT,
      tipo TEXT,
      data TEXT,
      intentos INTEGER DEFAULT 0,
      creado_en TEXT,
      sincronizado INTEGER DEFAULT 0
    )
  `);
  console.log('✅ Tablas creadas/verificadas');
});

// ================================================================
//  FUNCIONES AUXILIARES (adaptadas para sqlite3 con callbacks)
// ================================================================
function getProductos(offset = 0, limit = 200, filtro = '', rubro = '', callback) {
  let query = 'SELECT * FROM productos WHERE 1=1';
  const params = [];
  if (filtro) {
    query += ' AND (nombre LIKE ? OR codigo_barras LIKE ? OR codigo LIKE ?)';
    const f = `%${filtro}%`;
    params.push(f, f, f);
  }
  if (rubro) {
    query += ' AND categoria = ?';
    params.push(rubro);
  }
  query += ' LIMIT ? OFFSET ?';
  params.push(limit, offset);
  db.all(query, params, (err, rows) => {
    if (err) return callback(err);
    callback(null, rows);
  });
}

function getTotalProductos(filtro = '', rubro = '', callback) {
  let query = 'SELECT COUNT(*) as total FROM productos WHERE 1=1';
  const params = [];
  if (filtro) {
    query += ' AND (nombre LIKE ? OR codigo_barras LIKE ? OR codigo LIKE ?)';
    const f = `%${filtro}%`;
    params.push(f, f, f);
  }
  if (rubro) {
    query += ' AND categoria = ?';
    params.push(rubro);
  }
  db.get(query, params, (err, row) => {
    if (err) return callback(err);
    callback(null, row ? row.total : 0);
  });
}

// ================================================================
//  ENDPOINTS
// ================================================================

app.get('/api/status', (req, res) => {
  res.json({ status: 'ok', timestamp: Date.now() });
});

app.get('/api/productos', (req, res) => {
  const offset = parseInt(req.query.offset) || 0;
  const limit = Math.min(parseInt(req.query.limit) || 200, 500);
  const filtro = req.query.filtro || '';
  const rubro = req.query.rubro || '';
  
  getProductos(offset, limit, filtro, rubro, (err, data) => {
    if (err) return res.status(500).json({ error: err.message });
    getTotalProductos(filtro, rubro, (err2, total) => {
      if (err2) return res.status(500).json({ error: err2.message });
      res.json({ data, total, offset, limit });
    });
  });
});

app.post('/api/ventas', (req, res) => {
  const { venta, items, device_id } = req.body;
  
  db.serialize(() => {
    db.run('BEGIN TRANSACTION');
    
    const insertVenta = db.prepare(`
      INSERT INTO ventas (fecha, timestamp, total, medio_pago, cliente_id, cliente_nombre, cajero, tarjeta_tipo, tarjeta_numero, tarjeta_cuotas, items)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const insertStock = db.prepare(`
      INSERT INTO movimientos_stock (fecha, producto_id, nombre, tipo, cantidad, stock_anterior, stock_nuevo, usuario, venta_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const updateProducto = db.prepare(`
      UPDATE productos SET stock = ? WHERE id = ?
    `);
    const getStock = db.prepare('SELECT stock FROM productos WHERE id = ?');
    const getCaja = db.prepare('SELECT * FROM caja WHERE id = 1');
    const updateCaja = db.prepare(`
      UPDATE caja SET ${venta.medio_pago === 'efectivo' ? 'total_efectivo' :
                        venta.medio_pago === 'tarjeta' ? 'total_tarjeta' :
                        (venta.medio_pago === 'mercado pago' || venta.medio_pago === 'transferencia' || venta.medio_pago === 'otro') ? 'total_mp' : 'total_ctacte'} 
      = ${venta.medio_pago === 'efectivo' ? 'total_efectivo' :
          venta.medio_pago === 'tarjeta' ? 'total_tarjeta' :
          (venta.medio_pago === 'mercado pago' || venta.medio_pago === 'transferencia' || venta.medio_pago === 'otro') ? 'total_mp' : 'total_ctacte'} + ? WHERE id = 1
    `);

    let ventaId = null;
    try {
      // Insertar venta
      const info = insertVenta.run(
        venta.fecha,
        venta.timestamp,
        venta.total,
        venta.medio_pago,
        venta.cliente_id || null,
        venta.cliente_nombre || '',
        venta.cajero,
        venta.tarjeta?.tipo || null,
        venta.tarjeta?.numero || null,
        venta.tarjeta?.cuotas || null,
        JSON.stringify(items)
      );
      ventaId = info.lastInsertRowid;

      // Procesar items
      items.forEach(item => {
        const stockRow = getStock.get(item.producto_id);
        if (!stockRow) throw new Error(`Producto ${item.producto_id} no encontrado`);
        const stockAnterior = stockRow.stock;
        const stockNuevo = stockAnterior - item.cantidad;
        if (stockNuevo < 0) throw new Error(`Stock insuficiente para producto ${item.producto_id}`);
        updateProducto.run(stockNuevo, item.producto_id);
        insertStock.run(
          venta.fecha,
          item.producto_id,
          item.nombre,
          'venta',
          -item.cantidad,
          stockAnterior,
          stockNuevo,
          venta.cajero,
          ventaId
        );
      });

      // Actualizar caja
      const cajaRow = getCaja.get();
      if (cajaRow && cajaRow.estado === 'abierta') {
        updateCaja.run(venta.total);
      }

      db.run('COMMIT');
      res.json({ success: true, venta_id: ventaId });
    } catch (err) {
      db.run('ROLLBACK');
      console.error('❌ Error en venta:', err);
      res.status(500).json({ error: err.message });
    }
  });
});

app.get('/api/ventas', (req, res) => {
  const desde = req.query.desde || '1970-01-01';
  const hasta = req.query.hasta || '2099-12-31';
  const limit = Math.min(parseInt(req.query.limit) || 200, 1000);
  const offset = parseInt(req.query.offset) || 0;
  
  db.get('SELECT COUNT(*) as total FROM ventas WHERE fecha >= ? AND fecha <= ?', [desde, hasta], (err, totalRow) => {
    if (err) return res.status(500).json({ error: err.message });
    db.all('SELECT * FROM ventas WHERE fecha >= ? AND fecha <= ? ORDER BY timestamp DESC LIMIT ? OFFSET ?', [desde, hasta, limit, offset], (err, rows) => {
      if (err) return res.status(500).json({ error: err.message });
      res.json({ data: rows, total: totalRow ? totalRow.total : 0 });
    });
  });
});

app.get('/api/dashboard', (req, res) => {
  const hoy = new Date().toISOString().slice(0, 10);
  const semanaAtras = new Date();
  semanaAtras.setDate(semanaAtras.getDate() - 7);
  const semanaStr = semanaAtras.toISOString().slice(0, 10);
  const mesAtras = new Date();
  mesAtras.setDate(mesAtras.getDate() - 30);
  const mesStr = mesAtras.toISOString().slice(0, 10);

  db.get('SELECT SUM(total) as total FROM ventas WHERE fecha = ?', [hoy], (err, ventasHoy) => {
    if (err) return res.status(500).json({ error: err.message });
    db.get('SELECT SUM(total) as total FROM ventas WHERE fecha >= ?', [semanaStr], (err, ventasSemana) => {
      if (err) return res.status(500).json({ error: err.message });
      db.get('SELECT SUM(total) as total FROM ventas WHERE fecha >= ?', [mesStr], (err, ventasMes) => {
        if (err) return res.status(500).json({ error: err.message });
        db.get('SELECT COUNT(*) as total FROM productos', (err, totalProductos) => {
          if (err) return res.status(500).json({ error: err.message });
          db.get('SELECT COUNT(*) as total FROM productos WHERE stock < 5', (err, stockBajo) => {
            if (err) return res.status(500).json({ error: err.message });
            db.get('SELECT * FROM caja WHERE id = 1', (err, caja) => {
              if (err) return res.status(500).json({ error: err.message });
              res.json({
                ganancia_hoy: ventasHoy ? ventasHoy.total : 0,
                ganancia_semana: ventasSemana ? ventasSemana.total : 0,
                ganancia_mes: ventasMes ? ventasMes.total : 0,
                total_productos: totalProductos ? totalProductos.total : 0,
                stock_bajo: stockBajo ? stockBajo.total : 0,
                caja_estado: caja ? caja.estado : 'cerrada',
                caja_efectivo: caja ? caja.total_efectivo : 0,
                caja_tarjeta: caja ? caja.total_tarjeta : 0,
                caja_mp: caja ? caja.total_mp : 0,
                caja_ctacte: caja ? caja.total_ctacte : 0
              });
            });
          });
        });
      });
    });
  });
});

app.post('/api/caja/abrir', (req, res) => {
  const { monto_inicial } = req.body;
  db.get('SELECT * FROM caja WHERE id = 1', (err, caja) => {
    if (err) return res.status(500).json({ error: err.message });
    if (caja && caja.estado === 'abierta') {
      return res.status(400).json({ error: 'Ya hay una caja abierta' });
    }
    db.run(`
      INSERT OR REPLACE INTO caja (id, estado, monto_inicial, total_efectivo, total_tarjeta, total_mp, total_ctacte, fecha_apertura, hora_apertura)
      VALUES (1, 'abierta', ?, ?, 0, 0, 0, ?, ?)
    `, [monto_inicial, monto_inicial, new Date().toISOString().slice(0,10), new Date().toLocaleTimeString()], (err) => {
      if (err) return res.status(500).json({ error: err.message });
      res.json({ success: true });
    });
  });
});

app.post('/api/caja/cerrar', (req, res) => {
  db.get('SELECT * FROM caja WHERE id = 1', (err, caja) => {
    if (err) return res.status(500).json({ error: err.message });
    if (!caja || caja.estado !== 'abierta') {
      return res.status(400).json({ error: 'No hay caja abierta' });
    }
    const total = caja.total_efectivo + caja.total_tarjeta + caja.total_mp + caja.total_ctacte;
    db.run(`
      UPDATE caja SET estado = 'cerrada', fecha_cierre = ?, hora_cierre = ?, total_cierre = ? WHERE id = 1
    `, [new Date().toISOString().slice(0,10), new Date().toLocaleTimeString(), total], (err) => {
      if (err) return res.status(500).json({ error: err.message });
      res.json({ success: true, total });
    });
  });
});

app.get('/api/proveedores', (req, res) => {
  db.all('SELECT * FROM proveedores', (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows);
  });
});

app.post('/api/proveedores', (req, res) => {
  const { nombre, cuit, telefono } = req.body;
  db.run('INSERT INTO proveedores (nombre, cuit, telefono) VALUES (?, ?, ?)', [nombre, cuit, telefono], function(err) {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ success: true, id: this.lastID });
  });
});

app.post('/api/compras', (req, res) => {
  const { fecha, proveedor, total, items } = req.body;
  db.serialize(() => {
    db.run('BEGIN TRANSACTION');
    const insertCompra = db.prepare('INSERT INTO compras (fecha, proveedor, total, items) VALUES (?, ?, ?, ?)');
    const updateStock = db.prepare('UPDATE productos SET stock = ? WHERE id = ?');
    const getStock = db.prepare('SELECT stock FROM productos WHERE id = ?');
    const insertStockMov = db.prepare(`
      INSERT INTO movimientos_stock (fecha, producto_id, nombre, tipo, cantidad, stock_anterior, stock_nuevo, usuario)
      VALUES (?, ?, ?, 'compra', ?, ?, ?, ?)
    `);
    try {
      const info = insertCompra.run(fecha, proveedor, total, JSON.stringify(items));
      items.forEach(item => {
        if (item.producto_id) {
          const stockRow = getStock.get(item.producto_id);
          if (stockRow) {
            const stockAnterior = stockRow.stock;
            const nuevoStock = stockAnterior + item.cantidad;
            updateStock.run(nuevoStock, item.producto_id);
            insertStockMov.run(fecha, item.producto_id, item.nombre, item.cantidad, stockAnterior, nuevoStock, 'Sistema');
          }
        }
      });
      db.run('COMMIT');
      res.json({ success: true, id: info.lastInsertRowid });
    } catch (err) {
      db.run('ROLLBACK');
      console.error('❌ Error en compra:', err);
      res.status(500).json({ error: err.message });
    }
  });
});

app.get('/api/compras', (req, res) => {
  db.all('SELECT * FROM compras ORDER BY fecha DESC LIMIT 200', (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows);
  });
});

app.get('/api/movimientos_stock', (req, res) => {
  db.all('SELECT * FROM movimientos_stock ORDER BY fecha DESC LIMIT 100', (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows);
  });
});

app.post('/api/logs', (req, res) => {
  const { usuario, accion, detalle } = req.body;
  db.run('INSERT INTO logs (fecha, usuario, accion, detalle) VALUES (?, ?, ?, ?)', 
    [new Date().toISOString(), usuario, accion, detalle], (err) => {
      if (err) return res.status(500).json({ error: err.message });
      res.json({ success: true });
    });
});

app.get('/api/logs', (req, res) => {
  db.all('SELECT * FROM logs ORDER BY fecha DESC LIMIT 100', (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows);
  });
});

app.post('/api/productos/sync', (req, res) => {
  const { productos } = req.body;
  db.serialize(() => {
    db.run('BEGIN TRANSACTION');
    const insert = db.prepare(`
      INSERT OR REPLACE INTO productos (id, codigo, codigo_barras, nombre, categoria, precio_final, stock, tipo_venta, costo_s_iva, tipo_iva, precio_s_iva, stock_disponible, stock_minimo, marca, ubicacion, seccion, activo, metodo_precio, porcentaje_ganancia)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    try {
      productos.forEach(p => {
        insert.run(
          p.id, p.codigo, p.codigo_barras, p.nombre, p.categoria,
          p.precio_final, p.stock, p.tipo_venta, p.costo_s_iva, p.tipo_iva,
          p.precio_s_iva, p.stock_disponible, p.stock_minimo, p.marca,
          p.ubicacion, p.seccion, p.activo, p.metodo_precio, p.porcentaje_ganancia
        );
      });
      db.run('COMMIT');
      res.json({ success: true, count: productos.length });
    } catch (err) {
      db.run('ROLLBACK');
      res.status(500).json({ error: err.message });
    }
  });
});

// Iniciar servidor
app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Servidor corriendo en http://localhost:${PORT}`);
  console.log(`📡 Accesible desde otros dispositivos en tu red usando la IP local`);
});