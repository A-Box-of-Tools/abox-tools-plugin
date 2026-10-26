import { withBrowser } from './browser.mjs';
import { supportedImage } from './exif.mjs';
import { MAX_INPUT_BYTES, readInput, newOutput, writeNew, requireExtension } from './files.mjs';
import { MAX_IMAGE_PIXELS } from './image.mjs';
import { AdapterError } from './errors.mjs';

export const MAX_SVG_SIDE = 16_384;
const MIME = { jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp' };

function settings(args) {
  const format = args.format ?? 'png';
  const quality = args.quality ?? 0.92;
  const fit = args.fit ?? 'fit';
  const background = args.background ?? (format === 'jpeg' ? '#ffffff' : null);
  if (!Object.hasOwn(MIME, format) || !['fit', 'pad', 'stretch'].includes(fit)
      || typeof quality !== 'number' || !Number.isFinite(quality) || quality < 0 || quality > 1
      || (background !== null && (typeof background !== 'string' || !/^#[0-9a-f]{6}$/i.test(background)))) {
    throw new AdapterError('INVALID_ARGUMENTS', 'Choose PNG/JPEG/WebP, fit/pad/stretch, quality between 0 and 1, and an optional six-digit background color.');
  }
  for (const name of ['width', 'height']) {
    if (args[name] !== undefined && (!Number.isSafeInteger(args[name]) || args[name] < 1 || args[name] > MAX_SVG_SIDE)) {
      throw new AdapterError('IMAGE_DIMENSIONS', 'SVG output dimensions must be integer pixels between 1 and 16384.');
    }
  }
  if (args.width && args.height && args.width * args.height > MAX_IMAGE_PIXELS) throw new AdapterError('IMAGE_DIMENSIONS', 'The SVG output exceeds the 80 megapixel limit.');
  return { format, quality, fit, background, width: args.width ?? null, height: args.height ?? null };
}

export async function svgToImage(args, options = {}) {
  options.signal?.throwIfAborted();
  const plan = settings(args);
  const input = await readInput(args.input_path);
  const output = await newOutput(args.output_path);
  const mime = MIME[plan.format];
  requireExtension(output, mime);
  const made = await withBrowser(async page => {
    await page.locator('#input').setInputFiles({ name: 'source.svg', mimeType: 'image/svg+xml', buffer: input.data });
    return page.evaluate(async ({ settings, mime, maxPixels, maxBytes, maxSide }) => {
      const { decodeSvgText, intrinsicSize } = await import('/vendor/abox/tools/svg-to-image/src/svg.js');
      const sizing = await import('/vendor/abox/tools/svg-to-image/src/sizing.js');
      const rendering = await import('/vendor/abox/tools/svg-to-image/src/render.js');
      const { svgLinksAssets, cssLinksAssets } = await import('/vendor/abox/tools/svg-to-image/src/svg-linked-assets.js');
      const codecs = await import('/vendor/abox/shared/js/image-convert.js');
      const { readBytes } = await import('/vendor/abox/tools/exif-editor/src/container.js');
      const refuse = (code, message) => ({ error: { code, message } });
      const text = decodeSvgText(await document.querySelector('#input').files[0].arrayBuffer());
      // The unchanged website renderer uses SVG secure static image mode. The
      // adapter additionally refuses features that an unattended export could
      // otherwise omit or capture at an unpredictable animation frame.
      if (/<!\s*(?:DOCTYPE|ENTITY)\b/i.test(text)) return refuse('UNSUPPORTED_SVG', 'DTD and entity declarations are unsupported. Use a self-contained static SVG.');
      const xml = new DOMParser().parseFromString(text, 'image/svg+xml');
      if (xml.getElementsByTagName('parsererror').length || xml.documentElement?.localName !== 'svg') {
        return refuse('INVALID_SVG', 'The input is not a well-formed uncompressed SVG document.');
      }
      const active = new Set(['script', 'foreignobject', 'animate', 'animatecolor', 'animatemotion', 'animatetransform', 'set', 'discard']);
      const embeddedDimensions = image => {
        const view = bytes => new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        if (image.kind === 'png') {
          const data = image.doc.chunks.find(chunk => chunk.type === 'IHDR')?.data;
          if (data?.length === 13) return { width: view(data).getUint32(0), height: view(data).getUint32(4) };
        } else if (image.kind === 'jpeg') {
          const frames = image.doc.segments.filter(segment => [0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(segment.marker));
          if (frames.length === 1 && frames[0].payload.length >= 6) {
            return { width: view(frames[0].payload).getUint16(3), height: view(frames[0].payload).getUint16(1) };
          }
        } else if (image.kind === 'webp') {
          const dimensions = [];
          for (const { fourcc, data } of image.doc.chunks) {
            if (fourcc === 'VP8X' && data.length >= 10) {
              const uint24 = at => data[at] | (data[at + 1] << 8) | (data[at + 2] << 16);
              dimensions.push({ width: uint24(4) + 1, height: uint24(7) + 1 });
            } else if (fourcc === 'VP8 ' && data.length >= 10 && data[3] === 0x9d && data[4] === 1 && data[5] === 0x2a) {
              dimensions.push({ width: view(data).getUint16(6, true) & 0x3fff, height: view(data).getUint16(8, true) & 0x3fff });
            } else if (fourcc === 'VP8L' && data.length >= 5 && data[0] === 0x2f) {
              const bits = view(data).getUint32(1, true);
              dimensions.push({ width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 });
            }
          }
          if (dimensions.length && dimensions.every(size => size.width === dimensions[0].width && size.height === dimensions[0].height)) return dimensions[0];
        }
        return null;
      };
      const unsupportedCss = css => {
        const plain = String(css).replace(/\/\*[\s\S]*?\*\//g, ' ');
        return /\\|@\s*(?:import|(?:-webkit-)?keyframes)\b|(?:^|[;{])\s*(?:-webkit-)?(?:animation|transition)(?:-[a-z-]+)?\s*:/i.test(plain)
          || /(?:^|[^\w-])(?:-webkit-)?(?:image-set|image|cross-fade)\s*\(/i.test(plain)
          || /data\s*:/i.test(plain) || cssLinksAssets(css);
      };
      for (const node of xml.childNodes) {
        if (node.nodeType === 7) return refuse('UNSUPPORTED_SVG', 'SVG processing instructions and linked stylesheets are unsupported.');
      }
      for (const node of xml.getElementsByTagName('*')) {
        if (active.has(node.localName.toLowerCase())) return refuse('UNSUPPORTED_SVG', 'Scripts, foreignObject and SVG animation are unsupported. Use a static SVG.');
        if (node.localName.toLowerCase() === 'style' && unsupportedCss(node.textContent)) {
          return refuse('UNSUPPORTED_SVG', 'External or embedded CSS resources, CSS escapes, imports and animation are unsupported.');
        }
        for (const attribute of node.attributes) {
          const name = attribute.localName.toLowerCase();
          const value = attribute.value.trim();
          if (/^on/i.test(name) || attribute.name.toLowerCase() === 'xml:base') return refuse('UNSUPPORTED_SVG', 'Event handlers and xml:base are unsupported.');
          if (name === 'href' && value && !value.startsWith('#')) {
            const embedded = /^data:image\/(png|jpeg|webp);base64,([a-z0-9+/=\s]+)$/i.exec(value);
            const embeddedRaster = ['image', 'feimage'].includes(node.localName.toLowerCase()) && embedded;
            if (!embeddedRaster) return refuse('SVG_EXTERNAL_RESOURCE', 'The SVG references an unsupported resource. Embed a raster image or use an internal fragment.');
            try {
              const bytes = Uint8Array.from(atob(embedded[2].replace(/\s/g, '')), character => character.charCodeAt(0));
              const image = await readBytes(bytes);
              if (!image.ok || image.kind !== embedded[1].toLowerCase()
                  || image.doc.chunks?.some(chunk => ['acTL', 'ANIM', 'ANMF'].includes(chunk.type ?? chunk.fourcc))) {
                return refuse('UNSUPPORTED_SVG', 'Embedded SVG resources must be supported still raster images matching their declared format.');
              }
              const size = embeddedDimensions(image);
              if (!size || !Number.isSafeInteger(size.width) || !Number.isSafeInteger(size.height)
                  || size.width < 1 || size.height < 1 || size.width * size.height > maxPixels) {
                return refuse('IMAGE_DIMENSIONS', 'An embedded SVG raster exceeds the 80 megapixel limit or has unsupported dimensions.');
              }
            } catch {
              return refuse('UNSUPPORTED_SVG', 'An embedded SVG raster resource could not be verified.');
            }
          } else if (unsupportedCss(value)) {
            return refuse('SVG_EXTERNAL_RESOURCE', 'External resources, CSS escapes and animation are unsupported in SVG attributes.');
          }
        }
      }
      if (svgLinksAssets(text)) return refuse('SVG_EXTERNAL_RESOURCE', 'The SVG references external resources. Use a self-contained SVG.');
      const intrinsic = intrinsicSize(text);
      if (!intrinsic) return refuse('INVALID_SVG', 'The SVG root could not be read by the existing renderer.');
      const laid = sizing.planSize(intrinsic, settings.width || settings.height
        ? { mode: 'box', width: settings.width, height: settings.height, fit: settings.fit }
        : { mode: 'scale', scale: 1 });
      if (!sizing.checkLimits(laid).ok || laid.width > maxSide || laid.height > maxSide
          || !Number.isSafeInteger(laid.width) || !Number.isSafeInteger(laid.height) || laid.width * laid.height > maxPixels) {
        return refuse('IMAGE_DIMENSIONS', 'The SVG output exceeds the 16384-pixel side or 80 megapixel limit.');
      }
      if (!(await rendering.encodableTypes()).has(mime)) return refuse('ENCODER_UNSUPPORTED', 'The installed browser cannot encode the requested image format.');
      let held, canvas, checked, sample;
      try {
        held = await rendering.loadAt(text, laid.draw.width, laid.draw.height, { stretch: laid.stretch });
        canvas = rendering.draw(held.image, laid, { background: settings.background });
        const blob = await rendering.encode(canvas, mime, settings.quality);
        if (blob.type !== mime) return refuse('VERIFICATION_FAILED', 'The encoder returned a different image format.');
        if (!blob.size || blob.size > maxBytes) return refuse('OUTPUT_SIZE', 'The raster output exceeds the 128 MiB limit.');
        checked = await codecs.decode(blob);
        if (checked.width !== laid.width || checked.height !== laid.height) return refuse('VERIFICATION_FAILED', 'The raster output dimensions could not be verified.');
        sample = document.createElement('canvas'); sample.width = 1; sample.height = 1;
        const read = sample.getContext('2d', { willReadFrequently: true });
        const expected = canvas.getContext('2d', { willReadFrequently: true });
        let samples = 0;
        for (let row = 0; row < 5; row++) {
          for (let column = 0; column < 5; column++) {
            const x = Math.round((laid.width - 1) * column / 4), y = Math.round((laid.height - 1) * row / 4);
            read.clearRect(0, 0, 1, 1);
            read.drawImage(checked.bitmap, x, y, 1, 1, 0, 0, 1, 1);
            const actual = read.getImageData(0, 0, 1, 1).data;
            if (mime === 'image/jpeg' && actual[3] !== 255) return refuse('VERIFICATION_FAILED', 'JPEG output did not decode as opaque pixels.');
            if (mime === 'image/png') {
              const wanted = expected.getImageData(x, y, 1, 1).data;
              if (Math.abs(actual[3] - wanted[3]) > 1 || [0, 1, 2].some(channel => Math.abs(actual[channel] * actual[3] / 255 - wanted[channel] * wanted[3] / 255) > 1)) {
                return refuse('VERIFICATION_FAILED', 'PNG output did not preserve its rendered pixels and transparency.');
              }
              samples++;
            }
          }
        }
        const data = await new Promise((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(reader.result.split(',')[1]);
          reader.onerror = () => reject(new Error('Raster output could not be read.'));
          reader.readAsDataURL(blob);
        });
        return { data, width: laid.width, height: laid.height, padded: laid.padded, stretched: laid.stretch,
          intrinsic_width: intrinsic.width, intrinsic_height: intrinsic.height, intrinsic_source: intrinsic.source,
          verification: { format: true, dimensions: true, decoded: true, png_pixel_samples: samples } };
      } catch {
        return refuse('SVG_RENDER_FAILED', 'The installed browser could not render or encode this SVG.');
      } finally {
        held?.release(); codecs.release(checked?.bitmap);
        if (canvas) { canvas.width = 0; canvas.height = 0; }
        if (sample) { sample.width = 0; sample.height = 0; }
      }
    }, { settings: plan, mime, maxPixels: MAX_IMAGE_PIXELS, maxBytes: MAX_INPUT_BYTES, maxSide: MAX_SVG_SIDE });
  }, options);
  if (made.error) throw new AdapterError(made.error.code, made.error.message);
  const data = Buffer.from(made.data, 'base64');
  const checked = await supportedImage(data);
  if (checked.kind !== plan.format || !data.length || data.length > MAX_INPUT_BYTES) throw new AdapterError('VERIFICATION_FAILED', 'The raster output format or byte limit could not be verified.');
  delete made.data;
  options.signal?.throwIfAborted();
  await writeNew(output, data);
  return { ok: true, operation: 'svg-to-image', input_path: input.path, output_path: output,
    input_bytes: input.data.length, output_bytes: data.length, format: plan.format, verified: true,
    ...made, fit: plan.fit, quality: plan.format === 'png' ? null : plan.quality, background: plan.background,
    warnings: ['SVG text uses locally available fonts. Rasterization can change colors and precision; source metadata is not copied.',
      ...(plan.format === 'jpeg' ? [`Transparency is composited over ${plan.background}.`] : [])],
  };
}
