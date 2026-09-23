/**
 * tools/make-icon.mjs —— 生成应用图标与托盘图标（**纯 Node，零依赖**）
 * =====================================================================
 * 为什么自己画而不是找一张图：
 *   · 这个工程没有图片资源，也不该为了一个图标引入图像库；
 *   · 图标必须**可复现**——它是从代码生成的，改一处颜色重跑一次就一致，
 *     不会出现"源文件丢了、只剩一个二进制"的情况；
 *   · PNG 与 ICO 两个格式都用 Node 内置的 zlib 手写编码，
 *     一共一百多行，比引一个依赖便宜。
 *
 * 产出：
 *   build/icon.ico                     打包用（256/128/64/48/32/16，PNG-in-ICO）
 *   src/renderer/assets/tray.png       托盘用（32×32，Electron 自己缩放到 16）
 *
 * 画的是什么：一张"玻璃卡片"上排着三行条目，第一行左边有一道蓝色标记。
 *   16px 下要能认出来，所以**小尺寸换一套更粗更少的笔画**（见 strokesFor），
 *   而不是把 256px 的图硬缩下去 —— 那种缩法在托盘里会糊成一团噪点。
 * =====================================================================
 */

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));

/* ------------------------------------------------------------------ */
/* PNG 编码（RGBA，无隔行）                                             */
/* ------------------------------------------------------------------ */

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i += 1) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

/** RGBA 像素缓冲（width*height*4）→ PNG 字节 */
function encodePng(rgba, width, height) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type: RGBA
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // interlace

  // 每行前面加一个 filter 字节（0 = None）
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y += 1) {
    raw[y * (stride + 1)] = 0;
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, y * stride + stride);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/* ------------------------------------------------------------------ */
/* 画图（4× 超采样 + 盒式降采样 = 免费抗锯齿）                           */
/* ------------------------------------------------------------------ */

const SS = 4; // 超采样倍数

/** 圆角矩形的内部判定（归一化坐标） */
function insideRoundRect(x, y, r) {
  const { x0, y0, x1, y1, rad } = r;
  if (x < x0 || x > x1 || y < y0 || y > y1) return false;
  const cx = Math.min(Math.max(x, x0 + rad), x1 - rad);
  const cy = Math.min(Math.max(y, y0 + rad), y1 - rad);
  const dx = x - cx;
  const dy = y - cy;
  return dx * dx + dy * dy <= rad * rad;
}

function mix(a, b, t) {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}

/**
 * 不同尺寸用不同笔画。
 * ⚠️ 这一条是图标能不能用的关键：256px 上好看的三条细线，
 *    缩到 16px 会变成三条灰糊糊的噪点。小尺寸必须**少画、画粗**。
 */
function strokesFor(size) {
  if (size <= 24) {
    return [
      { y: 0.30, h: 0.15, x0: 0.20, x1: 0.80, accent: true },
      { y: 0.56, h: 0.15, x0: 0.20, x1: 0.66, accent: false },
    ];
  }
  return [
    { y: 0.26, h: 0.10, x0: 0.20, x1: 0.80, accent: true },
    { y: 0.45, h: 0.10, x0: 0.20, x1: 0.80, accent: false },
    { y: 0.64, h: 0.10, x0: 0.20, x1: 0.62, accent: false },
  ];
}

