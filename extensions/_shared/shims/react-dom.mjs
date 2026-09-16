// See react.mjs — same single-instance rationale, for react-dom's exports.
const RD = window.__perchModules["react-dom"];
export const { createPortal, flushSync, unstable_batchedUpdates, findDOMNode } = RD;
export default RD;
