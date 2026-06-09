import { state } from './state.js';

function updateNotificationPermission() {
  if ('Notification' in window && Notification.permission === 'default') {
    Notification.requestPermission().then(perm => {
      state.notificationsEnabled = perm === 'granted';
    });
  } else if ('Notification' in window) {
    state.notificationsEnabled = Notification.permission === 'granted';
  }
}

function setNotificationsEnabled(enabled) {
  state.notificationsEnabled = Boolean(enabled);
}

function sendNotification(title, body) {
  if (!state.notificationsEnabled || !document.hidden) return;
  try {
    const notif = new Notification(title, {
      body: body,
      icon: '/favicon.ico',
      tag: 'cleon-ui',
      silent: false
    });
    notif.onclick = () => {
      window.focus();
      notif.close();
    };
  } catch (e) {
    // Ignore - notifications may not be supported in this context
  }
}

/**
 * Linkify file paths in text
 * Detects common path patterns and wraps them in clickable links
 * Paths like /path/to/file, ./relative/path, ../parent/path, ~/home/path
 */

export { sendNotification, setNotificationsEnabled, updateNotificationPermission };
