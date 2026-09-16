interface Props {
  name: string;
  className?: string;
}

export default function Icon({ name, className }: Props) {
  return <span className={`codicon codicon-${name}${className ? ` ${className}` : ""}`} />;
}
