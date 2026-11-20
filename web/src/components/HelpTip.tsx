import { useEffect, useRef, useState, type ReactNode } from "react";
import "./help-tip.css";

export type HelpStep = { title: string; text: ReactNode };

type Props = {
  title: string;
  steps?: HelpStep[];            // numbered steps, each with a title
  points?: ReactNode[];          // or just a few short points
  tip?: ReactNode;    // one closing line, e.g. a shortcut
};

// A "?" beside a page title. Hovering, focusing or tapping it shows how to use
// the page in a few numbered steps; it hides again when the pointer or focus
// leaves, on Escape, or on a tap elsewhere.
export default function HelpTip({ title, steps = [], points = [], tip }: Props) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    const onDown = (e: MouseEvent) => {
      if (box.current && !box.current.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("mousedown", onDown);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("mousedown", onDown);
    };
  }, [open]);

  return (
    <span className="help-tip" ref={box}
          onMouseEnter={() => setOpen(true)} onMouseLeave={() => setOpen(false)}>
      <button type="button" className={`help-icon ${open ? "on" : ""}`} aria-label={`How to use: ${title}`}
              aria-expanded={open} onClick={() => setOpen(!open)}
              onFocus={() => setOpen(true)} onBlur={() => setOpen(false)}>
        ?
      </button>
      {open && (
        <span className="help-pop" role="tooltip">
          <span className="help-title">{title}</span>
          {points.length > 0 && (
            <ul className="help-points">
              {points.map((p, i) => <li key={i}>{p}</li>)}
            </ul>
          )}
          {steps.length > 0 && <ol className="help-steps">
            {steps.map((s, i) => (
              <li key={s.title}>
                <span className="help-num">{i + 1}</span>
                <span>
                  <span className="help-step-title">{s.title}</span>
                  <span className="help-step-text">{s.text}</span>
                </span>
              </li>
            ))}
          </ol>}
          {tip && <span className="help-foot">{tip}</span>}
        </span>
      )}
    </span>
  );
}
