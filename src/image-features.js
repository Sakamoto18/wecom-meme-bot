import { Jimp } from 'jimp';

const FEATURE_SIZE = 24;

function cropViews(image) {
  const { width, height } = image.bitmap;
  const views = [image.clone()];

  if (height >= 80) {
    views.push(image.clone().crop({
      x: 0,
      y: 0,
      w: width,
      h: Math.max(1, Math.round(height * 0.78)),
    }));
  }

  if (width >= 120 && width > height * 1.15) {
    const cropWidth = Math.round(width * 0.72);
    views.push(image.clone().crop({
      x: width - cropWidth,
      y: 0,
      w: cropWidth,
      h: height,
    }));
  }

  return views.slice(0, 3);
}

function vectorFromView(view) {
  view.cover({ w: FEATURE_SIZE, h: FEATURE_SIZE });
  const luminance = new Float32Array(FEATURE_SIZE * FEATURE_SIZE);
  let chromaTotal = 0;

  for (let index = 0; index < luminance.length; index += 1) {
    const offset = index * 4;
    const red = view.bitmap.data[offset];
    const green = view.bitmap.data[offset + 1];
    const blue = view.bitmap.data[offset + 2];
    const alpha = view.bitmap.data[offset + 3] / 255;
    const value = (0.299 * red + 0.587 * green + 0.114 * blue) * alpha + 255 * (1 - alpha);
    luminance[index] = value / 255;
    chromaTotal += (Math.max(red, green, blue) - Math.min(red, green, blue)) / 255;
  }

  let mean = 0;
  for (const value of luminance) mean += value;
  mean /= luminance.length;

  let variance = 0;
  for (const value of luminance) variance += (value - mean) ** 2;
  const deviation = Math.sqrt(variance / luminance.length) || 1;

  const normalized = new Float32Array(luminance.length);
  for (let index = 0; index < luminance.length; index += 1) {
    normalized[index] = (luminance[index] - mean) / deviation;
  }

  const edges = new Float32Array((FEATURE_SIZE - 1) * (FEATURE_SIZE - 1) * 2);
  let edgeIndex = 0;
  for (let y = 0; y < FEATURE_SIZE - 1; y += 1) {
    for (let x = 0; x < FEATURE_SIZE - 1; x += 1) {
      const position = y * FEATURE_SIZE + x;
      edges[edgeIndex] = luminance[position + 1] - luminance[position];
      edges[edgeIndex + 1] = luminance[position + FEATURE_SIZE] - luminance[position];
      edgeIndex += 2;
    }
  }

  let edgeMagnitude = 0;
  for (const value of edges) edgeMagnitude += value * value;
  edgeMagnitude = Math.sqrt(edgeMagnitude) || 1;
  for (let index = 0; index < edges.length; index += 1) {
    edges[index] /= edgeMagnitude;
  }

  const histogram = new Float32Array(16);
  for (const value of luminance) {
    histogram[Math.min(15, Math.floor(value * 16))] += 1 / luminance.length;
  }

  return {
    normalized,
    edges,
    histogram,
    chroma: chromaTotal / luminance.length,
  };
}

export async function extractImageFeatures(input) {
  const image = await Jimp.read(input);
  return cropViews(image).map(vectorFromView);
}

function correlationDistance(left, right) {
  let correlation = 0;
  for (let index = 0; index < left.length; index += 1) {
    correlation += left[index] * right[index];
  }
  correlation /= left.length;
  return Math.max(0, Math.min(1, (1 - correlation) / 2));
}

function edgeDistance(left, right) {
  let correlation = 0;
  for (let index = 0; index < left.length; index += 1) {
    correlation += left[index] * right[index];
  }
  return Math.max(0, Math.min(1, (1 - correlation) / 2));
}

function histogramDistance(left, right) {
  let distance = 0;
  for (let index = 0; index < left.length; index += 1) {
    distance += Math.abs(left[index] - right[index]);
  }
  return Math.min(1, distance / 2);
}

function viewDistance(left, right) {
  const structure = correlationDistance(left.normalized, right.normalized);
  const edges = edgeDistance(left.edges, right.edges);
  const histogram = histogramDistance(left.histogram, right.histogram);
  const chroma = Math.abs(left.chroma - right.chroma);
  return structure * 0.62 + edges * 0.2 + histogram * 0.1 + chroma * 0.08;
}

export function minimumFeatureDistance(candidateViews, referenceSets) {
  let minimum = Number.POSITIVE_INFINITY;
  for (const candidate of candidateViews) {
    for (const referenceViews of referenceSets) {
      for (const reference of referenceViews) {
        minimum = Math.min(minimum, viewDistance(candidate, reference));
      }
    }
  }
  return minimum;
}
