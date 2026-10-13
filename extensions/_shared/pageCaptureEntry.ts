// The screenshot library the page agent (pageAgent.js) uses, exposed as a
// global because the agent runs as a plain script inside the previewed page.
// Built into each consumer's dist/page-agent.js by extensions/build.mjs.
import * as htmlToImage from "html-to-image";

(window as unknown as { __perchHtmlToImage: typeof htmlToImage }).__perchHtmlToImage = htmlToImage;
