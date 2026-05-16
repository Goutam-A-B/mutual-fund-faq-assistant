// pdf-parse ships its real implementation at lib/pdf-parse.js; the package root
// (index.js) wraps it with debug code that reads a local test PDF when the
// module has no parent. 2-extract imports the lib path directly to dodge that.
// @types/pdf-parse only declares the package root, so re-export it for the
// deep path here.
declare module "pdf-parse/lib/pdf-parse.js" {
  import pdfParse from "pdf-parse";
  export default pdfParse;
}
