// See react.mjs — same single-instance rationale, for the automatic JSX
// runtime's exports (esbuild's jsx:"automatic" targets this specifier).
const J = window.__perchModules["react/jsx-runtime"];
export const { jsx, jsxs, Fragment } = J;
export default J;
