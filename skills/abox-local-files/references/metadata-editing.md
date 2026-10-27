# Edit EXIF through a local configuration

`abox_exif_edit` / `edit-exif`: `input_path`, `output_path`, `edits_path`.
Input/output containers are JPEG, PNG or WebP and must have the matching file
extension. Existing output files are refused. Values are read from a local
UTF-8 JSON file; they are not returned in tool summaries or error messages.
Keep private metadata in that file rather than pasting it into a tool request.

The JSON object has optional `set` and `remove` arrays with 1–64 distinct
group/tag instructions in total. At least one instruction is required.

```json
{"set":[{"group":"ifd0","tag":270,"type":2,"value":"Example description"}],"remove":[{"group":"ifd0","tag":315}]}
```

The example changes ImageDescription and removes Artist; it is not a recipe for
removing all identifying data. `group` is `ifd0`, `exif`, `gps`, `interop` or
`ifd1`; `tag` is an integer from 1 to 65535. Every set `value` is a string.
An existing tag's `type` can be omitted, or must equal its original type.
Creating a tag requires its TIFF `type` number (1–12). Use the tag's defined
type; the adapter does not infer the correct type from a tag name or guess GPS
coordinates. Duplicate instructions, unknown fields and structural IFD or
thumbnail-address changes are refused.

ASCII tags accept ASCII text. UserComment and Windows XP text tags support the
source engine's Unicode encoding. Opaque UNDEFINED values can be retained or
removed; only UserComment is editable as free text in that type. Numeric values
use the unchanged source encoder and can be rounded for rational or Float32
storage. Do not claim exact decimal preservation for those edits.

Limits: 32 MiB source, 64 KiB configuration, 65527-byte EXIF block, five standard
directories and 2048 tags. Each value is at most 4096 UTF-8 bytes; numeric lists
are bounded to 256 values. The adapter verifies reparsed raw metadata, retained
thumbnail, unchanged compressed picture payload and other container blocks.
It does not decode the source picture or prove visual validity.

Editing metadata is not anonymization. Other metadata and the embedded thumbnail
remain. Maker-note bytes are preserved unless explicitly removed, but rebuilding
EXIF can invalidate undocumented internal offsets. Editing orientation or other
interpretation tags can change how the unchanged image displays. To remove
supported metadata, use `abox_exif_remove` and check its explicit retention flags.
