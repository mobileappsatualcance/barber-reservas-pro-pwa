
# Barber Reservas PRO (PWA)
- Interfaces separadas: **Cliente** (`/`) y **Admin/Barbero** (`/admin`).
- Anti‑solapamientos por barbero (transacción).
- **Web Push**: notifica al barbero cuando se crea una reserva.
- **Recordatorios**: al cliente X minutos antes (vía cron).
- PWA instalable con `manifest.json` + `sw.js`.

## Variables de entorno
Crea un archivo `.env` dentro de `/server` con:
```
ADMIN_PIN=1234
PUSH_SUBJECT=mailto:tuemail@dominio.com
VAPID_PUBLIC_KEY=
VAPID_PRIVATE_KEY=
CRON_TOKEN=pon-un-token-seguro
PORT=3000
```

### Generar claves VAPID (localmente)
```
cd server
npm install
node -e "import('web-push').then(m=>{const k=m.default.generateVAPIDKeys();console.log(k)})"
```
Pega `publicKey` y `privateKey` en el `.env`.

## Inicializar y arrancar (local)
```
cd server
npm install
npm run init:db
npm start
```
- Cliente: http://localhost:3000/
- Admin:   http://localhost:3000/admin  (PIN requerido)

## Recordatorios (cron)
Configura un cron (ej. cada minuto) que llame:
```
POST /cron/run
Headers: x-cron-token: <CRON_TOKEN>
```
En Render → **Cron Jobs**: URL `https://tuapp.onrender.com/cron/run?token=<CRON_TOKEN>` cada 1–5 min.

## Flujo
- **Cliente**: activa notificaciones, crea reserva y (opcional) marca “Recordarme X min antes”.
- **Servidor**: guarda la reserva y programa un recordatorio.
- **Barbero**: en `/admin` selecciona su nombre y pulsa “Activar notificaciones en este dispositivo”. Al entrar nuevas reservas, recibe push.

