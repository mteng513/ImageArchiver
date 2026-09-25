# Archive

A private, installable web app for saving images. Everything is encrypted on the
device (AES-256-GCM) before it is stored, either in the browser's own storage or
in a private Backblaze B2 bucket the owner connects. No keys, images or metadata
are ever part of this repository or this site.

Static files only: no build step, no server. The one third-party library is
Mozilla's PDF.js (Apache 2.0), kept unmodified in `vendor/pdfjs/` and loaded only
when a PDF is imported, to draw its pages as images on the device.
