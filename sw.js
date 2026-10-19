// JARVIS Service Worker: Netzwerk zuerst, Cache nur als Offline-Rückfall.
// So erscheinen neue Deployments sofort, ohne dass vergessene Cache-Versionen alte Dateien festhalten.
// API-Anfragen an das Backend (andere Origin) werden nie zwischengespeichert.
const CACHE='jarvis-pwa-v23';
const ASSETS=['./','./index.html','./manifest.webmanifest','./icon-192.png','./icon-512.png','./css/stark.css','./js/visuals.js','./assets/geo/geo.json','./vendor/fonts/rajdhani/rajdhani-latin-500-normal.woff2','./vendor/fonts/rajdhani/rajdhani-latin-600-normal.woff2','./vendor/fonts/rajdhani/rajdhani-latin-700-normal.woff2','./js/auth.js','./js/system.js','./js/memory.js','./js/agent.js','./js/automation.js','./js/study.js','./js/whatsapp-parse.js','./js/messages.js','./js/planner.js','./js/mail.js','./js/voice.js','./js/speech.js','./js/tasks.js','./js/shell.js'];
self.addEventListener('install',event=>{event.waitUntil(caches.open(CACHE).then(cache=>cache.addAll(ASSETS)).then(()=>self.skipWaiting()))});
self.addEventListener('activate',event=>{event.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(key=>key.startsWith('jarvis-pwa-')&&key!==CACHE).map(key=>caches.delete(key)))).then(()=>self.clients.claim()))});
self.addEventListener('fetch',event=>{
 const request=event.request,url=new URL(request.url);
 if(request.method!=='GET'||url.origin!==location.origin)return;
 event.respondWith((async()=>{
  const cache=await caches.open(CACHE);
  try{
   const fresh=await fetch(request,{cache:'no-cache'});
   if(fresh.ok&&fresh.type==='basic')await cache.put(request,fresh.clone());
   return fresh;
  }catch(error){
   const cached=await cache.match(request,{ignoreSearch:true});
   if(cached)return cached;
   if(request.mode==='navigate')return (await cache.match('./index.html'))||Response.error();
   return Response.error();
  }
 })())
});

// Push: iOS/iPadOS verlangt, dass jede Push-Nachricht sichtbar angezeigt wird.
self.addEventListener('push',event=>{
 let d={};
 try{d=event.data?event.data.json():{}}catch(e){d={title:'JARVIS',body:event.data?event.data.text():''}}
 event.waitUntil(self.registration.showNotification(d.title||'JARVIS',{body:d.body||'',icon:'./icon-192.png',badge:'./icon-192.png',tag:d.tag||undefined,data:{url:d.url||'./'}}));
});
self.addEventListener('notificationclick',event=>{
 event.notification.close();
 const target=new URL(event.notification.data?.url||'./',self.registration.scope).href;
 event.waitUntil(clients.matchAll({type:'window',includeUncontrolled:true}).then(list=>{
  for(const client of list){if('navigate'in client)return client.focus().then(()=>client.navigate(target))}
  return clients.openWindow(target);
 }));
});
