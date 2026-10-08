import { Menu } from '@base-ui/react/menu';
import { Bell, BellOff } from 'lucide-react';
import { useState } from 'react';
import { MENU_ITEM } from '../components/kit';

/** Menu entry that asks the browser for desktop notifications; the browser keeps the decision. */
export function DesktopAlertsItem() {
  const supported = typeof window !== 'undefined' && 'Notification' in window;
  const [permission, setPermission] = useState(() => (supported ? Notification.permission : 'denied'));
  if (!supported) return null;
  const label = permission === 'granted' ? 'Avisos de escritorio activos'
    : permission === 'denied' ? 'Avisos bloqueados por el navegador' : 'Avisarme en el escritorio';
  return (
    <Menu.Item className={MENU_ITEM} disabled={permission !== 'default'}
      onClick={() => { void Notification.requestPermission().then(setPermission); }}>
      {permission === 'denied' ? <BellOff size={15} aria-hidden="true" className="text-muted" /> : <Bell size={15} aria-hidden="true" className="text-muted" />}
      {label}
    </Menu.Item>
  );
}
