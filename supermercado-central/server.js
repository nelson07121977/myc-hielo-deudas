const express = require('express');
const cors = require('cors');
const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.static(__dirname));

// ================================================================
//  CONFIGURACIÓN DE LA BASE DE DATOS
// ================================================================
// Crear la carpeta 'data' si no existe (para persistencia)
const dataDir = path.join(__dirname, 'data');
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
  console.log('📁 Carpeta data creada');
}

// Ruta de la base de datos dentro de la carpeta data
const dbPath = path.join(dataDir, 'supermercado.db');
console.log(`📂 Base de datos en: ${dbPath}`);

// Inicializar base de datos
let db;
try {
  db = new Database(dbPath);
  console.log('✅ Conectado a la base de datos SQLite');
} catch (err) {
  console.error('❌ Error al conectar a la base de datos:', err.message);
  process.exit(1);
}

// ================================================================
//  CREAR TABLAS (migración automática)
// ================================================================
try {
  db.exec(`
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
    );

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
    );

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
    );

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
    );

    CREATE TABLE IF NOT EXISTS compras (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      fecha TEXT,
      proveedor TEXT,
      total REAL,
      items TEXT
    );

    CREATE TABLE IF NOT EXISTS proveedores (
      id INTEGER PRIMARY KEY,
      nombre TEXT,
      cuit TEXT,
      telefono TEXT
    );

    CREATE TABLE IF NOT EXISTS clientes (
      id INTEGER PRIMARY KEY,
      nombre TEXT,
      cuit TEXT,
      saldo REAL
    );

    CREATE TABLE IF NOT EXISTS logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      fecha TEXT,
      usuario TEXT,
      accion TEXT,
      detalle TEXT
    );

    CREATE TABLE IF NOT EXISTS sync_queue (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      device_id TEXT,
      tipo TEXT,
      data TEXT,
      intentos INTEGER DEFAULT 0,
      creado_en TEXT,
      sincronizado INTEGER DEFAULT 0
    );
  `);
  console.log('✅ Tablas creadas/verificadas correctamente');
} catch (err) {
  console.error('❌ Error al crear tablas:', err.message);
  process.exit(1);
}

// ================================================================
//  FUNCIONES AUXILIARES
// ================================================================
function getProductos(offset = 0, limit = 200, filtro = '', rubro = '') {
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
  const stmt = db.prepare(query);
  return stmt.all(...params);
}

function getTotalProductos(filtro = '', rubro = '') {
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
  const stmt = db.prepare(query);
  return stmt.get(...params).total;
}

// ================================================================
//  ENDPOINTS
// ================================================================

app.get('/api/status', (req, res) => {
  res.json({ status: 'ok', timestamp: Date.now() });
});

