import { useEffect, useState, type ReactNode } from "react";
import { api } from "../api";
import demand from "../caro1.jpg";
import offDuty from "../caro2.jpg";
import rank from "../caro3.jpg";
import "./auth.css";

// The photos on the left of the log-in and setup pages, one feature each.
// To add a photo, put it in src/ (about 1600 px wide or more, so it stays
// sharp full-height), import it above and give it its own slide.
const SLIDES = [
  {
    image: demand, focus: "38% 62%",
    kicker: "Analytical Dashboard",
    title: "See where New York needs taxis",
    text: "Pickups by zone and hour across all five boroughs, from millions of TLC trips",
  },
  {
    image: offDuty, focus: "40% 62%",
    kicker: "Shortages",
    title: "Find where taxis run short",
    text: "Spot the zones and hours where riders outnumber the cabs nearby",
  },
  {
    image: rank, focus: "30% 55%",
    kicker: "Allocation Planner",
    title: "Plan where to station your fleet",
    text: "Build a plan for any shift, adjust it zone by zone and keep every version",
  },
];
const SLIDE_MS = 6000;

type Health = { months_loaded: string[] };

const MONTH = (m: string) => new Date(`${m}-01T00:00:00`).toLocaleDateString("en-GB", { month: "short" });

// "Jan–Mar 2026" for the loaded months, as in the app's top bar.
function monthsLabel(months: string[]) {
  const first = months[0], last = months[months.length - 1];
  const year = last.slice(0, 4);
  return first === last ? `${MONTH(first)} ${year}` : `${MONTH(first)}–${MONTH(last)} ${year}`;
}

// The frame for the pages shown before anyone is logged in (log in, set up an
// account): a carousel of what the app does on the left, the form on the
// right. On a phone only the form shows, under the brand.
export default function AuthLayout({ children, signUpHint = false }: { children: ReactNode; signUpHint?: boolean }) {
  const [months, setMonths] = useState<string[] | null>(null);
  useEffect(() => {
    api<Health>("/health").then((h) => setMonths(h.months_loaded)).catch(() => setMonths(null));
  }, []);

  return (
    <div className="auth">
      <Carousel />
      <main className="auth-main">
        <Brand className="auth-brand-small" />
        <div className="auth-card">{children}</div>
        <div className="auth-meta">
          {months && months.length > 0 && (
            <span className="auth-data"><i aria-hidden="true" />NYC TLC trip data loaded for {monthsLabel(months)}</span>
          )}
          {signUpHint && <span>Need an account? Ask your administrator for an invitation</span>}
        </div>
      </main>
    </div>
  );
}

function Brand({ className = "" }: { className?: string }) {
  return (
    <div className={`auth-brand ${className}`}>
      <span className="auth-mark">YC</span>
      <div>
        <div className="auth-brand-name">Yellow Cab Query</div>
        <div className="auth-brand-sub">Fleet planning on NYC taxi data</div>
      </div>
    </div>
  );
}

// Photos that cross-fade every few seconds, each with its feature. The bar
// of the slide showing fills up, and the next slide comes when it is full,
// so pausing (pointer over the photos) holds both. A bar jumps to its slide.
function Carousel() {
  const [index, setIndex] = useState(0);
  const [paused, setPaused] = useState(false);
  const next = () => setIndex((i) => (i + 1) % SLIDES.length);

  return (
    <aside className="auth-aside" onMouseEnter={() => setPaused(true)} onMouseLeave={() => setPaused(false)}
           aria-roledescription="carousel" aria-label="What Yellow Cab Query does">
      {SLIDES.map((s, i) => (
        <div key={i} className={`slide ${i === index ? "on" : ""}`} aria-hidden={i !== index}>
          <img src={s.image} alt="" style={{ objectPosition: s.focus }} />
        </div>
      ))}
      <div className="auth-shade" aria-hidden="true" />

      <Brand className="auth-brand-large" />
      <div className="auth-story" aria-live="polite">
        {SLIDES.map((s, i) => (
          <div key={i} className={`story ${i === index ? "on" : ""}`} aria-hidden={i !== index}>
            <h2>{s.title}</h2>
            <p>{s.text}</p>
          </div>
        ))}
        <div className="story-bars" role="tablist" aria-label="Slides">
          {SLIDES.map((s, i) => (
            <button key={i} role="tab" aria-selected={i === index} aria-label={s.kicker}
                    className={`story-bar ${i === index ? "on" : ""} ${i < index ? "done" : ""} ${paused ? "paused" : ""}`}
                    onClick={() => setIndex(i)}>
              <span>{i === index && <i style={{ animationDuration: `${SLIDE_MS}ms` }} onAnimationEnd={next} />}</span>
            </button>
          ))}
        </div>
      </div>
      <div className="auth-checker" aria-hidden="true" />
    </aside>
  );
}

// A password box with a Show/Hide button.
export function PasswordInput({ id, value, onChange, autoComplete, autoFocus }: {
  id: string; value: string; onChange: (v: string) => void; autoComplete: string; autoFocus?: boolean;
}) {
  const [shown, setShown] = useState(false);
  return (
    <div className="password-box">
      <input id={id} type={shown ? "text" : "password"} required value={value} autoComplete={autoComplete}
             autoFocus={autoFocus} maxLength={1024} onChange={(e) => onChange(e.target.value)} />
      <button type="button" className="password-toggle" onClick={() => setShown(!shown)}
              aria-label={shown ? "Hide password" : "Show password"} aria-pressed={shown}>
        {shown ? "Hide" : "Show"}
      </button>
    </div>
  );
}
