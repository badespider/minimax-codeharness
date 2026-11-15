import { spawn } from 'node:child_process';
import { win32 } from 'node:path';

/** Launch through an absolute Windows system executable; never search the project PATH. */
export async function openSiwcAuthorization(url: string): Promise<void> {
  if (process.platform !== 'win32') throw new Error('ChatGPT sign-in browser launch is currently supported on Windows only.');
  const root = process.env.SystemRoot;
  if (!root || !win32.isAbsolute(root) || win32.normalize(root) !== root.replace(/[\\/]+$/, '')) throw new Error('Windows system directory is unavailable.');
  const executable = win32.join(root, 'System32', 'rundll32.exe');
  const handler = `${win32.join(root, 'System32', 'url.dll')},FileProtocolHandler`;
  await new Promise<void>((resolve, reject) => {
    const child = spawn(executable, [handler, url], { windowsHide: true, stdio: 'ignore' });
    child.once('error', () => reject(new Error('Could not open ChatGPT sign-in.')));
    child.once('spawn', () => { child.unref(); resolve(); });
  });
}
