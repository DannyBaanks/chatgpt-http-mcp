# Contact sheet verification

User approved generating labelled 1920x1080 contact sheets rather than returning many independent images. Added video_contact_sheet to the shared media registration in the existing Codex ISyMCP. 4x4 default; optional 3x3/6x6. Fixed image dimensions, bounded JPEG, up to 60-second interval and existing single-worker snapshot/revocation/timeout protections.

RED: contact sheet module missing. GREEN: deterministic two-color video verifies actual decoded JPEG dimensions, sixteen chronological cells, red first half / blue second half and output size. Sampling tests cover bounds/count/end exclusion. Main MCP tool inventory includes the tool; actual client call generated a real Angel Engine sheet, visually inspected. Requested times labelled to milliseconds; metadata carries full sample time values and warns they are seeks, not exact PTS guarantees.

FFmpeg directly extracts/labels cells and a local RGB canvas composes them. One JPEG response plus small JSON map. Aspect ratio preserved with black padding; labels do not crop source content. The process runner gained bounded stdin support for raw canvas encoding. JPEG retries stronger compression only for output-size failures.

During work the user asked about script-based image text extraction. Answered OCR/Tesseract with official documentation; OCR is not implemented here, and text-heavy frames are not automatically discarded. OCR should operate before thumbnail reduction; visual-only classification remains unproven.

NOT_DEMONSTRATED: remote ChatGPT invocation of the new contact sheet tool. Prior source manifests refer to historical commits; new manifest records this source state. Original media and historical evidence preserved.
