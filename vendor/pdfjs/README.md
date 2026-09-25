# PDF.js 6.3.289

Mozilla's PDF.js (https://mozilla.github.io/pdf.js/), Apache License 2.0 (see LICENSE),
copied unmodified from the `pdfjs-dist` npm package: `legacy/build/pdf.min.mjs`,
`legacy/build/pdf.worker.min.mjs` (the legacy build, which runs on older Safari), `cmaps/`, `standard_fonts/`, `iccs/` and `wasm/`
(minus the QuickJS scripting engine, which the app doesn't use). The bundled
fonts and WebAssembly decoders carry their own licenses next to them.

Used only to draw PDF pages as images when a PDF is imported (js/pdfpages.js).
It runs entirely on the device and makes no network requests beyond loading
these files from this site.
