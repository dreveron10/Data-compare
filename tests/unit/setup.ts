// The settings workbook parser uses the browser's DOMParser; give Node one.
import { DOMParser } from "@xmldom/xmldom";
(globalThis as { DOMParser?: unknown }).DOMParser ??= DOMParser;
