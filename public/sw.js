self.addEventListener('push', event => {
  let data = {};
  try { data = event.data.json(); } catch { data.body = event.data?.text() || 'You have a new update.'; }
  if (data.cancel) {
    event.waitUntil(self.registration.getNotifications({ tag: data.cancel }).then(items => items.forEach(item => item.close())));
    return;
  }
  event.waitUntil(self.registration.showNotification(data.title || 'Karan Patel Fan Club', {
    body: data.body || '', tag: data.tag || 'community', icon: '/logo.png', badge: '/logo.png',
  }));
});
self.addEventListener('notificationclick', event => {
  event.notification.close();
  event.waitUntil(clients.matchAll({ type: 'window', includeUncontrolled: true }).then(windows => {
    const client = windows.find(item => 'focus' in item);
    return client ? client.focus() : clients.openWindow('/');
  }));
});
