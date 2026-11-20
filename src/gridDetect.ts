import type { GridDetectionResult } from './types';

function centerAndVariance(arr: Float64Array): {
  centered: Float64Array;
  variance: number;
} {
  let sum = 0;
  for (let i = 0; i < arr.length; i++) sum += arr[i];
  const mean = sum / arr.length;
  const centered = new Float64Array(arr.length);
  let varSum = 0;
  for (let i = 0; i < arr.length; i++) {
    const v = arr[i] - mean;
    centered[i] = v;
    varSum += v * v;
  }
  return { centered, variance: varSum / arr.length };
}

function foldPhase(
  profile: Float64Array,
  period: number
): { bestOffset: number; peakScore: number } {
  const bins = Math.max(1, Math.ceil(period));
  const phase = new Float64Array(bins);
  const counts = new Float64Array(bins);

  for (let i = 0; i < profile.length; i++) {
    const pos = i % period;
    const b0 = Math.floor(pos) % bins;
    const b1 = (b0 + 1) % bins;
    const frac = pos - Math.floor(pos);
    phase[b0] += profile[i] * (1 - frac);
    counts[b0] += 1 - frac;
    phase[b1] += profile[i] * frac;
    counts[b1] += frac;
  }

  let mean = 0;
  for (let b = 0; b < bins; b++) {
    if (counts[b] > 0) phase[b] /= counts[b];
    mean += phase[b];
  }
  mean /= bins;

  let bestO = 0;
  let bestVal = -Infinity;
  for (let b = 0; b < bins; b++) {
    const prev = phase[(b - 1 + bins) % bins];
    const next = phase[(b + 1) % bins];
    const smoothed = 0.25 * prev + 0.5 * phase[b] + 0.25 * next;
    if (smoothed > bestVal) {
      bestVal = smoothed;
      bestO = b;
    }
  }

  // Sub-bin quadratic peak refinement
  const prev = phase[(bestO - 1 + bins) % bins];
  const curr = phase[bestO];
  const next = phase[(bestO + 1) % bins];
  const denom = prev - 2 * curr + next;
  let subOffset = bestO;
  if (Math.abs(denom) > 1e-9) {
    const delta = (0.5 * (prev - next)) / denom;
    if (Math.abs(delta) <= 1) {
      subOffset = ((bestO + delta) % period + period) % period;
    }
  }

  return {
    bestOffset: Math.round(subOffset * 10) / 10,
    peakScore: mean > 0 ? bestVal / mean : 0,
  };
}

export function detectGrid(
  img: HTMLImageElement | HTMLVideoElement
): GridDetectionResult | null {
  const w = img instanceof HTMLVideoElement ? img.videoWidth : img.width;
  const h = img instanceof HTMLVideoElement ? img.videoHeight : img.height;
  if (w < 64 || h < 64) return null;

  const off = document.createElement('canvas');
  off.width = w;
  off.height = h;
  const octx = off.getContext('2d', { willReadFrequently: true });
  if (!octx) return null;

  octx.drawImage(img, 0, 0);
  const data = octx.getImageData(0, 0, w, h).data;

  const colProfile = new Float64Array(w);
  const rowProfile = new Float64Array(h);

  const stepY = Math.max(1, Math.floor(h / 400));
  let rowSamples = 0;
  for (let y = 0; y < h; y += stepY) {
    rowSamples++;
    const rowBase = y * w;
    for (let x = 2; x < w - 2; x++) {
      const i = (rowBase + x) * 4;
      const iL = i - 8;
      const iR = i + 8;
      const lC = data[i] * 0.3 + data[i + 1] * 0.59 + data[i + 2] * 0.11;
      const lL = data[iL] * 0.3 + data[iL + 1] * 0.59 + data[iL + 2] * 0.11;
      const lR = data[iR] * 0.3 + data[iR + 1] * 0.59 + data[iR + 2] * 0.11;
      colProfile[x] += Math.abs(lC - 0.5 * (lL + lR));
    }
  }
  for (let x = 0; x < w; x++) colProfile[x] /= rowSamples;

  const stepX = Math.max(1, Math.floor(w / 400));
  let colSamples = 0;
  for (let x = 0; x < w; x += stepX) {
    colSamples++;
    for (let y = 2; y < h - 2; y++) {
      const i = (y * w + x) * 4;
      const iU = ((y - 2) * w + x) * 4;
      const iD = ((y + 2) * w + x) * 4;
      const lC = data[i] * 0.3 + data[i + 1] * 0.59 + data[i + 2] * 0.11;
      const lU = data[iU] * 0.3 + data[iU + 1] * 0.59 + data[iU + 2] * 0.11;
      const lD = data[iD] * 0.3 + data[iD + 1] * 0.59 + data[iD + 2] * 0.11;
      rowProfile[y] += Math.abs(lC - 0.5 * (lU + lD));
    }
  }
  for (let y = 0; y < h; y++) rowProfile[y] /= colSamples;

  const cx = centerAndVariance(colProfile);
  const cy = centerAndVariance(rowProfile);
  if (cx.variance < 1e-4 && cy.variance < 1e-4) return null;

  const minP = 16;
  const maxP = Math.min(256, Math.floor(Math.min(w, h) / 3));
  if (maxP <= minP) return null;

  const scores = new Float64Array(maxP + 1);
  let maxScore = -Infinity;

  for (let p = minP; p <= maxP; p++) {
    let sumX = 0;
    const lenX = w - p;
    for (let x = 0; x < lenX; x++) sumX += cx.centered[x] * cx.centered[x + p];
    const corrX = cx.variance > 1e-4 ? sumX / (lenX * cx.variance) : 0;

    let sumY = 0;
    const lenY = h - p;
    for (let y = 0; y < lenY; y++) sumY += cy.centered[y] * cy.centered[y + p];
    const corrY = cy.variance > 1e-4 ? sumY / (lenY * cy.variance) : 0;

    const score = 0.5 * (corrX + corrY);
    scores[p] = score;
    if (score > maxScore) maxScore = score;
  }

  if (maxScore < 0.12) return null;

  // Prefer the smallest local peak that achieves at least 72% of maxScore (avoids 2x multiples)
  let coarseP = minP;
  const threshold = maxScore * 0.72;
  for (let p = minP; p <= maxP; p++) {
    const prev = p > minP ? scores[p - 1] : -Infinity;
    const next = p < maxP ? scores[p + 1] : -Infinity;
    if (scores[p] >= prev && scores[p] >= next && scores[p] >= threshold) {
      coarseP = p;
      break;
    }
  }

  // Sub-pixel period refinement using phase-folded peak sharpness
  let bestP = coarseP;
  let bestSharpness = -Infinity;
  let bestOffsetX = 0;
  let bestOffsetY = 0;

  const searchStart = Math.max(minP, coarseP - 1.5);
  const searchEnd = Math.min(maxP, coarseP + 1.5);

  for (let p = searchStart; p <= searchEnd + 1e-6; p += 0.05) {
    const fx = foldPhase(colProfile, p);
    const fy = foldPhase(rowProfile, p);
    const sharpness = fx.peakScore + fy.peakScore;
    if (sharpness > bestSharpness) {
      bestSharpness = sharpness;
      bestP = Math.round(p * 100) / 100;
      bestOffsetX = fx.bestOffset;
      bestOffsetY = fy.bestOffset;
    }
  }

  return {
    size: bestP,
    offsetX: bestOffsetX,
    offsetY: bestOffsetY,
    confidence: maxScore,
  };
}
