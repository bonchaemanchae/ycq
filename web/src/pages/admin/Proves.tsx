import type { ReactNode } from "react";

// A small tag on an admin card naming the database property it demonstrates,
// so a reader (or a marker) can tell at a glance what each part is evidence of.
export default function Proves({ children }: { children: ReactNode }) {
  return (
    <span className="proves" title="What this part shows about the database design">
      <span className="proves-label">Proves</span>{children}
    </span>
  );
}
