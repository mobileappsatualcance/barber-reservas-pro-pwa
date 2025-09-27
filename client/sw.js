
const CACHE='barber-pro-v1';
const ASSETS=['/','/index.html','/admin/index.html','/manifest.json','/icons/icon-192.png','/icons/icon-512.png','/icons/maskable-192.png','/icons/maskable-512.png'];
self.addEventListener('install',e=>{e.waitUntil(caches.open(CACHE).then(c=>c.addAll(ASSETS)));self.skipWaiting();});
self.addEventListener('activate',e=>{e.waitUntil(caches.keys().then(keys=>Promise.all(keys.map(k=>k!==CACHE?caches.delete(k):null))));self.clients.claim();});
self.addEventListener('fetch',e=>{
  const url=new URL(e.request.url);
  if(url.origin===location.origin && (ASSETS.includes(url.pathname) || url.pathname.startsWith('/icons/'))){
    e.respondWith(caches.match(e.request).then(c=> c || fetch(e.request).then(r=>{const copy=r.clone(); caches.open(CACHE).then(cc=>cc.put(e.request,copy)); return r;})));
    return;
  }
  if(url.pathname.startsWith('/api/')){
    e.respondWith(fetch(e.request).then(r=>{const copy=r.clone(); caches.open(CACHE).then(cc=>cc.put(e.request,copy)); return r;}).catch(()=>caches.match(e.request)));
    return;
  }
  e.respondWith(fetch(e.request).catch(()=>caches.match('/index.html')));
});
// Push notifications
self.addEventListener('push', event => {
  let data = {};
  try{ data = event.data.json(); }catch(e){}
  const title = data.title || 'Notificación';
  const options = { body: data.body || '', data: data.data || {}, icon: '/icons/icon-192.png', badge: '/icons/icon-192.png' };
  event.waitUntil(self.registration.showNotification(title, options));
});
self.addEventListener('notificationclick', event => {
  event.notification.close();
  const url = '/admin'; // al tocar, abrir panel (o cliente)
  event.waitUntil(clients.matchAll({type:'window'}).then(list=>{
    for(const c of list){ if(c.url.includes(url) && 'focus' in c) return c.focus(); }
    if(clients.openWindow) return clients.openWindow(url);
  }));
});
