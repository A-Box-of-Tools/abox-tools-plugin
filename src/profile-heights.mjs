import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { parseJson } from '../vendor/abox/shared/js/parse-json.js';
import { readInput, newOutput, writeNew } from './files.mjs';
import { withBrowser } from './browser.mjs';
import { supportedImage } from './exif.mjs';
import { rasterInputDimensions } from './raster-dimensions.mjs';
import { AdapterError } from './errors.mjs';

export const MAX_PREVIEW_CONFIG_BYTES = 64 * 1024;
export const MAX_PREVIEW_OUTPUT_BYTES = 32 * 1024 * 1024;
export const MAX_PREVIEW_SVG_BYTES = 2 * 1024 * 1024;
export const MAX_PREVIEW_SIDE = 8192;
export const MAX_PREVIEW_PIXELS = 16_000_000;
export const MAX_HEIGHT_FIGURES = 20;
export const MAX_PROFILE_PHOTO_BYTES = 20 * 1024 * 1024;
export const MAX_PROFILE_PHOTO_PIXELS = 4_000_000;
const MIME = { jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp' };
const own = (value, fallback) => value === undefined ? fallback : value;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const invalid = () => { throw new AdapterError('INVALID_CONFIG', 'The local preview configuration contains an unsupported field, value, measurement or schedule. Configuration contents are excluded from errors.'); };
const keys = (value, allowed) => { if (!object(value) || Object.keys(value).some(key => !allowed.includes(key))) invalid(); };
const color = value => typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value);
const integer = (value, low, high) => Number.isSafeInteger(value) && value >= low && value <= high;
function text(value, max) {
  if (typeof value !== 'string' || value.length > max) invalid();
  for (const character of value) {
    const point = character.codePointAt(0);
    if ((point < 32 && ![9, 10, 13].includes(point)) || point === 0xfffe || point === 0xffff || (point >= 0xd800 && point <= 0xdfff)) invalid();
  }
  return value;
}

async function configFile(filename) {
  const input = await readInput(filename, { max_bytes: MAX_PREVIEW_CONFIG_BYTES });
  let source, tree;
  try { source = new TextDecoder('utf-8', { fatal: true }).decode(input.data); }
  catch { throw new AdapterError('INVALID_UTF8', 'Preview configuration must contain valid UTF-8 JSON.'); }
  let depth = 0;
  for (let at = 0; at < source.length; at++) {
    if (source[at] === '"') for (at++; at < source.length; at++) {
      if (source[at] === '\\') at++;
      else if (source[at] === '"') break;
    }
    else if (source[at] === '{' || source[at] === '[') { if (++depth > 8) invalid(); }
    else if (source[at] === '}' || source[at] === ']') depth = Math.max(0, depth - 1);
  }
  try { tree = parseJson(source); } catch { invalid(); }
  const plain = node => {
    if (node.t === 'map') {
      const result = Object.create(null);
      for (const pair of node.pairs) {
        if (Object.hasOwn(result, pair.key)) invalid();
        result[pair.key] = plain(pair.value);
      }
      return result;
    }
    if (node.t === 'seq') return node.items.map(plain);
    if (node.t === 'num') return Number(node.raw);
    if (node.t === 'null') return null;
    return node.value;
  };
  return { path: input.path, bytes: input.data.length, value: plain(tree) };
}

function settings(args) {
  const format = own(args.format, 'png'), scale = own(args.scale, format === 'png' ? 2 : 1);
  if (!['png', 'svg'].includes(format) || !integer(scale, 1, 3) || (format === 'svg' && scale !== 1)) {
    throw new AdapterError('INVALID_ARGUMENTS', 'Choose PNG at scale 1–3 or SVG at its native scale of 1.');
  }
  return { format, scale };
}

