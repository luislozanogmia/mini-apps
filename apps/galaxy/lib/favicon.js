'use strict';

// Builds a tiny 16x16 ICO in memory (a solid planet-blue dot) — no image
// libraries, no external asset file, no new npm dependency. The ICO format
// is simple enough at this size to assemble by hand from documented byte
// layouts (ICONDIR + ICONDIRENTRY + a 32bpp BITMAPINFOHEADER DIB).

const SIZE = 16;
const COLOR = { r: 0x4f, g: 0xd1, b: 0xff }; // #4fd1ff, same blue as the rtx planet

function buildFaviconIco() {
  const pixelBytes = Buffer.alloc(SIZE * SIZE * 4);
  const center = (SIZE - 1) / 2;
  const radius = SIZE / 2 - 1;

  // DIB pixel rows are stored bottom-up.
  for (let row = 0; row < SIZE; row += 1) {
    const y = SIZE - 1 - row;
    for (let x = 0; x < SIZE; x += 1) {
      const dx = x - center;
      const dy = y - center;
      const inCircle = Math.sqrt(dx * dx + dy * dy) <= radius;
      const offset = (row * SIZE + x) * 4;
      if (inCircle) {
        pixelBytes[offset] = COLOR.b;
        pixelBytes[offset + 1] = COLOR.g;
        pixelBytes[offset + 2] = COLOR.r;
        pixelBytes[offset + 3] = 0xff;
      }
      // else left zeroed: fully transparent (alpha channel carries this)
    }
  }

  // 1bpp AND mask, rows padded to a 4-byte boundary. Left all-zero — real
  // transparency comes from the alpha channel above, which modern favicon
  // consumers (Chrome, Windows shell) both respect.
  const maskRowBytes = Math.ceil(SIZE / 8 / 4) * 4;
  const andMask = Buffer.alloc(maskRowBytes * SIZE, 0);

  const dibHeader = Buffer.alloc(40);
  dibHeader.writeUInt32LE(40, 0);                  // biSize
  dibHeader.writeInt32LE(SIZE, 4);                 // biWidth
  dibHeader.writeInt32LE(SIZE * 2, 8);              // biHeight (XOR + AND halves, per ICO spec)
  dibHeader.writeUInt16LE(1, 12);                  // biPlanes
  dibHeader.writeUInt16LE(32, 14);                 // biBitCount
  dibHeader.writeUInt32LE(0, 16);                  // biCompression = BI_RGB
  dibHeader.writeUInt32LE(pixelBytes.length, 20);   // biSizeImage

  const imageData = Buffer.concat([dibHeader, pixelBytes, andMask]);

  const iconDir = Buffer.alloc(6);
  iconDir.writeUInt16LE(0, 0); // reserved
  iconDir.writeUInt16LE(1, 2); // type = icon
  iconDir.writeUInt16LE(1, 4); // image count

  const entry = Buffer.alloc(16);
  entry.writeUInt8(SIZE, 0);   // width
  entry.writeUInt8(SIZE, 1);   // height
  entry.writeUInt8(0, 2);      // color count (0 = no palette, true color)
  entry.writeUInt8(0, 3);      // reserved
  entry.writeUInt16LE(1, 4);   // color planes
  entry.writeUInt16LE(32, 6);  // bits per pixel
  entry.writeUInt32LE(imageData.length, 8);              // bytes in resource
  entry.writeUInt32LE(iconDir.length + entry.length, 12); // offset to image data

  return Buffer.concat([iconDir, entry, imageData]);
}

const FAVICON_ICO = buildFaviconIco();

module.exports = { FAVICON_ICO };
