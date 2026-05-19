import { Link, useLocation } from "wouter";

const TABS: Array<{ href: string; label: string }> = [
  { href: "/", label: "TradFi Arb" },
  { href: "/bmex-funding", label: "BMEX Funding Arb" },
];

export default function TopNav() {
  const [location] = useLocation();

  return (
    <nav className="flex items-center gap-1 mb-6 border-b border-gray-800 -mx-1">
      {TABS.map((t) => {
        const active = t.href === "/" ? location === "/" : location.startsWith(t.href);
        return (
          <Link
            key={t.href}
            href={t.href}
            className={
              "px-4 py-2.5 text-sm font-medium border-b-2 transition-colors " +
              (active
                ? "text-gray-100 border-[#FF6D00]"
                : "text-gray-400 border-transparent hover:text-gray-200")
            }
          >
            {t.label}
          </Link>
        );
      })}
    </nav>
  );
}
