import { serveMail } from '../../../../lib/mail-api.mjs';

export const runtime = 'nodejs';
export const maxDuration = 180;

export function POST(request, context) {
  return serveMail(request, context);
}