function profileConfig(config) {
  keys(config, ['profile', 'surface', 'preview_time']);
  keys(config.profile, ['name', 'category', 'price', 'rating', 'reviews', 'address', 'serviceArea', 'phone', 'website',
    'description', 'attributes', 'status', 'clock', 'hours', 'photo']);
  const profile = config.profile;
  for (const [key, limit] of Object.entries({ name: 256, category: 256, address: 512, phone: 128, website: 512, description: 2000, attributes: 1000 })) {
    if (profile[key] !== undefined) text(profile[key], limit);
  }
  if ((profile.price !== undefined && (typeof profile.price !== 'string' || !/^\${0,4}$/.test(profile.price)))
      || (profile.serviceArea !== undefined && typeof profile.serviceArea !== 'boolean')
      || (profile.status !== undefined && !['auto', 'open24', 'temporary', 'permanent'].includes(profile.status))
      || (profile.clock !== undefined && !['12', '24'].includes(profile.clock))
      || (profile.photo !== undefined && profile.photo !== null)) invalid();
  if (profile.rating !== undefined && profile.rating !== '' && !(typeof profile.rating === 'number'
      && Number.isFinite(profile.rating) && profile.rating >= 0 && profile.rating <= 5)
      && !(typeof profile.rating === 'string' && /^(?:[0-4](?:\.\d{1,2})?|5(?:\.0{1,2})?)$/.test(profile.rating))) invalid();
  if (profile.reviews !== undefined && profile.reviews !== '' && !(integer(profile.reviews, 0, 1_000_000_000))
      && !(typeof profile.reviews === 'string' && /^\d{1,10}$/.test(profile.reviews) && Number(profile.reviews) <= 1_000_000_000)) invalid();
  if (profile.hours !== undefined) {
    if (!Array.isArray(profile.hours) || profile.hours.length !== 7) invalid();
    for (const day of profile.hours) {
      keys(day, ['closed', 'open', 'close']);
      if (typeof day.closed !== 'boolean' || typeof day.open !== 'string' || typeof day.close !== 'string'
          || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(day.open) || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(day.close)) invalid();
    }
  } else if (own(profile.status, 'auto') === 'auto') {
    throw new AdapterError('INVALID_CONFIG', 'Automatic business status requires all seven Sunday-first day schedules. Choose an explicit status when no schedule is supplied.');
  }
  const surface = own(config.surface, 'panel');
  if (!['panel', 'mobile', 'listing'].includes(surface)
      || (config.preview_time !== undefined && (typeof config.preview_time !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(config.preview_time)))) invalid();
  return { profile, surface, preview_time: config.preview_time ?? null };
}

function heightsConfig(config) {
  keys(config, ['figures', 'unit', 'plot_height', 'background', 'show_ruler', 'show_names']);
  const plan = { figures: config.figures, unit: own(config.unit, 'cm'), plot_height: own(config.plot_height, 600),
    background: own(config.background, '#ffffff'), show_ruler: own(config.show_ruler, true), show_names: own(config.show_names, true) };
  if (!Array.isArray(plan.figures) || plan.figures.length < 1 || plan.figures.length > MAX_HEIGHT_FIGURES
      || !['cm', 'ft'].includes(plan.unit) || !integer(plan.plot_height, 240, 1200)
      || !(plan.background === 'none' || color(plan.background))
      || typeof plan.show_ruler !== 'boolean' || typeof plan.show_names !== 'boolean') invalid();
  for (const figure of plan.figures) {
    keys(figure, ['name', 'height', 'shape', 'width', 'color']);
    text(figure.height, 64);
    if (figure.name !== undefined) text(figure.name, 160);
    const shape = own(figure.shape, 'man');
    if (!['man', 'woman', 'boy', 'girl', 'object'].includes(shape)
        || (figure.color !== undefined && !color(figure.color)) || (figure.width !== undefined && shape !== 'object')) invalid();
    if (figure.width !== undefined) text(figure.width, 64);
  }
  return plan;
}

async function labelsFromSource() {
  const markup = await readFile(new URL('../vendor/abox/tools/business-profile-preview/body.html', import.meta.url), 'utf8');
  const labels = Object.create(null);
  for (const match of markup.matchAll(/<span\s+data-phrase="([^"]+)">([\s\S]*?)<\/span>/g)) {
    if (/^(?:label\.|status\.|time\.|day\.)/.test(match[1]) || match[1] === 'sample.placeholder') labels[match[1]] = match[2];
  }
  if (!labels['label.website'] || !labels['sample.placeholder']) throw new AdapterError('PACKAGED_LABELS', 'The bundled profile preview labels are incomplete.');
  return labels;
}

