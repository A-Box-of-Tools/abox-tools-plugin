import { deflateSync } from 'node:zlib';
import { PdfWriter } from '../../vendor/abox/shared/js/pdf-page-writer.js';

export async function redactionFixture({ pages = 3, imageFilter = 'FlateDecode', imageWidth = 32, imageHeight = 32, imageRaw = null,
  inline = false, xfa = false, functionSize = null, indirectFunctionType = false, extraOperators = '', fontDictionary = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>' } = {}) {
  const writer = new PdfWriter(), catalog = writer.reserve(), root = writer.reserve(), font = writer.reserve(), info = writer.reserve(), metadata = writer.reserve(),
    embedded = writer.reserve(), spec = writer.reserve(), attachment = writer.reserve(), appearance = writer.reserve(), annotation = writer.reserve(), image = writer.reserve(), kids = [];
  writer.object(font, fontDictionary);
  writer.object(info, '<< /Title (PRIVATE SOURCE TITLE) /Author (PRIVATE SOURCE AUTHOR) >>');
  writer.stream(metadata, ' /Type /Metadata /Subtype /XML', new TextEncoder().encode('<private>PRIVATE XML METADATA</private>'));
  writer.stream(embedded, ' /Type /EmbeddedFile', new TextEncoder().encode('PRIVATE EMBEDDED ORIGINAL FILE'));
  writer.object(spec, `<< /Type /Filespec /F (PRIVATE ATTACHMENT NAME) /EF << /F ${embedded} 0 R >> >>`);
  writer.object(attachment, `<< /Names [(PRIVATE ATTACHMENT NAME) ${spec} 0 R] >>`);
  writer.stream(appearance, ' /Type /XObject /Subtype /Form /BBox [0 0 10 10] /Resources << >>', new TextEncoder().encode('0 1 0 rg 0 0 10 10 re f\n'));
  writer.object(annotation, `<< /Type /Annot /Subtype /Square /Rect [85 5 95 15] /F 4 /AP << /N ${appearance} 0 R >> /Contents (PRIVATE ANNOTATION) >>`);
  const pixels = Buffer.alloc(imageWidth * imageHeight * 3);
  for (let y = 0; y < imageHeight; y++) for (let x = 0; x < imageWidth; x++) {
    const at = (y * imageWidth + x) * 3; pixels[at] = x < imageWidth / 2 ? 255 : 0; pixels[at + 2] = x < imageWidth / 2 ? 0 : 255;
  }
  const imageData = imageRaw ?? (imageFilter === 'FlateDecode' ? deflateSync(pixels) : pixels);
  writer.stream(image, ` /Type /XObject /Subtype /Image /Width ${imageWidth} /Height ${imageHeight} /ColorSpace /DeviceRGB /BitsPerComponent 8${imageFilter ? ` /Filter /${imageFilter}` : ''}`, imageData);
  if (functionSize !== null) {
    const fn = writer.reserve(); let type = '0';
    if (indirectFunctionType) { const reference = writer.reserve(); writer.object(reference, '0'); type = `${reference} 0 R`; }
    writer.stream(fn, ` /FunctionType ${type} /Domain [0 1] /Range [0 1] /Size [${functionSize}] /BitsPerSample 8`, Buffer.alloc(1));
  }
  for (let index = 0; index < pages; index++) {
    const content = writer.reserve(), page = writer.reserve(); kids.push(page);
    const operators = inline ? 'BI /W 1 /H 1 /BPC 8 /CS /RGB ID abc EI\n'
      : index === 1 ? 'q 100 0 0 80 0 0 cm /Photo Do Q\n'
        : '1 0 0 rg 0 0 50 80 re f\n0 0 1 rg 50 0 50 80 re f\n0 0 0 rg BT /F1 5 Tf 10 40 Td (PRIVATE TEXT SECRET) Tj ET\n';
    writer.stream(content, '', new TextEncoder().encode(operators + extraOperators));
    writer.object(page, `<< /Type /Page /Parent ${root} 0 R /MediaBox [0 0 100 80]${index === 2 ? ' /CropBox [10 20 90 70] /Rotate 90 /UserUnit 2' : ''}
      /Resources << /Font << /F1 ${font} 0 R >> /XObject << /Photo ${image} 0 R >> >> /Contents ${content} 0 R${index === 0 ? ` /Annots [${annotation} 0 R]` : ''} >>`);
  }
  writer.object(root, `<< /Type /Pages /Count ${pages} /Kids [${kids.map(page => `${page} 0 R`).join(' ')}] >>`);
  writer.object(catalog, `<< /Type /Catalog /Pages ${root} 0 R /Metadata ${metadata} 0 R /Names << /EmbeddedFiles ${attachment} 0 R >>${xfa ? ' /AcroForm << /XFA (PRIVATE XFA DATA) >>' : ''} >>`);
  return Buffer.from(await writer.finish({ root: catalog, info }).arrayBuffer());
}

export function redactionRegions(pages = 3) {
  return { pages: Array.from({ length: pages }, (_, index) => ({ page: index + 1,
    width_pt: index === 2 ? 100 : 100, height_pt: index === 2 ? 160 : 80,
    regions: index === 2 ? [{ x: 20, y: 20, width: 40, height: 40 }] : [{ x: 5, y: 28, width: 80, height: 20 }] })) };
}
