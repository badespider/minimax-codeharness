import { randomBytes, randomUUID } from 'node:crypto';
import { link, mkdir, open, readFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';

const HOST_ID_PATTERN = /^urn:uuid:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

// The ID is non-secret but must be stable for this application host. A hard
// link publishes a fully written candidate without overwriting another
// process's winner; an invalid existing value is never silently replaced.
export async function getOrCreateChatGptHostId(directory: string): Promise<string> {
  await mkdir(directory, { recursive: true });
  const hostPath = join(directory, 'host-id');
  const tempPath = join(directory, `.host-id-${randomBytes(16).toString('hex')}.tmp`);
  try {
    const candidate = `urn:uuid:${randomUUID()}`;
    const file = await open(tempPath, 'wx', 0o600);
    try { await file.writeFile(candidate, 'utf8'); await file.sync(); } finally { await file.close(); }
    try { await link(tempPath, hostPath); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    const saved = await readFile(hostPath, 'utf8');
    if (!HOST_ID_PATTERN.test(saved)) throw new Error('Invalid ChatGPT host identity.');
    return saved;
  } finally { await unlink(tempPath).catch(() => {}); }
}
