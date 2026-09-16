// Build-time alias target for bare `import ... from "react"` in bundled
// extensions (see ../../build.mjs) — inlined into each extension's own
// dist/client.js, but every export here is the exact function/object
// reference from the host's already-loaded React instance
// (window.__perchModules, set in client/src/main.tsx before any
// extension can activate). A second real copy of React would have its own
// internal hook dispatcher and break under the host's ReactDOM; re-exporting
// the host's own references instead means there's still only one React at
// runtime no matter how many separate bundles reference "react".
const R = window.__perchModules.react;
export const {
  Children,
  Component,
  Fragment,
  Profiler,
  PureComponent,
  StrictMode,
  Suspense,
  cloneElement,
  createContext,
  createElement,
  createFactory,
  createRef,
  forwardRef,
  isValidElement,
  lazy,
  memo,
  startTransition,
  useCallback,
  useContext,
  useDebugValue,
  useDeferredValue,
  useEffect,
  useId,
  useImperativeHandle,
  useInsertionEffect,
  useLayoutEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  useSyncExternalStore,
  useTransition,
  version,
} = R;
export default R;
