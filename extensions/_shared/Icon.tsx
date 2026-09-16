// Copied from client/src/components/Icon.tsx — see extensions/_shared's
// module comment on why this is a copy, not a shared runtime import.
interface Props {
  name: string;
  className?: string;
}

export default function Icon({ name, className }: Props) {
  return <span className={`codicon codicon-${name}${className ? ` ${className}` : ""}`} />;
}
