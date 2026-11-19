import { ingest } from '../../../lib/ops.mjs';

export const runtime = 'nodejs';

// Write-only endpoint for the VM collector. The dashboard reads through the signed-in /api/mail/ops action instead.
export function POST(request) {
  return ingest(request);
}
