import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, normalize } from 'node:path';

const MAX_MEMORY_EXCERPT_BYTES = 16 * 1024;

export function defaultWorkerMemoryRef(workerInstanceId: string): string {
  return join('memory', `${workerInstanceId}.md`);
}

export function resolveWorkerMemoryPath(
  authorityRoot: string,
  workerInstanceId: string,
  memoryRef?: string | null,
): string {
  const ref = normalize(memoryRef && memoryRef.length > 0 ? memoryRef : defaultWorkerMemoryRef(workerInstanceId));
  return join(authorityRoot, ref);
}

export function ensureWorkerMemoryFile(
  authorityRoot: string,
  workerInstanceId: string,
  sessionId: string,
  roleLabel: string,
  memoryRef?: string | null,
): string {
  const memoryPath = resolveWorkerMemoryPath(authorityRoot, workerInstanceId, memoryRef);
  mkdirSync(dirname(memoryPath), { recursive: true });
  if (!existsSync(memoryPath)) {
    writeFileSync(
      memoryPath,
      [
        `# Worker Memory: ${workerInstanceId}`,
        `session_id: ${sessionId}`,
        `role_label: ${roleLabel}`,
        '',
        'Use this file for durable notes, stable findings, and context worth carrying across live session replacement.',
        '',
      ].join('\n'),
      'utf8',
    );
  }
  return memoryPath;
}

export function readWorkerMemory(authorityRoot: string, workerInstanceId: string, memoryRef?: string | null): {
  ref: string;
  path: string;
  exists: boolean;
  bytes: number;
  content: string;
  excerpt: string;
} {
  const ref = memoryRef && memoryRef.length > 0 ? memoryRef : defaultWorkerMemoryRef(workerInstanceId);
  const path = resolveWorkerMemoryPath(authorityRoot, workerInstanceId, memoryRef);
  if (!existsSync(path)) {
    return { ref, path, exists: false, bytes: 0, content: '', excerpt: '' };
  }
  const content = readFileSync(path, 'utf8');
  return {
    ref,
    path,
    exists: true,
    bytes: Buffer.byteLength(content, 'utf8'),
    content,
    excerpt: content.slice(0, MAX_MEMORY_EXCERPT_BYTES),
  };
}
