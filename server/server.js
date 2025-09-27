
import express from 'express';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
import Database from 'better-sqlite3';
import webpush from 'web-push';
import dotenv from 'dotenv';
dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;
app.use(cors());
app.use(express.json());

// ------- Config -------
const ADMIN_PIN = process.env.ADMIN_PIN || '1234';
const CRON_TOKEN = process.env.CRON_TOKEN || 'changeme';
const PUSH_SUBJECT = process.env.PUSH_SUBJECT || 'mailto:admin@example.com';
const VAPID_PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY || '';
const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY || '';

if(VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY){
  webpush.setVapidDetails(PUSH_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);
}

// ------- DB -------
const db = new Database(path.join(__dirname, 'barber.db'));
function initDb(){
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;

    CREATE TABLE IF NOT EXISTS barbers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      active INTEGER NOT NULL DEFAULT 1
    );

    CREATE TABLE IF NOT EXISTS services (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      duration_minutes INTEGER NOT NULL DEFAULT 30
    );

    CREATE TABLE IF NOT EXISTS bookings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      client TEXT NOT NULL,
      contact TEXT,
      service_id INTEGER,
      barber_id INTEGER NOT NULL,
      start_iso TEXT NOT NULL,
      end_iso TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pendiente',
      client_sub_id INTEGER, -- opcional: para recordatorios
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (service_id) REFERENCES services(id),
      FOREIGN KEY (barber_id) REFERENCES barbers(id)
    );

    CREATE TABLE IF NOT EXISTS push_subs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      role TEXT NOT NULL, -- 'barber' | 'client'
      barber_id INTEGER,  -- cuando role = 'barber'
      json TEXT NOT NULL, -- subscription JSON
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS reminders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      booking_id INTEGER NOT NULL,
      client_sub_id INTEGER NOT NULL,
      scheduled_at TEXT NOT NULL,
      sent INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_bookings_barber_time ON bookings (barber_id, start_iso, end_iso);
    CREATE INDEX IF NOT EXISTS idx_bookings_status_time ON bookings (status, start_iso);
    CREATE INDEX IF NOT EXISTS idx_subs_role ON push_subs (role, barber_id);
    CREATE INDEX IF NOT EXISTS idx_reminders ON reminders (scheduled_at, sent);
  `);

  // Seed básico
  if(db.prepare('SELECT COUNT(*) c FROM barbers').get().c === 0){
    db.prepare('INSERT INTO barbers (name,active) VALUES (?,1)').run('Barbero 1');
    db.prepare('INSERT INTO barbers (name,active) VALUES (?,1)').run('Barbero 2');
  }
  if(db.prepare('SELECT COUNT(*) c FROM services').get().c === 0){
    db.prepare('INSERT INTO services (name,duration_minutes) VALUES (?,?)').run('Corte', 30);
    db.prepare('INSERT INTO services (name,duration_minutes) VALUES (?,?)').run('Barba', 20);
  }
  console.log('DB lista');
}
if(process.argv.includes('--init-db')){ initDb(); process.exit(0); } else { initDb(); }

// ------- Helpers -------
function hasOverlap(barberId, startISO, endISO, ignoreId=null){
  const row = db.prepare(`
    SELECT COUNT(*) c FROM bookings
    WHERE barber_id = ?
      AND status <> 'cancelada'
      AND NOT (? <= start_iso OR ? >= end_iso)
      ${ignoreId ? 'AND id <> ?' : ''}
  `).get(...(ignoreId?[barberId, endISO, startISO, ignoreId]:[barberId, endISO, startISO]));
  return row.c > 0;
}

function sendPushToSub(sub, payload){
  if(!VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY) return;
  try {
    return webpush.sendNotification(JSON.parse(sub.json), JSON.stringify(payload)).catch(e=>{
      // si falla, ignoramos silenciosamente (podría ser permiso revocado)
      console.warn('push error', e.statusCode);
    });
  } catch (e){ console.warn('push send error', e.message); }
}

// ------- Auth admin muy simple (PIN) -------
app.post('/api/login', (req,res)=>{
  const { pin } = req.body || {};
  if(String(pin)===String(ADMIN_PIN)) return res.json({ ok: true });
  return res.status(401).json({ error: 'PIN incorrecto' });
});

// ------- Catálogo -------
app.get('/api/barbers', (req,res)=>{
  res.json(db.prepare('SELECT * FROM barbers ORDER BY active DESC, name ASC').all());
});
app.post('/api/barbers', (req,res)=>{
  const { id, name, active } = req.body || {};
  if(id){
    db.prepare('UPDATE barbers SET name=?, active=? WHERE id=?').run((name||'').trim(), active?1:0, Number(id));
    return res.json(db.prepare('SELECT * FROM barbers WHERE id=?').get(Number(id)));
  } else {
    if(!name || !name.trim()) return res.status(400).json({error:'Nombre requerido'});
    const info = db.prepare('INSERT INTO barbers (name,active) VALUES (?,?)').run(name.trim(), active?1:1);
    return res.status(201).json(db.prepare('SELECT * FROM barbers WHERE id=?').get(info.lastInsertRowid));
  }
});

app.get('/api/services', (req,res)=>{
  res.json(db.prepare('SELECT * FROM services ORDER BY name ASC').all());
});
app.post('/api/services', (req,res)=>{
  const { id, name, duration_minutes } = req.body || {};
  if(id){
    db.prepare('UPDATE services SET name=?, duration_minutes=? WHERE id=?').run((name||'').trim(), Number(duration_minutes||30), Number(id));
    return res.json(db.prepare('SELECT * FROM services WHERE id=?').get(Number(id)));
  } else {
    if(!name || !name.trim()) return res.status(400).json({error:'Nombre requerido'});
    const info = db.prepare('INSERT INTO services (name, duration_minutes) VALUES (?,?)').run(name.trim(), Number(duration_minutes||30));
    return res.status(201).json(db.prepare('SELECT * FROM services WHERE id=?').get(info.lastInsertRowid));
  }
});

// ------- Bookings -------
app.get('/api/bookings', (req,res)=>{
  const { date, barberId, status, q } = req.query;
  let sql = 'SELECT * FROM bookings'; const where=[]; const args=[];
  if(barberId){ where.push('barber_id = ?'); args.push(Number(barberId)); }
  if(status){ where.push('status = ?'); args.push(String(status)); }
  if(date){ const s=`${date}T00:00:00.000Z`, e=`${date}T23:59:59.999Z`; where.push('NOT (? > end_iso OR ? < start_iso)'); args.push(s,e); }
  if(q){ const like = `%${String(q).toLowerCase()}%`; where.push('(LOWER(client) LIKE ? OR LOWER(contact) LIKE ?)'); args.push(like, like); }
  if(where.length) sql += ' WHERE '+where.join(' AND ');
  sql += ' ORDER BY start_iso ASC';
  res.json(db.prepare(sql).all(...args));
});

app.post('/api/bookings', (req,res)=>{
  const { id, client, contact, serviceId, barberId, startISO, endISO, status, clientSubId, reminderMinutes } = req.body || {};
  if(!client || !barberId || !startISO || !endISO) return res.status(400).json({error:'Campos obligatorios'});
  const s = new Date(startISO), e = new Date(endISO);
  if(!(s instanceof Date) || isNaN(s) || !(e instanceof Date) || isNaN(e) || e<=s) return res.status(400).json({error:'Rango de tiempo inválido'});

  const tx = db.transaction(()=>{
    if(hasOverlap(Number(barberId), s.toISOString(), e.toISOString(), id||null)){
      return { error: 'El barbero ya tiene una reserva en ese horario' };
    }
    let row;
    if(id){
      db.prepare('UPDATE bookings SET client=?, contact=?, service_id=?, barber_id=?, start_iso=?, end_iso=?, status=?, client_sub_id=?, updated_at=datetime(\'now\') WHERE id=?')
        .run(client.trim(), contact||'', serviceId||null, Number(barberId), s.toISOString(), e.toISOString(), (status||'pendiente'), clientSubId||null, Number(id));
      row = db.prepare('SELECT * FROM bookings WHERE id=?').get(Number(id));
    } else {
      const info = db.prepare('INSERT INTO bookings (client, contact, service_id, barber_id, start_iso, end_iso, status, client_sub_id) VALUES (?,?,?,?,?,?,?,?)')
        .run(client.trim(), contact||'', serviceId||null, Number(barberId), s.toISOString(), e.toISOString(), (status||'pendiente'), clientSubId||null);
      row = db.prepare('SELECT * FROM bookings WHERE id=?').get(info.lastInsertRowid);
    }
    // Crear recordatorio si aplica
    if(reminderMinutes && clientSubId){
      const ms = Number(reminderMinutes)*60000;
      const when = new Date(s.getTime() - ms).toISOString();
      db.prepare('INSERT INTO reminders (booking_id, client_sub_id, scheduled_at) VALUES (?,?,?)').run(row.id, Number(clientSubId), when);
    }
    return row;
  });

  const result = tx();
  if(result && result.error) return res.status(409).json({error: result.error});

  // Notificar al barbero (push)
  try{
    const subs = db.prepare('SELECT * FROM push_subs WHERE role=? AND barber_id=?').all('barber', Number(barberId));
    const payload = {
      title: 'Nueva reserva',
      body: `${result.client} · ${new Date(result.start_iso).toLocaleTimeString([], {hour:'2-digit', minute:'2-digit'})}`,
      data: { bookingId: result.id }
    };
    subs.forEach(sub => sendPushToSub(sub, payload));
  }catch(e){ console.warn('notify barber error', e.message); }

  return res.status(id?200:201).json(result);
});

app.post('/api/bookings/:id/cancel', (req,res)=>{
  const id = Number(req.params.id);
  db.prepare('UPDATE bookings SET status=\'cancelada\', updated_at=datetime(\'now\') WHERE id=?').run(id);
  res.json(db.prepare('SELECT * FROM bookings WHERE id=?').get(id));
});

// ------- Push subscriptions -------
app.post('/api/push/subscribe', (req,res)=>{
  const { role, barberId, subscription } = req.body || {};
  if(!subscription || !role) return res.status(400).json({error:'Faltan datos'});
  const info = db.prepare('INSERT INTO push_subs (role, barber_id, json) VALUES (?,?,?)').run(String(role), barberId?Number(barberId):null, JSON.stringify(subscription));
  res.status(201).json({ id: info.lastInsertRowid });
});

app.get('/api/push/vapid', (req,res)=>{
  res.json({ publicKey: VAPID_PUBLIC_KEY || '' });
});

// ------- Cron para recordatorios -------
app.post('/cron/run', (req,res)=>{
  const token = req.headers['x-cron-token'] || req.query.token;
  if(String(token)!==String(CRON_TOKEN)) return res.status(403).json({error:'forbidden'});
  const now = new Date().toISOString();
  const due = db.prepare('SELECT * FROM reminders WHERE sent=0 AND scheduled_at <= ? ORDER BY scheduled_at ASC LIMIT 50').all(now);
  let sent = 0;
  due.forEach(r=>{
    const sub = db.prepare('SELECT * FROM push_subs WHERE id=?').get(r.client_sub_id);
    const bk = db.prepare('SELECT * FROM bookings WHERE id=?').get(r.booking_id);
    if(sub && bk){
      const payload = { title: 'Recordatorio de cita', body: f`${bk.client} · empieza a las ${new Date(bk.start_iso).toLocaleTimeString([], {hour:'2-digit', minute:'2-digit'})}` };
      sendPushToSub(sub, payload);
      db.prepare('UPDATE reminders SET sent=1 WHERE id=?').run(r.id);
      sent++;
    } else {
      db.prepare('UPDATE reminders SET sent=1 WHERE id=?').run(r.id); // descartar si falta info
    }
  });
  res.json({ ok:true, processed: due.length, sent });
});

// ------- Static -------
const clientDir = path.join(__dirname, '../client');
app.use(express.static(clientDir));
// admin path
app.get('/admin', (req,res)=> res.sendFile(path.join(clientDir, 'admin', 'index.html')));
app.get('*', (req,res)=> res.sendFile(path.join(clientDir, 'index.html')));

app.listen(PORT, ()=> console.log(`OK en http://localhost:${PORT}`));
