import type { NextFunction, Request, Response } from 'express';

interface RateBucket {
  timestamps: number[];
}

export function createRateLimiter(options: {
  windowMs: number;
  maxRequests: number;
  label?: string;
}) {
  const buckets = new Map<string, RateBucket>();

  return (req: Request, res: Response, next: NextFunction): void => {
    const key = `${options.label ?? 'rl'}:${req.ip || 'local'}`;
    const now = Date.now();
    const cutoff = now - options.windowMs;

    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = { timestamps: [] };
      buckets.set(key, bucket);
    }

    bucket.timestamps = bucket.timestamps.filter((t) => t > cutoff);
    if (bucket.timestamps.length >= options.maxRequests) {
      res.status(429).json({
        error: 'Too many requests, please wait before retrying.',
      });
      return;
    }

    bucket.timestamps.push(now);
    next();
  };
}

export function validateImageMagicBytes(buf: Buffer): {
  valid: boolean;
  mime: string | null;
} {
  if (!Buffer.isBuffer(buf) || buf.length < 12) {
    return { valid: false, mime: null };
  }

  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (
    buf[0] === 0x89 &&
    buf[1] === 0x50 &&
    buf[2] === 0x4e &&
    buf[3] === 0x47 &&
    buf[4] === 0x0d &&
    buf[5] === 0x0a &&
    buf[6] === 0x1a &&
    buf[7] === 0x0a
  ) {
    return { valid: true, mime: 'image/png' };
  }

  // JPEG: FF D8 FF
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
    return { valid: true, mime: 'image/jpeg' };
  }

  // GIF: GIF87a or GIF89a
  if (
    buf[0] === 0x47 &&
    buf[1] === 0x49 &&
    buf[2] === 0x46 &&
    buf[3] === 0x38 &&
    (buf[4] === 0x37 || buf[4] === 0x39) &&
    buf[5] === 0x61
  ) {
    return { valid: true, mime: 'image/gif' };
  }

  // WebP: RIFF....WEBP
  if (
    buf[0] === 0x52 &&
    buf[1] === 0x49 &&
    buf[2] === 0x46 &&
    buf[3] === 0x46 &&
    buf[8] === 0x57 &&
    buf[9] === 0x45 &&
    buf[10] === 0x42 &&
    buf[11] === 0x50
  ) {
    return { valid: true, mime: 'image/webp' };
  }

  return { valid: false, mime: null };
}

export function validateMapMediaMagicBytes(buf: Buffer): {
  valid: boolean;
  mime: string | null;
} {
  const imgCheck = validateImageMagicBytes(buf);
  if (imgCheck.valid) return imgCheck;

  if (!Buffer.isBuffer(buf) || buf.length < 12) {
    return { valid: false, mime: null };
  }

  // WebM / Matroska EBML: 1A 45 DF A3
  if (
    buf[0] === 0x1a &&
    buf[1] === 0x45 &&
    buf[2] === 0xdf &&
    buf[3] === 0xa3
  ) {
    return { valid: true, mime: 'video/webm' };
  }

  // MP4 / M4V ISO BMFF: ....ftyp at offset 4
  if (
    buf[4] === 0x66 &&
    buf[5] === 0x74 &&
    buf[6] === 0x79 &&
    buf[7] === 0x70
  ) {
    return { valid: true, mime: 'video/mp4' };
  }

  return { valid: false, mime: null };
}

export function sendProtectedBinary(
  res: Response,
  buf: Uint8Array,
  mime: string
): void {
  res.setHeader('Content-Type', mime);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Security-Policy', "default-src 'none'");
  res.setHeader('Cache-Control', 'private, no-store');
  res.send(Buffer.from(buf));
}
