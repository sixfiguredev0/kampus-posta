import { config } from '../../lib/store.mjs';
import MailApp from '../mail-app';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Поща · Кампус Поща' };

export default function MailPage() {
  return <MailApp mode={config()} />;
}