async function photoInput(value) {
  if (value === undefined) return null;
  const input = await readInput(value, { max_bytes: MAX_PROFILE_PHOTO_BYTES }), image = await supportedImage(input.data);
  if (image.doc.chunks?.some(chunk => ['acTL', 'ANIM', 'ANMF'].includes(chunk.type ?? chunk.fourcc))) {
    throw new AdapterError('ANIMATED_IMAGE', 'A profile cover must be a still JPEG, PNG or WebP image.');
  }
  const size = rasterInputDimensions(image);
  if (!size || !integer(size.width, 8, 4096) || !integer(size.height, 8, 4096) || size.width * size.height > MAX_PROFILE_PHOTO_PIXELS) {
    throw new AdapterError('IMAGE_DIMENSIONS', 'Profile covers must have consistent dimensions of at least 8 pixels, at most 4096 per side and 4 megapixels.');
  }
  return { ...input, format: image.kind };
}

async function exportPreview(kind, args, options) {
  options.signal?.throwIfAborted();
  const plan = settings(args), output = await newOutput(args.output_path);
  if (path.extname(output).toLowerCase() !== `.${plan.format}`) throw new AdapterError('OUTPUT_EXTENSION', 'The output extension must match the selected PNG or SVG format.');
  const config = await configFile(args.config_path), model = kind === 'profile' ? profileConfig(config.value) : heightsConfig(config.value);
  const photo = kind === 'profile' ? await photoInput(args.photo_path) : null;
  const labels = kind === 'profile' ? await labelsFromSource() : null;
  const made = await withBrowser(async page => {
    if (photo) await page.locator('#input').setInputFiles({ name: `cover.${photo.format}`, mimeType: MIME[photo.format], buffer: photo.data });
    return page.evaluate(async ({ kind, model, plan, labels, hasPhoto, maxSide, maxPixels, maxSvgBytes, maxBytes }) => {
      const codecs = await import('/vendor/abox/shared/js/image-convert.js');
      const refuse = (code, message) => ({ error: { code, message } });
      let measureCanvas, drawn, encode, photoUri = null, svgUrl, checked, expectedCanvas, actualCanvas;
      try {
        measureCanvas = document.createElement('canvas');
        const measureContext = measureCanvas.getContext('2d');
        let font;
        const measure = (value, size, weight = 400) => { measureContext.font = `${weight} ${size}px ${font}`; return measureContext.measureText(value).width; };
        if (kind === 'profile') {
          const { normalise } = await import('/vendor/abox/tools/business-profile-preview/src/profile.js');
          const { describe } = await import('/vendor/abox/tools/business-profile-preview/src/view.js');
          const { SURFACES } = await import('/vendor/abox/tools/business-profile-preview/src/surfaces.js');
          const { FONT } = await import('/vendor/abox/tools/business-profile-preview/src/render.js');
          const { toPng } = await import('/vendor/abox/tools/business-profile-preview/src/raster.js');
          const { previewDate } = await import('/vendor/abox/tools/business-profile-preview/src/preview-time.js');
          font = FONT;
          const now = model.preview_time === null ? new Date() : previewDate(model.preview_time);
          if (!now) return refuse('INVALID_CONFIG', 'The chosen local preview date or time does not exist in this device time zone.');
          const words = Object.create(null), decoder = document.createElement('textarea');
          for (const [key, value] of Object.entries(labels)) { decoder.innerHTML = value; words[key] = decoder.value; }
          if (hasPhoto) {
            const { readPhoto } = await import('/vendor/abox/tools/business-profile-preview/src/photo.js');
            photoUri = (await readPhoto(document.querySelector('#input').files[0])).uri;
          }
          const profile = normalise({ ...model.profile, photo: photoUri });
          drawn = SURFACES[model.surface](describe(profile, words, now), measure);
          encode = () => toPng(drawn, plan.scale);
        } else {
          const { chartSvg, FONT, isDark } = await import('/vendor/abox/tools/compare-heights/src/chart.js');
          const { shapeOf } = await import('/vendor/abox/tools/compare-heights/src/figures.js');
          const { chartMeasurements } = await import('/vendor/abox/tools/compare-heights/src/chart-measurements.js');
          const { format } = await import('/vendor/abox/tools/compare-heights/src/units.js');
          const { svgToPng } = await import('/vendor/abox/tools/compare-heights/src/save.js');
          font = FONT;
          const figures = [];
          for (const figure of model.figures) {
            const shape = shapeOf(figure.shape ?? 'man');
            const measured = chartMeasurements(figure.height, figure.width ?? '', model.unit, shape);
            if (!measured.valid) return refuse('HEIGHT_MEASUREMENT', 'A height or object width is unreadable or outside the existing 5–1200 cm range. No row was omitted.');
            figures.push({ shape, name: (figure.name ?? '').trim(), cm: measured.height.cm, widthCm: measured.width.cm,
              label: format(measured.height.cm, model.unit), colour: figure.color ?? '#2563eb' });
          }
          drawn = chartSvg(figures, { plotHeight: model.plot_height, unit: model.unit, background: model.background,
            ink: isDark(model.background) ? '#ffffff' : '#16191d', showRuler: model.show_ruler, showNames: model.show_names }, measure);
          encode = () => svgToPng(drawn.svg, drawn, plan.scale);
        }
        const width = drawn.width * plan.scale, height = drawn.height * plan.scale;
        if (![drawn.width, drawn.height, width, height].every(value => Number.isSafeInteger(value) && value > 0 && value <= maxSide)
            || width * height > maxPixels || new TextEncoder().encode(drawn.svg).length > maxSvgBytes) {
          return refuse('PREVIEW_DIMENSIONS', 'The preview exceeds 8192 pixels per side, 16 megapixels or 2 MiB of SVG markup.');
        }
        const parsed = new DOMParser().parseFromString(drawn.svg, 'image/svg+xml');
        const root = parsed.documentElement, allowed = new Set(['svg', 'g', 'rect', 'path', 'circle', 'text', 'clipPath', 'image']);
        if (parsed.querySelector('parsererror') || root.localName !== 'svg' || root.namespaceURI !== 'http://www.w3.org/2000/svg'
            || root.getAttribute('viewBox') !== `0 0 ${drawn.width} ${drawn.height}`) return refuse('VERIFICATION_FAILED', 'The preview did not form the expected SVG document.');
        for (const element of parsed.querySelectorAll('*')) {
          if (!allowed.has(element.localName) || element.namespaceURI !== root.namespaceURI) return refuse('VERIFICATION_FAILED', 'The preview contains unsupported active or foreign SVG elements.');
          for (const attribute of element.attributes) {
            if (/^on/i.test(attribute.name) || attribute.localName === 'style'
                || (attribute.localName === 'href' && !(element.localName === 'image' && photoUri !== null && attribute.value === photoUri))
                || (/url\s*\(/i.test(attribute.value) && !/^url\(#[a-z0-9_-]+\)$/i.test(attribute.value))) {
              return refuse('VERIFICATION_FAILED', 'The preview contains an unsupported reference or active SVG attribute.');
            }
          }
        }
        svgUrl = URL.createObjectURL(new Blob([drawn.svg], { type: 'image/svg+xml' }));
        const image = new Image(); image.width = drawn.width; image.height = drawn.height;
        await new Promise((resolve, reject) => {
          image.onload = resolve; image.onerror = () => reject(new Error('svg-decode')); image.src = svgUrl;
        });
        if (image.naturalWidth !== drawn.width || image.naturalHeight !== drawn.height) return refuse('VERIFICATION_FAILED', 'The preview SVG decoded at unexpected dimensions.');
        expectedCanvas = document.createElement('canvas'); expectedCanvas.width = width; expectedCanvas.height = height;
        // Match the source exporters' canvas backing choice. Forcing a CPU
        // canvas can rasterize SVG text differently from their default canvas.
        const expectedContext = expectedCanvas.getContext('2d');
        if (kind === 'profile') {
          expectedContext.fillStyle = '#ffffff'; expectedContext.fillRect(0, 0, width, height);
          expectedContext.imageSmoothingQuality = 'high';
        }
        expectedContext.drawImage(image, 0, 0, width, height);
        const expected = expectedContext.getImageData(0, 0, width, height).data;
        let visible = 0;
        for (let at = 3; at < expected.length; at += 4) if (expected[at]) visible++;
        if (!visible) return refuse('VERIFICATION_FAILED', 'The preview did not render any visible pixels.');
        let data;
        if (plan.format === 'svg') data = btoa(unescape(encodeURIComponent(drawn.svg)));
        else {
          const blob = await encode();
          if (blob.type !== 'image/png' || !blob.size || blob.size > maxBytes) return refuse('OUTPUT_SIZE', 'The preview PNG exceeds 32 MiB or has an unsupported format.');
          checked = await codecs.decode(blob);
          if (checked.width !== width || checked.height !== height) return refuse('VERIFICATION_FAILED', 'The preview PNG dimensions changed.');
          actualCanvas = document.createElement('canvas'); actualCanvas.width = width; actualCanvas.height = height;
          const actualContext = actualCanvas.getContext('2d'); actualContext.drawImage(checked.bitmap, 0, 0);
          const actual = actualContext.getImageData(0, 0, width, height).data;
          for (let at = 0; at < actual.length; at += 4) {
            if (actual[at + 3] !== expected[at + 3]) return refuse('VERIFICATION_FAILED', 'The preview PNG changed rendered transparency.');
            for (let channel = 0; channel < 3; channel++) if (Math.abs(actual[at + channel] * actual[at + 3] / 255 - expected[at + channel] * expected[at + 3] / 255) > 1) {
              return refuse('VERIFICATION_FAILED', 'The preview PNG changed visible rendered pixels.');
            }
          }
          data = await new Promise((resolve, reject) => {
            const reader = new FileReader(); reader.onload = () => resolve(reader.result.split(',')[1]);
            reader.onerror = () => reject(new Error('output-read')); reader.readAsDataURL(blob);
          });
        }
        return { data, width, height, item_count: kind === 'profile' ? 1 : model.figures.length,
          verification: { passive_svg: true, decoded: true, external_references: false,
            png_pixel_checks: plan.format === 'png' ? width * height : 0 } };
      } catch { return refuse('PREVIEW_RENDER_FAILED', 'The installed browser could not lay out, render or verify this local preview. Configuration contents are excluded from errors.'); }
      finally {
        codecs.release(checked?.bitmap); if (svgUrl) URL.revokeObjectURL(svgUrl);
        for (const canvas of [measureCanvas, expectedCanvas, actualCanvas]) if (canvas) canvas.width = canvas.height = 0;
      }
    }, { kind, model, plan, labels, hasPhoto: Boolean(photo), maxSide: MAX_PREVIEW_SIDE,
      maxPixels: MAX_PREVIEW_PIXELS, maxSvgBytes: MAX_PREVIEW_SVG_BYTES, maxBytes: MAX_PREVIEW_OUTPUT_BYTES });
  }, options);
  if (made.error) throw new AdapterError(made.error.code, made.error.message);
  const data = Buffer.from(made.data, 'base64'); delete made.data;
  if (!data.length || data.length > (plan.format === 'svg' ? MAX_PREVIEW_SVG_BYTES : MAX_PREVIEW_OUTPUT_BYTES)) {
    throw new AdapterError('OUTPUT_SIZE', 'The preview exceeds its output byte limit.');
  }
  if (plan.format === 'png') {
    const image = await supportedImage(data), size = rasterInputDimensions(image);
    if (image.kind !== 'png' || size?.width !== made.width || size?.height !== made.height) throw new AdapterError('VERIFICATION_FAILED', 'The PNG container did not match the verified preview.');
  }
  options.signal?.throwIfAborted(); await writeNew(output, data);
  return { ok: true, operation: kind === 'profile' ? 'preview-business-profile' : 'compare-heights', config_path: config.path,
    ...(photo ? { photo_path: photo.path } : {}), output_path: output, input_bytes: config.bytes + (photo?.data.length ?? 0),
    output_bytes: data.length, format: plan.format, scale: plan.scale, verified: true, ...made,
    warnings: kind === 'profile' ? ['This is an English mock-up of a business listing, with local system fonts. It does not fetch, publish or verify an actual listing.',
      'Opening status uses the chosen local wall time or this device’s current clock, with no holiday calendar or business time-zone conversion. Profile text remains in the saved picture.']
      : ['Heights and widths follow the website unit parser; figures and labels are rendered with local system fonts. Names and measurements remain in the saved picture.',
        'Charts use the four bundled people and a plain rectangle. People retain their artwork proportions while their displayed heights follow the supplied measurements.'] };
}

export const previewBusinessProfile = (args, options = {}) => exportPreview('profile', args, options);
export const compareHeights = (args, options = {}) => exportPreview('heights', args, options);
