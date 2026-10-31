/**
 * Client-side image resizing: scales to fit `maxSide` and re-encodes as JPEG,
 * stepping the quality (and, if needed, the size) down until it fits `maxBytes`.
 */
export interface ResizeOptions {
  maxSide?: number;
  maxBytes?: number;
}

export interface ResizedImage {
  mime: string;
  /** Base64 without the `data:` prefix. */
  dataB64: string;
  blob: Blob;
}

interface Loaded {
  img: CanvasImageSource;
  width: number;
  height: number;
  done: () => void;
}

async function loadImage(file: Blob): Promise<Loaded> {
  if (typeof createImageBitmap === 'function') {
    try {
      const bmp = await createImageBitmap(file);
      return { img: bmp, width: bmp.width, height: bmp.height, done: () => bmp.close() };
    } catch {
      /* fall back to <img> below */
    }
  }
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.decoding = 'async';
    img.src = url;
    await img.decode();
    return { img, width: img.naturalWidth, height: img.naturalHeight, done: () => URL.revokeObjectURL(url) };
  } catch {
    URL.revokeObjectURL(url);
    throw new Error("That file doesn't look like a picture we can read.");
  }
}

function toBlob(canvas: HTMLCanvasElement, quality: number): Promise<Blob> {
  return new Promise((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('Could not compress the picture.'))), 'image/jpeg', quality),
  );
}

export function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => {
      const s = String(r.result);
      resolve(s.slice(s.indexOf(',') + 1));
    };
    r.onerror = () => reject(new Error('Could not read the picture.'));
    r.readAsDataURL(blob);
  });
}

/** Resize + compress. Defaults match wishlist images (≤ 1000 px, ≤ 150 KB). */
export async function resizeImage(file: Blob, opts: ResizeOptions = {}): Promise<ResizedImage> {
  const maxSide = opts.maxSide ?? 1000;
  const maxBytes = opts.maxBytes ?? 150_000;
  if (file.type && !file.type.startsWith('image/')) throw new Error('Please choose a picture file.');

  const { img, width, height, done } = await loadImage(file);
  try {
    let scale = Math.min(1, maxSide / Math.max(width, height));
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Your browser cannot resize pictures.');

    for (let attempt = 0; attempt < 6; attempt++) {
      canvas.width = Math.max(1, Math.round(width * scale));
      canvas.height = Math.max(1, Math.round(height * scale));
      // White background so transparent PNGs don't turn black as JPEG.
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      for (const q of [0.85, 0.75, 0.65, 0.55, 0.45]) {
        const blob = await toBlob(canvas, q);
        if (blob.size <= maxBytes) return { mime: 'image/jpeg', dataB64: await blobToBase64(blob), blob };
      }
      scale *= 0.75; // still too big: shrink and try again
    }
    throw new Error('That picture is too large even after shrinking it.');
  } finally {
    done();
  }
}

/** Builds a data URL only for well-known raster types (data comes from other people). */
export function safeImageSrc(mime: string, dataB64: string): string | null {
  if (!/^image\/(jpeg|png|webp|gif)$/.test(mime)) return null;
  if (!/^[A-Za-z0-9+/=]+$/.test(dataB64)) return null;
  return `data:${mime};base64,${dataB64}`;
}
