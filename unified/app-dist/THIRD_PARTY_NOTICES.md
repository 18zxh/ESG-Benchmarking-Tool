# Third-party components

The unified UI reuses the Button composition pattern from [shadcn/ui](https://github.com/shadcn-ui/ui) under MIT, adapted to the existing project CSS. No shadcn methodology, product content or theme was copied.

Copyright (c) 2023 shadcn

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.

Runtime packages: React, Radix Slot, class-variance-authority, clsx, tailwind-merge, React JSON Schema Form with AJV, TanStack Table, Lucide and PDF.js. Exact versions and dependency integrity are pinned in package-lock.json. Installed package license and notice text is collected in THIRD_PARTY_LICENSES.txt, including PDF.js's Apache-2.0 notice and Lucide's ISC/MIT notices. PDF.js cmaps, fonts, wasm and LICENSE are copied alongside the built client so PDF rendering works without a CDN.

The Excel writer is reused unchanged from ../modules/exchange/site/xlsx.js. The three original applications and their source documents retain the provenance recorded in ../upstream.json. UI packages do not supply ESG methodology. All provider-specific methods remain separately versioned in the local registry.
