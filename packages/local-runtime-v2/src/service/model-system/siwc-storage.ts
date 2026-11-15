import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import type { ChatGptTokenSet } from './siwc-token.js';

// DPAPI binds ciphertext to the current Windows user. Secrets are sent over
// stdin, never in process arguments, and diagnostics never include output.
const protectScript = `$ErrorActionPreference = 'Stop'; Add-Type -AssemblyName System.Security; $s=[Console]::In.ReadToEnd(); $b=[Text.Encoding]::UTF8.GetBytes($s); $r=[Security.Cryptography.ProtectedData]::Protect($b,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser); [Console]::Out.Write([Convert]::ToBase64String($r))`;
const unprotectScript = `$ErrorActionPreference = 'Stop'; Add-Type -AssemblyName System.Security; $s=[Console]::In.ReadToEnd(); $b=[Convert]::FromBase64String($s); $r=[Security.Cryptography.ProtectedData]::Unprotect($b,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser); [Console]::Out.Write([Text.Encoding]::UTF8.GetString($r))`;
const restrictScript = `$ErrorActionPreference = 'Stop'; $p=[Console]::In.ReadToEnd(); $id=[Security.Principal.WindowsIdentity]::GetCurrent().User; $acl=New-Object Security.AccessControl.FileSecurity; $acl.SetOwner($id); $acl.SetAccessRuleProtection($true,$false); $rule=New-Object Security.AccessControl.FileSystemAccessRule($id,'FullControl','Allow'); $acl.AddAccessRule($rule); [System.IO.File]::SetAccessControl($p,$acl)`;

function powershell(script: string, input: string, operation: string): Promise<string> {
  return new Promise((resolve, reject) => {
    // Fixed path avoids looking up an attacker-controlled executable via PATH.
    // Fail closed on Windows installations not located under C:\Windows.
    const child = spawn('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true });
    let output = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => { output += chunk; });
    child.on('error', () => reject(new Error('Windows credential protection is unavailable.')));
    child.on('close', (code) => code === 0 ? resolve(output) : reject(new Error(`Windows credential ${operation} failed.`)));
    child.stdin.on('error', () => {});
    child.stdin.end(input);
  });
}

export function protectChatGptData(value: string): Promise<string> { return powershell(protectScript, value, 'encryption'); }
export function unprotectChatGptData(value: string): Promise<string> { return powershell(unprotectScript, value, 'decryption'); }
export function restrictChatGptFile(path: string): Promise<string> { return powershell(restrictScript, path, 'permissions'); }

export interface ChatGptLockedStore {
  read(): Promise<ChatGptTokenSet | undefined>;
  write(tokens: ChatGptTokenSet): Promise<void>;
}

// All refreshes and writes MUST be performed inside withClientLock, including
// the network request. A crashed process leaves its lock in place and fails
// closed rather than risking reuse of a rotating refresh token.
export class WindowsChatGptTokenStore {
  private readonly directory: string;
  constructor(directory: string) { this.directory = directory; }

  async withClientLock<T>(clientId: string, action: (store: ChatGptLockedStore) => Promise<T>): Promise<T> {
    if (process.platform !== 'win32') throw new Error('Windows credential protection is unavailable on this platform.');
    if (!clientId || clientId === 'dynamic_agent_client') throw new Error('A registered client ID is required.');
    await mkdir(this.directory, { recursive: true });
    const id = createHash('sha256').update(clientId).digest('hex');
    const lockPath = join(this.directory, `${id}.lock`);
    const credentialPath = join(this.directory, `${id}.dat`);
    let lock;
    const deadline = Date.now() + 10_000;
    for (;;) {
      try { lock = await open(lockPath, 'wx', 0o600); break; }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        if (Date.now() >= deadline) throw new Error('ChatGPT credential lock is unavailable.');
        await delay(100);
      }
    }
    try {
      return await action({
        read: async () => {
          let sealed: string;
          try { sealed = await readFile(credentialPath, 'utf8'); }
          catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
          const parsed: unknown = JSON.parse(await powershell(unprotectScript, sealed, 'decryption'));
          if (!parsed || typeof parsed !== 'object' || (parsed as ChatGptTokenSet).clientId !== clientId) throw new Error('Invalid ChatGPT credential record.');
          return parsed as ChatGptTokenSet;
        },
        write: async (tokens) => {
          if (tokens.clientId !== clientId) throw new Error('ChatGPT credential client mismatch.');
          const sealed = await powershell(protectScript, JSON.stringify(tokens), 'encryption');
          if (!sealed) throw new Error('Windows credential protection returned no data.');
          const tempPath = join(this.directory, `${id}.${randomBytes(16).toString('hex')}.tmp`);
          try {
            const file = await open(tempPath, 'wx', 0o600);
            try { await file.writeFile(sealed, 'utf8'); await file.sync(); } finally { await file.close(); }
            await powershell(restrictScript, tempPath, 'permissions');
            await rename(tempPath, credentialPath);
          } finally { await unlink(tempPath).catch(() => {}); }
        },
      });
    } finally {
      await lock.close();
      await unlink(lockPath);
    }
  }
}
