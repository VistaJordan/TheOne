/* Preparing a file for upload (0043).
 *
 * A phone photograph is 3–8MB; the API runs on a serverless host whose
 * request body is capped well below that. So the browser shrinks a photo
 * before it is sent — the same picture at 2000px on its longest side is
 * usually under 600KB and is still far more detail than a work-order photo
 * needs. Anything that is not an image goes as it is, and anything still over
 * the cap is refused here with a sentence rather than by a failed request.
 *
 * HEIC is the exception: browsers cannot decode it on a canvas, so those go
 * up untouched and are refused if they are too big. That is honest — the
 * alternative is a silent corruption.
 */

import { ATTACHMENT_MAX_BYTES, PHOTO_MAX_EDGE, PHOTO_QUALITY, formatBytes } from '@theone/shared';

export interface PreparedFile {
  file_name: string;
  content_type: string;
  /** base64, without the `data:…;base64,` prefix. */
  data: string;
  byte_size: number;
}

/** Everything after the comma of a data URL. */
function base64Of(dataUrl: string): string {
  const comma = dataUrl.indexOf(',');
  return comma === -1 ? dataUrl : dataUrl.slice(comma + 1);
}

function readAsDataUrl(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ''));
    reader.onerror = () => reject(new Error('That file could not be read'));
    reader.readAsDataURL(file);
  });
}

/** Draw the image at most PHOTO_MAX_EDGE on its longest side. Returns null
    when the browser cannot decode it (HEIC, a corrupt file). */
async function shrinkImage(file: File): Promise<{ dataUrl: string; type: string } | null> {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise<HTMLImageElement | null>((resolve) => {
      const el = new Image();
      el.onload = () => resolve(el);
      el.onerror = () => resolve(null);
      el.src = url;
    });
    if (!img || !img.width || !img.height) return null;

    const longest = Math.max(img.width, img.height);
    const scale = longest > PHOTO_MAX_EDGE ? PHOTO_MAX_EDGE / longest : 1;
    // Already small enough: re-encoding would only lose detail.
    if (scale === 1 && file.size <= ATTACHMENT_MAX_BYTES) return null;

    const canvas = document.createElement('canvas');
    canvas.width = Math.round(img.width * scale);
    canvas.height = Math.round(img.height * scale);
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);

    // PNG screenshots keep their transparency; photographs become JPEG.
    const type = file.type === 'image/png' ? 'image/png' : 'image/jpeg';
    return { dataUrl: canvas.toDataURL(type, PHOTO_QUALITY), type };
  } finally {
    URL.revokeObjectURL(url);
  }
}

export async function prepareFile(file: File): Promise<PreparedFile> {
  const isImage = file.type.startsWith('image/');
  const canDecode = isImage && !/heic|heif/i.test(file.type);

  if (canDecode) {
    const shrunk = await shrinkImage(file);
    if (shrunk) {
      const data = base64Of(shrunk.dataUrl);
      // base64 is 4 characters per 3 bytes, so this is the real byte count.
      const bytes = Math.floor((data.length * 3) / 4);
      if (bytes > ATTACHMENT_MAX_BYTES) {
        throw new Error(
          `Even shrunk, that image is ${formatBytes(bytes)} — the limit is ${formatBytes(ATTACHMENT_MAX_BYTES)}.`,
        );
      }
      const name = file.name.replace(/\.(heic|heif|png|jpe?g|webp)$/i, '') || 'photo';
      return {
        file_name: `${name}${shrunk.type === 'image/png' ? '.png' : '.jpg'}`,
        content_type: shrunk.type,
        data,
        byte_size: bytes,
      };
    }
  }

  if (file.size > ATTACHMENT_MAX_BYTES) {
    throw new Error(
      `${file.name} is ${formatBytes(file.size)} — the limit is ${formatBytes(ATTACHMENT_MAX_BYTES)}.`,
    );
  }

  const dataUrl = await readAsDataUrl(file);
  return {
    file_name: file.name,
    content_type: file.type || 'application/octet-stream',
    data: base64Of(dataUrl),
    byte_size: file.size,
  };
}
