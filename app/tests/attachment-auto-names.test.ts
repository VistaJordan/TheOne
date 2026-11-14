/**
 * Automatic file names (Elise, 2026-11-14): a file filed into a group is
 * named by it — B1… before, A1… after, SO1… sign-off, C1… from client —
 * numbered per work order in the order filed; Other keeps its name.
 */
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { autoAttachmentName, autoNameNumber, fileExtension, nextAutoNumber } from '@theone/shared';

const root = resolve(__dirname, '..');
const read = (...p: string[]) => readFileSync(join(root, ...p), 'utf8');

describe('automatic attachment names', () => {
  it('names each group with its prefix and keeps the extension', () => {
    expect(autoAttachmentName('before', 1, 'IMG_2231.JPG')).toBe('B1.jpg');
    expect(autoAttachmentName('after', 3, 'photo.heic')).toBe('A3.heic');
    expect(autoAttachmentName('signoff', 2, 'signed.pdf')).toBe('SO2.pdf');
    expect(autoAttachmentName('client', 1, 'scan')).toBe('C1');
    expect(autoAttachmentName('other', 1, 'notes.txt')).toBeNull();
  });

  it('reads the number back only from a name of the same group', () => {
    expect(autoNameNumber('after', 'A12.jpg')).toBe(12);
    expect(autoNameNumber('after', 'a2.PNG')).toBe(2);
    expect(autoNameNumber('signoff', 'SO4.pdf')).toBe(4);
    expect(autoNameNumber('before', 'A1.jpg')).toBeNull();
    expect(autoNameNumber('after', 'After1.jpg')).toBeNull();
    expect(autoNameNumber('other', 'A1.jpg')).toBeNull();
  });

  it('numbers one past the highest, never reusing a gap', () => {
    expect(nextAutoNumber('after', [])).toBe(1);
    expect(nextAutoNumber('after', ['A1.jpg', 'A3.jpg', 'IMG_9.jpg'])).toBe(4);
    expect(nextAutoNumber('before', ['A1.jpg', 'A2.jpg'])).toBe(1);
  });

  it('extension is lower-cased and optional', () => {
    expect(fileExtension('x.JPEG')).toBe('.jpeg');
    expect(fileExtension('noext')).toBe('');
  });

  it('the API names on approval and on a client upload, under the task lock', () => {
    const svc = read('apps/api/src/services/attachments.ts');
    expect(svc).toMatch(/FOR NO KEY UPDATE/);
    expect(svc).toMatch(/storedName = await autoNameFor\(tx, taskId, null, 'client', fileName\)/);
    expect(svc).toMatch(/name = await autoNameFor\(tx, taskId, attachmentId, kind,/);
  });
});
