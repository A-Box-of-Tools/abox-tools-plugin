# Permanent PDF redaction

`abox_pdf_redact` / `redact-pdf` takes absolute `input_path`, new `.pdf`
`output_path`, local JSON `regions_path`, and optional integer `dpi` (72–300,
default 144). The input and configuration remain unchanged.

Supply every displayed page in order, including pages with no masks:

```json
{"pages":[{"page":1,"width_pt":612,"height_pt":792,"regions":[{"x":20,"y":40,"width":100,"height":30}]}]}
```

Coordinates are points from the displayed page's top-left, after its CropBox,
rotation and UserUnit. Page dimensions must match the rendered view exactly.
Use real measurements selected by the user; these example coordinates are not
instructions to apply to an unknown file. At least one rectangle is required.
Every rectangle must be fully inside its page. Masks are solid black and extend
one raster pixel outward to cover raster boundaries.

All pages are rendered locally by bundled PDF.js, masked, and written into a
fresh PDF containing only lossless opaque RGB page images and fixed drawing
instructions. Searchable text, forms, annotations as objects, links, tags,
layers, attachments, signatures, metadata and prior PDF revisions are excluded.
Visible annotation appearances can be baked into the page image. Original
objects are never copied. Verification checks every stored RGB byte, every
masked pixel and the exact permitted new object structure.

This permanently removes the pixels inside the chosen regions from the new
file. It does not identify sensitive information or erase the original file.
Review every output page and ensure every intended item lies inside a mask.
Rasterization changes searchable/editable documents into pictures and can alter
fonts, color, transparency, annotations and fine detail. Content outside the
visible CropBox is discarded. It provides no guarantee that unselected content
is harmless.

Limits: 32 MiB PDF, 64 KiB configuration, 32 pages, 256 rectangles total,
8192 pixels per side, 8 MP per page, 64 MP combined rasters, 128 MiB output.
A supported installed local browser is required. Rendering and font/CMap assets
are bundled; there are no uploads, runtime downloads or external resource
requests. Invalid rendering, missing resources or rendering warnings fail
without writing an output.

The initial bounded input subset accepts unfiltered/Flate streams without
predictors, ordinary DeviceRGB/DeviceGray/DeviceCMYK images and checked JPEG
streams. Inline images, XFA, encrypted/repaired files, other image codecs,
unsupported expansion structures and external streams are refused. Some
otherwise readable PDFs require a less restricted renderer and will be refused.
Drawing admission also requires recognized instructions with complete operands,
balanced state/text groups and explicitly present scoped resources. Recovery
that skips a command or invents a missing font or image is refused.