app.get('/api/productos', (req, res) => {
  try {
    const offset = parseInt(req.query.offset) || 0;
    const limit = Math.min(parseInt(req.query.limit) || 200, 500);
    const filtro = req.query.filtro || '';
    const rubro = req.query.rubro || '';
    const data = getProductos(offset, limit, filtro, rubro);
    const total = getTotalProductos(filtro, rubro);
    res.json({ data, total, offset, limit });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/ventas', (req, res) => {
  const { venta, items, device_id } = req.body;
  try {
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

    const result = db.transaction(() => {
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
      const ventaId = info.lastInsertRowid;

      items.forEach(item => {
        const prod = db.prepare('SELECT stock FROM productos WHERE id = ?').get(item.producto_id);
        if (!prod) throw new Error(`Producto ${item.producto_id} no encontrado`);
        const stockAnterior = prod.stock;
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

      const caja = db.prepare('SELECT * FROM caja WHERE id = 1').get();
      if (caja && caja.estado === 'abierta') {
        const campo = venta.medio_pago === 'efectivo' ? 'total_efectivo' :
                     venta.medio_pago === 'tarjeta' ? 'total_tarjeta' :
                     (venta.medio_pago === 'mercado pago' || venta.medio_pago === 'transferencia' || venta.medio_pago === 'otro') ? 'total_mp' : 'total_ctacte';
        db.prepare(`UPDATE caja SET ${campo} = ${campo} + ? WHERE id = 1`).run(venta.total);
      }

      return ventaId;
    })();

    res.json({ success: true, venta_id: result });

  } catch (err) {
    console.error('❌ Error en venta:', err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/ventas', (req, res) => {
  try {
    const desde = req.query.desde || '1970-01-01';
    const hasta = req.query.hasta || '2099-12-31';
    const limit = Math.min(parseInt(req.query.limit) || 200, 1000);
    const offset = parseInt(req.query.offset) || 0;
    const stmt = db.prepare(`
      SELECT * FROM ventas WHERE fecha >= ? AND fecha <= ? ORDER BY timestamp DESC LIMIT ? OFFSET ?
    `);
    const data = stmt.all(desde, hasta, limit, offset);
    const totalStmt = db.prepare('SELECT COUNT(*) as total FROM ventas WHERE fecha >= ? AND fecha <= ?');
    const total = totalStmt.get(desde, hasta).total;
    res.json({ data, total });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/dashboard', (req, res) => {
  try {
    const hoy = new Date().toISOString().slice(0, 10);
    const semanaAtras = new Date();
    semanaAtras.setDate(semanaAtras.getDate() - 7);
    const semanaStr = semanaAtras.toISOString().slice(0, 10);
    const mesAtras = new Date();
    mesAtras.setDate(mesAtras.getDate() - 30);
    const mesStr = mesAtras.toISOString().slice(0, 10);

    const ventasHoy = db.prepare('SELECT SUM(total) as total FROM ventas WHERE fecha = ?').get(hoy).total || 0;
    const ventasSemana = db.prepare('SELECT SUM(total) as total FROM ventas WHERE fecha >= ?').get(semanaStr).total || 0;
    const ventasMes = db.prepare('SELECT SUM(total) as total FROM ventas WHERE fecha >= ?').get(mesStr).total || 0;
    const totalProductos = db.prepare('SELECT COUNT(*) as total FROM productos').get().total;
    const stockBajo = db.prepare('SELECT COUNT(*) as total FROM productos WHERE stock < 5').get().total;
    const caja = db.prepare('SELECT * FROM caja WHERE id = 1').get();

    res.json({
      ganancia_hoy: ventasHoy,
      ganancia_semana: ventasSemana,
      ganancia_mes: ventasMes,
      total_productos: totalProductos,
      stock_bajo: stockBajo,
      caja_estado: caja ? caja.estado : 'cerrada',
      caja_efectivo: caja ? caja.total_efectivo : 0,
      caja_tarjeta: caja ? caja.total_tarjeta : 0,
      caja_mp: caja ? caja.total_mp : 0,
      caja_ctacte: caja ? caja.total_ctacte : 0
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/caja/abrir', (req, res) => {
  const { monto_inicial } = req.body;
  try {
    const caja = db.prepare('SELECT * FROM caja WHERE id = 1').get();
    if (caja && caja.estado === 'abierta') {
      return res.status(400).json({ error: 'Ya hay una caja abierta' });
    }
    db.prepare(`
      INSERT OR REPLACE INTO caja (id, estado, monto_inicial, total_efectivo, total_tarjeta, total_mp, total_ctacte, fecha_apertura, hora_apertura)
      VALUES (1, 'abierta', ?, ?, 0, 0, 0, ?, ?)
    `).run(monto_inicial, monto_inicial, new Date().toISOString().slice(0,10), new Date().toLocaleTimeString());
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/caja/cerrar', (req, res) => {
  try {
    const caja = db.prepare('SELECT * FROM caja WHERE id = 1').get();
    if (!caja || caja.estado !== 'abierta') {
      return res.status(400).json({ error: 'No hay caja abierta' });
    }
    const total = caja.total_efectivo + caja.total_tarjeta + caja.total_mp + caja.total_ctacte;
    db.prepare(`
      UPDATE caja SET estado = 'cerrada', fecha_cierre = ?, hora_cierre = ?, total_cierre = ? WHERE id = 1
    `).run(new Date().toISOString().slice(0,10), new Date().toLocaleTimeString(), total);
    res.json({ success: true, total });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/proveedores', (req, res) => {
  try {
    const data = db.prepare('SELECT * FROM proveedores').all();
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/proveedores', (req, res) => {
  const { nombre, cuit, telefono } = req.body;
  try {
    const stmt = db.prepare('INSERT INTO proveedores (nombre, cuit, telefono) VALUES (?, ?, ?)');
    const info = stmt.run(nombre, cuit, telefono);
    res.json({ success: true, id: info.lastInsertRowid });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/compras', (req, res) => {
  const { fecha, proveedor, total, items } = req.body;
  try {
    const stmt = db.prepare('INSERT INTO compras (fecha, proveedor, total, items) VALUES (?, ?, ?, ?)');
    const info = stmt.run(fecha, proveedor, total, JSON.stringify(items));
    items.forEach(item => {
      if (item.producto_id) {
        const prod = db.prepare('SELECT stock FROM productos WHERE id = ?').get(item.producto_id);
        if (prod) {
          const nuevoStock = prod.stock + item.cantidad;
          db.prepare('UPDATE productos SET stock = ? WHERE id = ?').run(nuevoStock, item.producto_id);
          db.prepare(`
            INSERT INTO movimientos_stock (fecha, producto_id, nombre, tipo, cantidad, stock_anterior, stock_nuevo, usuario)
            VALUES (?, ?, ?, 'compra', ?, ?, ?, ?)
          `).run(fecha, item.producto_id, item.nombre, item.cantidad, prod.stock, nuevoStock, 'Sistema');
        }
      }
    });
    res.json({ success: true, id: info.lastInsertRowid });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/compras', (req, res) => {
  try {
    const data = db.prepare('SELECT * FROM compras ORDER BY fecha DESC LIMIT 200').all();
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/movimientos_stock', (req, res) => {
  try {
    const data = db.prepare('SELECT * FROM movimientos_stock ORDER BY fecha DESC LIMIT 100').all();
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/logs', (req, res) => {
  const { usuario, accion, detalle } = req.body;
  try {
    db.prepare('INSERT INTO logs (fecha, usuario, accion, detalle) VALUES (?, ?, ?, ?)')
      .run(new Date().toISOString(), usuario, accion, detalle);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/logs', (req, res) => {
  try {
    const data = db.prepare('SELECT * FROM logs ORDER BY fecha DESC LIMIT 100').all();
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/productos/sync', (req, res) => {
  const { productos } = req.body;
  try {
    const insert = db.prepare(`
      INSERT OR REPLACE INTO productos (id, codigo, codigo_barras, nombre, categoria, precio_final, stock, tipo_venta, costo_s_iva, tipo_iva, precio_s_iva, stock_disponible, stock_minimo, marca, ubicacion, seccion, activo, metodo_precio, porcentaje_ganancia)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const result = db.transaction(() => {
      productos.forEach(p => {
        insert.run(
          p.id, p.codigo, p.codigo_barras, p.nombre, p.categoria,
          p.precio_final, p.stock, p.tipo_venta, p.costo_s_iva, p.tipo_iva,
          p.precio_s_iva, p.stock_disponible, p.stock_minimo, p.marca,
          p.ubicacion, p.seccion, p.activo, p.metodo_precio, p.porcentaje_ganancia
        );
      });
    })();
    res.json({ success: true, count: productos.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ================================================================
//  INICIAR SERVIDOR
// ================================================================
app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Servidor corriendo en http://localhost:${PORT}`);
  console.log(`📡 Accesible desde otros dispositivos en tu red usando la IP local`);
  console.log(`📂 Datos guardados en: ${dataDir}`);
});