/** 画一张 size×size 的 RGBA 图 */
function render(size) {
  const N = size * SS;
  const out = Buffer.alloc(size * size * 4);

  const card = { x0: 0.05, y0: 0.05, x1: 0.95, y1: 0.95, rad: 0.2 };
  const border = { x0: 0.045, y0: 0.045, x1: 0.955, y1: 0.955, rad: 0.205 };
  const TOP = [253, 254, 255];
  const BOTTOM = [230, 236, 247];
  const EDGE = [186, 197, 216];
  const INK = [58, 68, 88];
  const INK2 = [138, 149, 169];
  const ACCENT = [10, 111, 220];

  const strokes = strokesFor(size);

  for (let py = 0; py < size; py += 1) {
    for (let px = 0; px < size; px += 1) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      // 4× 超采样
      for (let sy = 0; sy < SS; sy += 1) {
        for (let sx = 0; sx < SS; sx += 1) {
          const x = (px * SS + sx + 0.5) / N;
          const y = (py * SS + sy + 0.5) / N;
          let c = null;
          let alpha = 0;

          if (insideRoundRect(x, y, border)) {
            // 描边：在外圈且不在内圈
            if (!insideRoundRect(x, y, card)) {
              c = EDGE;
              alpha = 1;
            } else {
              // 底色：竖向渐变（上亮下暗 = 光从上面来）
              const t = (y - card.y0) / (card.y1 - card.y0);
              c = mix(TOP, BOTTOM, Math.min(1, Math.max(0, t)));
              // 上沿 1 物理 px 受光
              if (y - card.y0 < 0.75 / size) c = mix(c, [255, 255, 255], 0.9);
              // 左上角高光（椭圆径向，与卡片同一套光影语言）
              const dx = (x - 0.18) / 0.75;
              const dy = (y - (-0.05)) / 0.6;
              const d = Math.sqrt(dx * dx + dy * dy);
              if (d < 1) c = mix(c, [255, 255, 255], 0.35 * (1 - d) * (1 - d));
              alpha = 1;
            }
          }

          // 条目笔画画在最上层
          for (const s of strokes) {
            if (y >= s.y && y <= s.y + s.h && x >= s.x0 && x <= s.x1) {
              const rad = s.h / 2;
              const cx = Math.min(Math.max(x, s.x0 + rad), s.x1 - rad);
              const cy = s.y + rad;
              const ddx = x - cx;
              const ddy = y - cy;
              if (ddx * ddx + ddy * ddy <= rad * rad) {
                // 第一行左边那一段用强调色（"有标记的条目"）
                const isAccent = s.accent && x <= s.x0 + 0.10;
                c = isAccent ? ACCENT : (s.accent ? INK : INK2);
                alpha = 1;
              }
            }
          }

          if (alpha > 0 && c) {
            r += c[0] * alpha;
            g += c[1] * alpha;
            b += c[2] * alpha;
            a += alpha;
          }
        }
      }
      const n = SS * SS;
      const i = (py * size + px) * 4;
      if (a > 0) {
        out[i] = Math.round(r / a);
        out[i + 1] = Math.round(g / a);
        out[i + 2] = Math.round(b / a);
        out[i + 3] = Math.round((a / n) * 255);
      }
    }
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* ICO 封装（Vista+ 允许直接内嵌 PNG）                                   */
/* ------------------------------------------------------------------ */
function encodeIco(entries) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2); // type = icon
  header.writeUInt16LE(entries.length, 4);

  const dir = Buffer.alloc(16 * entries.length);
  let offset = 6 + 16 * entries.length;
  entries.forEach((e, i) => {
    const o = i * 16;
    dir[o] = e.size >= 256 ? 0 : e.size; // 0 表示 256
    dir[o + 1] = e.size >= 256 ? 0 : e.size;
    dir[o + 2] = 0; // palette
    dir[o + 3] = 0; // reserved
    dir.writeUInt16LE(1, o + 4); // color planes
    dir.writeUInt16LE(32, o + 6); // bits per pixel
    dir.writeUInt32LE(e.png.length, o + 8);
    dir.writeUInt32LE(offset, o + 12);
    offset += e.png.length;
  });

  return Buffer.concat([header, dir, ...entries.map((e) => e.png)]);
}

/* ------------------------------------------------------------------ */
/* 跑                                                                  */
/* ------------------------------------------------------------------ */
const icoSizes = [256, 128, 64, 48, 32, 16];
const icoEntries = icoSizes.map((size) => ({ size, png: encodePng(render(size), size, size) }));

const buildDir = path.join(ROOT, 'build');
const assetsDir = path.join(ROOT, 'src', 'renderer', 'assets');
fs.mkdirSync(buildDir, { recursive: true });
fs.mkdirSync(assetsDir, { recursive: true });

const icoFile = path.join(buildDir, 'icon.ico');
fs.writeFileSync(icoFile, encodeIco(icoEntries));

const tray32 = path.join(assetsDir, 'tray.png');
fs.writeFileSync(tray32, encodePng(render(32), 32, 32));
const tray16 = path.join(assetsDir, 'tray-16.png');
fs.writeFileSync(tray16, encodePng(render(16), 16, 16));

/* `--preview` 额外导出一张 256 的大图。
   ⚠️ 存在的理由：图标这种东西**必须用眼睛看**。
      "文件字节数对、PNG 结构合法"完全可能是一张糊的图 ——
      而这个工程已经栽过好几次"生成了文件 ≠ 文件能用"。 */
if (process.argv.includes('--preview')) {
  const prev = path.join(buildDir, 'icon-preview-256.png');
  fs.writeFileSync(prev, encodePng(render(256), 256, 256));
  console.log('预览图：' + prev);
}

/* ⚠️ 自检：图标必须**真的**是能解开的 PNG/ICO，而不是"写了个文件"。
   这个项目的教训是"生成了文件"和"文件能用"是两件事。 */
function checkPng(file) {
  const b = fs.readFileSync(file);
  const sigOk = b.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  const w = b.readUInt32BE(16);
  const h = b.readUInt32BE(20);
  const iendOk = b.slice(-8).toString('ascii').includes('IEND');
  return { file: path.relative(ROOT, file), bytes: b.length, sigOk, w, h, iendOk };
}

const reports = [checkPng(tray32), checkPng(tray16)];
const ico = fs.readFileSync(icoFile);
const icoOk = ico.readUInt16LE(0) === 0 && ico.readUInt16LE(2) === 1 && ico.readUInt16LE(4) === icoSizes.length;

console.log('生成结果：');
for (const r of reports) {
  console.log(
    `  ${r.file.padEnd(32)} ${String(r.bytes).padStart(7)} B  ${r.w}×${r.h}  ` +
      (r.sigOk && r.iendOk ? '✔ 合法 PNG' : '✘ PNG 结构有问题'),
  );
}
console.log(
  `  build/icon.ico`.padEnd(34) +
    `${String(ico.length).padStart(7)} B  ${icoSizes.join('/')}  ` +
    (icoOk ? '✔ 合法 ICO' : '✘ ICO 头有问题'),
);

const bad = reports.some((r) => !r.sigOk || !r.iendOk) || !icoOk;
console.log(bad ? '\n✘ 有产出不合格' : '\n✔ 图标生成完毕');
process.exit(bad ? 1 : 0);
