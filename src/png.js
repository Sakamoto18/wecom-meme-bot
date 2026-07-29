import { deflateSync } from 'node:zlib';

const CRC_TABLE = new Uint32Array(256);
for (let value = 0; value < 256; value += 1) {
  let crc = value;
  for (let bit = 0; bit < 8; bit += 1) {
    crc = (crc & 1) === 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
  }
  CRC_TABLE[value] = crc >>> 0;
}

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data = Buffer.alloc(0)) {
  const typeBuffer = Buffer.from(type, 'ascii');
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])));
  return Buffer.concat([length, typeBuffer, data, checksum]);
}

export function createSmileyPng(width = 360, height = 360) {
  const stride = width * 4 + 1;
  const pixels = Buffer.alloc(stride * height);
  const centerX = width / 2;
  const centerY = height * 0.42;
  const faceRadius = width * 0.3;

  for (let y = 0; y < height; y += 1) {
    const rowOffset = y * stride;
    pixels[rowOffset] = 0;

    for (let x = 0; x < width; x += 1) {
      const offset = rowOffset + 1 + x * 4;
      const gradient = (x + y) / (width + height);
      let red = 255;
      let green = Math.round(229 - 90 * gradient);
      let blue = Math.round(107 - 6 * gradient);

      const dx = x - centerX;
      const dy = y - centerY;
      if (dx * dx + dy * dy <= faceRadius * faceRadius) {
        red = 255;
        green = 248;
        blue = 223;

        const eyeY = centerY - faceRadius * 0.2;
        const leftEyeX = centerX - faceRadius * 0.33;
        const rightEyeX = centerX + faceRadius * 0.33;
        const eyeRadius = faceRadius * 0.09;
        const inLeftEye = (x - leftEyeX) ** 2 + (y - eyeY) ** 2 <= eyeRadius ** 2;
        const inRightEye = (x - rightEyeX) ** 2 + (y - eyeY) ** 2 <= eyeRadius ** 2;

        const mouthHalfWidth = faceRadius * 0.5;
        const mouthY = centerY + faceRadius * 0.5 - (dx * dx) / (mouthHalfWidth * 5);
        const onSmile = Math.abs(dx) <= mouthHalfWidth && Math.abs(y - mouthY) <= faceRadius * 0.045;

        if (inLeftEye || inRightEye || onSmile) {
          red = 39;
          green = 39;
          blue = 39;
        }
      }

      pixels[offset] = red;
      pixels[offset + 1] = green;
      pixels[offset + 2] = blue;
      pixels[offset + 3] = 255;
    }
  }

  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 6;

  return Buffer.concat([
    Buffer.from('89504e470d0a1a0a', 'hex'),
    pngChunk('IHDR', header),
    pngChunk('IDAT', deflateSync(pixels, { level: 9 })),
    pngChunk('IEND'),
  ]);
}
