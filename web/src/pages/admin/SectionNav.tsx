import { useEffect, useState } from "react";

export type Section = { id: string; label: string };

// Jump links to each section of the page. Stays under the header while you
// scroll, highlights the section in view, and opens a collapsed section
// when you jump to it.
export default function SectionNav({ sections }: { sections: Section[] }) {
  const [active, setActive] = useState(sections[0]?.id);

  useEffect(() => {
    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries.filter((e) => e.isIntersecting);
        if (visible.length) setActive(visible[0].target.id);
      },
      // a section counts as "in view" once it reaches the top third of the screen
      { rootMargin: "-20% 0px -65% 0px" },
    );
    for (const s of sections) {
      const el = document.getElementById(s.id);
      if (el) observer.observe(el);
    }
    return () => observer.disconnect();
  }, [sections]);

  function jump(id: string) {
    const el = document.getElementById(id);
    if (!el) return;
    const collapsed = el.querySelector("details");
    if (collapsed) collapsed.open = true;
    el.scrollIntoView({ behavior: "smooth", block: "start" });
    setActive(id);
  }

  return (
    <nav className="section-nav" aria-label="Sections of this page">
      {sections.map((s) => (
        <button key={s.id} type="button" className={s.id === active ? "active" : ""}
                aria-current={s.id === active ? "true" : undefined} onClick={() => jump(s.id)}>
          {s.label}
        </button>
      ))}
    </nav>
  );
}
