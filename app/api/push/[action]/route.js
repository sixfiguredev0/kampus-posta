import { serveWorker } from '../../../../lib/push.mjs';

export const runtime = 'nodejs';

// Only the VM push worker calls these (bearer PUSH_WORKER_TOKEN): `accounts` after a restart, `report` for problems.
export async function POST(request, context) {
  const { action } = await context.params;
  return serveWorker(request, action);
}
